use std::{
    error::Error,
    ffi::OsString,
    fmt,
    io::{self, BufRead, BufReader},
    path::{Path, PathBuf},
    process::{ChildStdout, ExitStatus},
    sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::Deserialize;

use crate::{
    manifest::supports_worker_schema_version,
    process::{ManagedProcess, spawn_with_piped_stdout},
};

const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Generic launch details for an external Worker process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerLaunchSpec {
    executable: PathBuf,
    arguments: Vec<OsString>,
}

impl WorkerLaunchSpec {
    /// Creates a Worker launch specification.
    pub fn new<I, S>(executable: impl Into<PathBuf>, arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Self {
            executable: executable.into(),
            arguments: arguments.into_iter().map(Into::into).collect(),
        }
    }

    /// Returns the Worker executable path.
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    /// Returns the operating system arguments passed to the Worker.
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
}

#[derive(Deserialize)]
struct RawWorkerEvent {
    event: String,
}

#[derive(Deserialize)]
struct RawWorkerReady {
    schema_version: u32,
    run_id: String,
    status_url: String,
    command_url: String,
    stop_url: String,
}

/// Validated Common Worker ready information.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerReady {
    schema_version: u32,
    run_id: String,
    status_url: String,
    command_url: String,
    stop_url: String,
}

impl WorkerReady {
    /// Returns the Common Worker schema version.
    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }

    /// Returns the Worker run identifier.
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// Returns the status endpoint string.
    pub fn status_url(&self) -> &str {
        &self.status_url
    }

    /// Returns the command endpoint string.
    pub fn command_url(&self) -> &str {
        &self.command_url
    }

    /// Returns the stop endpoint string.
    pub fn stop_url(&self) -> &str {
        &self.stop_url
    }
}

/// An active Worker process with validated ready information.
pub struct WorkerSession {
    process: Option<ManagedProcess>,
    ready: WorkerReady,
    stdout_reader: Option<JoinHandle<io::Result<()>>>,
}

impl WorkerSession {
    /// Returns the operating system process identifier.
    pub fn process_id(&self) -> u32 {
        self.process
            .as_ref()
            .expect("WorkerSession process must exist")
            .id()
    }

    /// Returns the validated ready information.
    pub fn ready(&self) -> &WorkerReady {
        &self.ready
    }
}

impl Drop for WorkerSession {
    fn drop(&mut self) {
        drop(self.process.take());
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
    }
}

/// Errors produced while starting a Worker process.
#[derive(Debug)]
pub enum WorkerStartError {
    Spawn(io::Error),
    ProcessIo(io::Error),
    Reader(io::Error),
    StartupTimeout(Duration),
    ExitedBeforeReady(ExitStatus),
    InvalidReady(serde_json::Error),
    UnsupportedSchemaVersion(u32),
}

impl fmt::Display for WorkerStartError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) => write!(formatter, "failed to spawn Worker: {error}"),
            Self::ProcessIo(error) => write!(formatter, "Worker process I/O error: {error}"),
            Self::Reader(error) => write!(formatter, "Worker stdout reader error: {error}"),
            Self::StartupTimeout(timeout) => {
                write!(formatter, "Worker startup timed out after {timeout:?}")
            }
            Self::ExitedBeforeReady(status) => {
                write!(formatter, "Worker exited before ready with {status}")
            }
            Self::InvalidReady(error) => write!(formatter, "invalid Worker ready payload: {error}"),
            Self::UnsupportedSchemaVersion(version) => {
                write!(formatter, "unsupported Worker schema version {version}")
            }
        }
    }
}

impl Error for WorkerStartError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Spawn(source) | Self::ProcessIo(source) | Self::Reader(source) => Some(source),
            Self::InvalidReady(source) => Some(source),
            Self::StartupTimeout(_)
            | Self::ExitedBeforeReady(_)
            | Self::UnsupportedSchemaVersion(_) => None,
        }
    }
}

enum StdoutMessage {
    Line(Vec<u8>),
    Eof,
    Error(io::Error),
}

fn read_and_drain_stdout(
    stdout: ChildStdout,
    sender: mpsc::Sender<StdoutMessage>,
) -> io::Result<()> {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();

    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => {
                let _ = sender.send(StdoutMessage::Eof);
                return Ok(());
            }
            Ok(_) => {
                if sender
                    .send(StdoutMessage::Line(std::mem::take(&mut line)))
                    .is_err()
                {
                    break;
                }
            }
            Err(error) => {
                let _ = sender.send(StdoutMessage::Error(error));
                return Ok(());
            }
        }
    }

    io::copy(&mut reader, &mut io::sink())?;
    Ok(())
}

fn parse_ready(line: &[u8]) -> Result<Option<WorkerReady>, WorkerStartError> {
    if line.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(None);
    }

    let event: RawWorkerEvent =
        serde_json::from_slice(line).map_err(WorkerStartError::InvalidReady)?;
    if event.event != "ready" {
        return Ok(None);
    }

    let raw: RawWorkerReady =
        serde_json::from_slice(line).map_err(WorkerStartError::InvalidReady)?;

    if !supports_worker_schema_version(raw.schema_version) {
        return Err(WorkerStartError::UnsupportedSchemaVersion(
            raw.schema_version,
        ));
    }

    Ok(Some(WorkerReady {
        schema_version: raw.schema_version,
        run_id: raw.run_id,
        status_url: raw.status_url,
        command_url: raw.command_url,
        stop_url: raw.stop_url,
    }))
}

fn disconnected_reader_error() -> WorkerStartError {
    WorkerStartError::Reader(io::Error::other(
        "Worker stdout reader stopped before reporting ready",
    ))
}

fn wait_for_ready(
    process: &mut ManagedProcess,
    receiver: &Receiver<StdoutMessage>,
    startup_timeout: Duration,
) -> Result<WorkerReady, WorkerStartError> {
    let deadline = Instant::now() + startup_timeout;
    let mut stdout_closed = false;

    loop {
        if !stdout_closed {
            match receiver.try_recv() {
                Ok(StdoutMessage::Line(line)) => {
                    if let Some(ready) = parse_ready(&line)? {
                        return Ok(ready);
                    }
                }
                Ok(StdoutMessage::Error(error)) => {
                    return Err(WorkerStartError::Reader(error));
                }
                Ok(StdoutMessage::Eof) => stdout_closed = true,
                Err(TryRecvError::Disconnected) => return Err(disconnected_reader_error()),
                Err(TryRecvError::Empty) => {}
            }
        }

        if let Some(status) = process.try_wait().map_err(WorkerStartError::ProcessIo)? {
            if !stdout_closed {
                match receiver.recv_timeout(STARTUP_POLL_INTERVAL) {
                    Ok(StdoutMessage::Line(line)) => {
                        if let Some(ready) = parse_ready(&line)? {
                            return Ok(ready);
                        }
                        continue;
                    }
                    Ok(StdoutMessage::Error(error)) => {
                        return Err(WorkerStartError::Reader(error));
                    }
                    Ok(StdoutMessage::Eof)
                    | Err(RecvTimeoutError::Timeout)
                    | Err(RecvTimeoutError::Disconnected) => {}
                }
            }
            return Err(WorkerStartError::ExitedBeforeReady(status));
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(WorkerStartError::StartupTimeout(startup_timeout));
        }

        let wait = STARTUP_POLL_INTERVAL.min(deadline.saturating_duration_since(now));
        if stdout_closed {
            thread::sleep(wait);
            continue;
        }

        match receiver.recv_timeout(wait) {
            Ok(StdoutMessage::Line(line)) => {
                if let Some(ready) = parse_ready(&line)? {
                    return Ok(ready);
                }
            }
            Ok(StdoutMessage::Error(error)) => return Err(WorkerStartError::Reader(error)),
            Ok(StdoutMessage::Eof) => stdout_closed = true,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err(disconnected_reader_error()),
        }
    }
}

/// Starts a Worker and waits for a valid Common Worker ready event.
pub fn start_worker(
    spec: &WorkerLaunchSpec,
    startup_timeout: Duration,
) -> Result<WorkerSession, WorkerStartError> {
    let (mut process, stdout) = spawn_with_piped_stdout(spec.executable(), spec.arguments())
        .map_err(WorkerStartError::Spawn)?;
    let (sender, receiver) = mpsc::channel();
    let stdout_reader = thread::Builder::new()
        .name("worker-stdout-reader".to_owned())
        .spawn(move || read_and_drain_stdout(stdout, sender))
        .map_err(WorkerStartError::Reader)?;

    let ready = match wait_for_ready(&mut process, &receiver, startup_timeout) {
        Ok(ready) => ready,
        Err(error) => {
            drop(process);
            let _ = stdout_reader.join();
            return Err(error);
        }
    };
    drop(receiver);

    Ok(WorkerSession {
        process: Some(process),
        ready,
        stdout_reader: Some(stdout_reader),
    })
}
