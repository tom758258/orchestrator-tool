use std::{
    collections::VecDeque,
    error::Error,
    ffi::OsString,
    fmt,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{ChildStderr, ChildStdout, ExitStatus},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, RecvTimeoutError, TryRecvError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    common_job::{JobObservation, JobTracker},
    common_v3::{self, LocalOrigin},
    manifest::{ToolManifest, supports_worker_schema_version},
    process::{ManagedProcess, spawn_with_piped_stdio},
    worker_http::{WorkerClient, WorkerHttpError},
};

const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(10);
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Generic launch details for an external Worker process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerLaunchSpec {
    executable: PathBuf,
    arguments: Vec<OsString>,
    manifest: Option<ToolManifest>,
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
            manifest: None,
        }
    }

    /// Bind the validated Manifest from the selected executable to this launch.
    pub fn with_manifest(mut self, manifest: ToolManifest) -> Self {
        self.manifest = Some(manifest);
        self
    }

    pub fn manifest(&self) -> Option<&ToolManifest> {
        self.manifest.as_ref()
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
    #[serde(default)]
    cancel_url: Option<String>,
    features: Value,
    #[serde(default)]
    stream: Option<Value>,
}

/// Validated Common Worker ready information.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerReady {
    schema_version: u32,
    run_id: String,
    status_url: String,
    command_url: String,
    stop_url: String,
    cancel_url: Option<String>,
    features: Value,
    stream: Option<Value>,
    origin: LocalOrigin,
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

    pub fn cancel_url(&self) -> Option<&str> {
        self.cancel_url.as_deref()
    }

    pub fn features(&self) -> &Value {
        &self.features
    }
    pub fn origin(&self) -> &LocalOrigin {
        &self.origin
    }
    pub fn stream(&self) -> Option<&Value> {
        self.stream.as_ref()
    }
}

/// An active Worker process with validated ready information.
pub struct WorkerSession {
    process: Option<ManagedProcess>,
    ready: WorkerReady,
    stdout_reader: Option<JoinHandle<io::Result<()>>>,
    stderr_reader: Option<JoinHandle<()>>,
    event_receiver: Option<Receiver<StdoutMessage>>,
    pending_events: Mutex<VecDeque<Value>>,
    manifest: Option<ToolManifest>,
    jobs: Mutex<JobTracker>,
    evidence: Mutex<RunEvidence>,
    // JSONL transitions only; HTTP Status can be a stale snapshot.
    stream_state: Mutex<Option<String>>,
}

/// Worker-level shutdown evidence; not a persistent run-history database.
#[derive(Debug, Default)]
struct RunEvidence {
    summary: Option<Value>,
    fatal: Vec<String>,
    protocol_errors: Vec<String>,
    eof: bool,
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

    pub fn job_tracker(&self) -> &Mutex<JobTracker> {
        &self.jobs
    }

    fn mark_job_unconfirmed(&self, job_id: &str, reason: &str) -> Result<(), String> {
        self.jobs
            .lock()
            .map_err(|_| "poisoned Job Tracker")?
            .mark_unconfirmed(job_id, reason)
    }

    /// One shared async path for Powers, Scopes, and future conforming v3 Tools.
    /// Domain commands and their results stay with their thin adapter.
    pub fn run_async_job(
        &self,
        command: &str,
        arguments: &Value,
        context: Option<Value>,
        job_id: &str,
        timeout: Duration,
    ) -> Result<Value, String> {
        if self.ready.features().get("common.async_jobs").is_none() {
            return Err("Worker did not adopt common.async_jobs".into());
        }
        if let Some(manifest) = self.manifest.as_ref() {
            if let Some(kind) = manifest.command_kind(command)
                && kind != "async_job"
            {
                return Err(format!("Manifest command {command} is not an Async Job"));
            }
            if manifest.context_binding() == Some("startup") && context.is_some() {
                return Err("startup-bound Worker forbids per-command context".into());
            }
            if manifest.context_binding() == Some("per_command") && context.is_none() {
                return Err("per-command Worker requires context".into());
            }
        }
        let deadline = Instant::now() + timeout;
        self.jobs
            .lock()
            .map_err(|_| "poisoned Job Tracker")?
            .register(job_id, command)?;
        let client = WorkerClient::new(&self.ready);
        let mut request = json!({"schema_version":3,"command":command,
            "arguments":arguments,"job_id":job_id});
        if let Some(context) = context {
            request["context"] = context;
        }
        let mut lost_response: Option<String> = None;
        // Keep part of the operation deadline available for observing a
        // terminal if the HTTP acceptance response is lost. Never resend.
        let admission_timeout = timeout.min(Duration::from_secs(3));
        match client.command_with_rejection_timeout(&request, admission_timeout) {
            Ok((code, reply)) => {
                if code != 202 {
                    let reason = common_v3::command_rejected(
                        &reply,
                        code,
                        self.ready.run_id(),
                        command,
                        job_id,
                    )?;
                    return Err(format!("Worker async command HTTP {code}: {reason}"));
                }
                let worker_id = common_v3::command_accepted(
                    &reply,
                    code,
                    self.ready.run_id(),
                    command,
                    job_id,
                    "async_job",
                )?
                .ok_or("accepted Async Job missing worker_job_id")?;
                if self
                    .jobs
                    .lock()
                    .map_err(|_| "poisoned Job Tracker")?
                    .accepted(job_id, command, &worker_id)?
                    == JobObservation::Conflict
                {
                    return Err("conflicting async HTTP Accepted identity".into());
                }
            }
            Err(error) => lost_response = Some(error.to_string()),
        }
        loop {
            // Check both terminal and conflicts under a *single* short-lived
            // lock. A temporary MutexGuard in an if-let scrutinee survives
            // into its body and a second lock here deadlocks on a completed Job.
            let (confirmed, conflicts) = {
                let tracker = self.jobs.lock().map_err(|_| "poisoned Job Tracker")?;
                (
                    tracker.job(job_id).and_then(|j| j.terminal().cloned()),
                    tracker.has_conflicts(),
                )
            };
            if conflicts {
                return Err("Worker terminal identity or semantics conflict".into());
            }
            if let Some(terminal) = confirmed {
                return Ok(terminal.original);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.mark_job_unconfirmed(job_id, "job timed out without valid terminal")?;
                return Err(format!(
                    "unconfirmed Job {job_id}: {}",
                    lost_response.unwrap_or_else(|| "no terminal".into())
                ));
            }
            match self.recv_event(remaining.min(Duration::from_millis(30))) {
                Ok(event) if event["event"] == "job_finished" => {
                    if self
                        .jobs
                        .lock()
                        .map_err(|_| "poisoned Job Tracker")?
                        .event(&event)?
                        == JobObservation::Conflict
                    {
                        return Err("conflicting Job terminal".into());
                    }
                }
                Ok(event) if event["event"] == "summary" => {
                    self.mark_job_unconfirmed(job_id, "Worker summary before job terminal")?;
                    return Err(format!("Worker summary before Job {job_id} completion"));
                }
                Ok(event) if event["event"] == "error" && event["fatal"] == true => {
                    self.mark_job_unconfirmed(job_id, "fatal Worker error before job terminal")?;
                    return Err(format!(
                        "fatal Worker error during Job {job_id}: {}",
                        event["error"]
                    ));
                }
                Ok(event)
                    if event["event"] == "status"
                        && (event["worker_state"] == "failed"
                            || !event["fatal_error"].is_null()) =>
                {
                    self.mark_job_unconfirmed(job_id, "Worker failed before job terminal")?;
                    return Err(format!("Worker failed during Job {job_id}: {event}"));
                }
                Ok(_) | Err(WorkerEventError::Timeout(_)) => {}
                Err(e) => {
                    self.mark_job_unconfirmed(job_id, "Worker event channel ended")?;
                    return Err(format!("unconfirmed Job {job_id}: {e}"));
                }
            }
            // A full terminal snapshot is sufficient when JSONL was missed.
            match client.status_with_timeout(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(300)),
            ) {
                Ok(status) => {
                    common_v3::status(
                        &status,
                        self.ready.run_id(),
                        self.ready.origin(),
                        self.manifest.as_ref(),
                        self.ready.features(),
                        false,
                    )?;
                    if self.ready.features().get("common.async_jobs").is_some()
                        && self
                            .jobs
                            .lock()
                            .map_err(|_| "poisoned Job Tracker")?
                            .snapshot(&status)?
                            == JobObservation::Conflict
                    {
                        return Err("conflicting Job HTTP snapshot".into());
                    }
                    if status["worker_state"] == "failed" || !status["fatal_error"].is_null() {
                        self.mark_job_unconfirmed(
                            job_id,
                            "Worker HTTP failure before job terminal",
                        )?;
                        return Err(format!(
                            "Worker failed while waiting for Job {job_id}: {status}"
                        ));
                    }
                }
                // Transport loss is not proof the Job was never executed.
                Err(crate::worker_http::WorkerHttpError::Request(_)) => {}
                Err(error) => {
                    self.mark_job_unconfirmed(job_id, "invalid Worker Job status")?;
                    return Err(format!("invalid Worker Job status: {error}"));
                }
            }
        }
    }

    fn record_event(&self, event: &Value) -> Result<(), String> {
        common_v3::event_envelope(event, self.ready.run_id())?;
        if event["event"] == "status" {
            common_v3::async_status_snapshots(event, self.ready.features())?;
        }
        if event["event"] == "job_finished"
            && self
                .jobs
                .lock()
                .map_err(|_| "poisoned Job Tracker")?
                .event(event)?
                == JobObservation::Conflict
        {
            self.evidence
                .lock()
                .map_err(|_| "poisoned run evidence")?
                .protocol_errors
                .push("conflicting async Job terminal".into());
            return Err("conflicting async Job terminal".into());
        }
        let mut evidence = self.evidence.lock().map_err(|_| "poisoned run evidence")?;
        if event["event"] == "summary" {
            if evidence.summary.is_some() {
                evidence
                    .protocol_errors
                    .push("duplicate Worker summary".into());
            } else {
                evidence.summary = Some(event.clone());
            }
        }
        if event["event"] == "error" && event["fatal"] == true {
            evidence.fatal.push(event.to_string());
        }
        drop(evidence);
        if event["event"] == "status"
            && self.ready.features().get("common.streaming").is_none()
            && event.get("stream").is_some_and(|value| !value.is_null())
        {
            return Err("JSONL stream status without runtime feature adoption".into());
        }
        if event["event"] == "status" && self.ready.features().get("common.streaming").is_some() {
            let stream = &event["stream"];
            if stream["lifecycle"] != self.ready.features()["common.streaming"]["lifecycles"][0] {
                return Err("JSONL stream lifecycle differs from Ready adoption".into());
            }
            let current = common_v3::required_string(stream, "state")?;
            if !matches!(current, "waiting" | "active" | "ended") {
                return Err("invalid JSONL stream.state".into());
            }
            let mut previous = self
                .stream_state
                .lock()
                .map_err(|_| "poisoned Stream state")?;
            common_v3::stream_transition(previous.as_deref(), current)?;
            *previous = Some(current.to_owned());
        }
        Ok(())
    }

    /// Observe the Worker channel during source readiness without discarding
    /// samples or domain events needed by the existing Meters adapter.
    fn observe_stream_wait_events(&self) -> Result<(), String> {
        for _ in 0..64 {
            match self.recv_worker_event(Duration::from_millis(1)) {
                Ok(event) => {
                    if event["event"] == "summary"
                        || (event["event"] == "error" && event["scope"] == "worker")
                        || (event["event"] == "status"
                            && (event["worker_state"] == "failed"
                                || event["worker_state"] == "stopping"
                                || !event["fatal_error"].is_null()
                                || event["stream"]["state"] == "ended"))
                    {
                        return Err(format!(
                            "Worker source ended or failed before active: {event}"
                        ));
                    }
                    self.pending_events
                        .lock()
                        .map_err(|_| "poisoned pending Worker events")?
                        .push_back(event);
                }
                Err(WorkerEventError::Timeout(_)) => break,
                Err(error) => return Err(format!("Worker source readiness: {error}")),
            }
        }
        Ok(())
    }

    /// Only called for a runtime that explicitly adopted streaming.
    /// Read-only status polling never starts acquisition or instrument I/O.
    pub fn wait_for_stream_active(&self, timeout: Duration) -> Result<(), String> {
        if self.ready.features().get("common.streaming").is_none() {
            return Ok(());
        }
        let client = WorkerClient::new(&self.ready);
        let deadline = Instant::now() + timeout;
        loop {
            self.observe_stream_wait_events()?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("stream source readiness timed out".into());
            }
            let status = client
                .status_with_timeout(remaining.min(Duration::from_millis(300)))
                .map_err(|error| error.to_string())?;
            let ready = common_v3::stream_source_ready(&status)?;
            // JSONL transitions have a defined order, but HTTP snapshots may
            // be stale. Never regress an active JSONL state to HTTP waiting.
            self.observe_stream_wait_events()?;
            let jsonl_active = {
                let last = self
                    .stream_state
                    .lock()
                    .map_err(|_| "poisoned stream state")?;
                match last.as_deref() {
                    Some("ended") => return Err("stream ended before source readiness".into()),
                    Some("active") => true,
                    _ => false,
                }
            };
            if ready || (jsonl_active && status["worker_state"] == "running") {
                return Ok(());
            }
            thread::sleep(
                Duration::from_millis(30).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }

    /// Receives the next runtime JSON event from the Worker with a bounded timeout.
    ///
    /// The startup `ready` event is consumed during `start_worker` and is not
    /// returned by this method. Events are generic `serde_json::Value` objects.
    pub fn recv_event(&self, timeout: Duration) -> Result<serde_json::Value, WorkerEventError> {
        if let Some(event) = self
            .pending_events
            .lock()
            .map_err(|_| WorkerEventError::Protocol("poisoned pending Worker events".into()))?
            .pop_front()
        {
            return Ok(event);
        }
        self.recv_worker_event(timeout)
    }

    fn recv_worker_event(&self, timeout: Duration) -> Result<Value, WorkerEventError> {
        let Some(receiver) = self.event_receiver.as_ref() else {
            return Err(WorkerEventError::Disconnected);
        };

        let deadline = Instant::now() + timeout;

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(WorkerEventError::Timeout(timeout));
            }

            match receiver.recv_timeout(remaining) {
                Ok(StdoutMessage::Line(line)) => {
                    if line.iter().all(|byte| byte.is_ascii_whitespace()) {
                        continue;
                    }
                    match serde_json::from_slice::<serde_json::Value>(&line) {
                        Ok(value) => {
                            self.record_event(&value)
                                .map_err(WorkerEventError::Protocol)?;
                            return Ok(value);
                        }
                        Err(error) => return Err(WorkerEventError::InvalidJson(error)),
                    }
                }
                Ok(StdoutMessage::Eof) => {
                    self.evidence.lock().unwrap_or_else(|e| e.into_inner()).eof = true;
                    return Err(WorkerEventError::Disconnected);
                }
                Ok(StdoutMessage::Error(error)) => return Err(WorkerEventError::Io(error)),
                Err(RecvTimeoutError::Timeout) => return Err(WorkerEventError::Timeout(timeout)),
                Err(RecvTimeoutError::Disconnected) => return Err(WorkerEventError::Disconnected),
            }
        }
    }

    /// Requests a graceful stop and waits within the caller-provided timeout.
    pub fn shutdown(mut self, timeout: Duration) -> Result<ExitStatus, WorkerShutdownError> {
        if let Some(status) = self
            .process_mut()
            .try_wait()
            .map_err(WorkerShutdownError::ProcessIo)?
        {
            return self.finish_exited_process(status, timeout);
        }

        let deadline = Instant::now() + timeout;
        let now = Instant::now();

        if now >= deadline {
            self.force_cleanup()?;
            return Err(WorkerShutdownError::GracefulTimeout(timeout));
        }

        let client = WorkerClient::new(&self.ready);
        if let Err(error) = client.stop_with_timeout(deadline.saturating_duration_since(now)) {
            loop {
                if let Some(status) = self
                    .process_mut()
                    .try_wait()
                    .map_err(WorkerShutdownError::ProcessIo)?
                {
                    return self.finish_exited_process(status, timeout);
                }

                let now = Instant::now();
                if now >= deadline {
                    self.force_cleanup()?;
                    return Err(WorkerShutdownError::Stop(error));
                }

                thread::sleep(SHUTDOWN_POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
            }
        }

        loop {
            if let Some(status) = self
                .process_mut()
                .try_wait()
                .map_err(WorkerShutdownError::ProcessIo)?
            {
                return self.finish_exited_process(status, timeout);
            }

            let now = Instant::now();
            if now >= deadline {
                self.force_cleanup()?;
                return Err(WorkerShutdownError::GracefulTimeout(timeout));
            }

            thread::sleep(SHUTDOWN_POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
        }
    }

    fn process_mut(&mut self) -> &mut ManagedProcess {
        self.process
            .as_mut()
            .expect("WorkerSession process must exist")
    }

    fn finish_exited_process(
        &mut self,
        status: ExitStatus,
        timeout: Duration,
    ) -> Result<ExitStatus, WorkerShutdownError> {
        self.process.take();
        // Process exit and stdout EOF are separate observations. Consume all
        // events already queued by the stdout reader before classifying exit.
        let deadline = Instant::now() + timeout;
        while !self.evidence.lock().unwrap_or_else(|e| e.into_inner()).eof {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match self.recv_event(remaining.min(Duration::from_millis(100))) {
                Ok(_) | Err(WorkerEventError::Timeout(_)) => {}
                Err(WorkerEventError::Disconnected) => break,
                Err(error) => {
                    self.evidence
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .protocol_errors
                        .push(error.to_string());
                }
            }
        }
        drop(self.event_receiver.take());
        self.join_stdout_reader()?;
        self.join_stderr_reader();

        // A non-zero actual process exit is independently conclusive failure.
        // Return the real exit status so callers preserve its numeric evidence;
        // summary validation below is required before declaring exit 0 successful.
        if !status.success() {
            return Ok(status);
        }
        let evidence = self.evidence.lock().unwrap_or_else(|e| e.into_inner());
        if !evidence.eof {
            return Err(WorkerShutdownError::Contract(
                "stdout EOF not confirmed".into(),
            ));
        }
        if !evidence.protocol_errors.is_empty() {
            return Err(WorkerShutdownError::Contract(format!(
                "Worker protocol errors: {}",
                evidence.protocol_errors.join("; ")
            )));
        }
        if self
            .jobs
            .lock()
            .map_err(|_| WorkerShutdownError::Contract("poisoned Job Tracker".into()))?
            .has_conflicts()
        {
            return Err(WorkerShutdownError::Contract(
                "async Job terminal conflict survived until shutdown".into(),
            ));
        }
        if !evidence.fatal.is_empty() {
            return Err(WorkerShutdownError::Contract(format!(
                "Worker fatal errors: {}",
                evidence.fatal.join("; ")
            )));
        }
        let summary = evidence
            .summary
            .as_ref()
            .ok_or_else(|| WorkerShutdownError::Contract("Worker summary missing".into()))?;
        if summary["ok"] != true || !summary["fatal_error"].is_null() {
            return Err(WorkerShutdownError::Contract(format!(
                "Worker summary reported failure: {summary}"
            )));
        }
        // Actual exit code is still returned to the caller for independent
        // checking; a successful summary never overrides non-zero exit.
        Ok(status)
    }

    fn force_cleanup(&mut self) -> Result<(), WorkerShutdownError> {
        let process = self.process_mut();
        match process.try_wait().map_err(WorkerShutdownError::ProcessIo)? {
            Some(_) => {}
            None => {
                if let Err(kill_error) = process.kill() {
                    if process
                        .try_wait()
                        .map_err(WorkerShutdownError::ProcessIo)?
                        .is_none()
                    {
                        return Err(WorkerShutdownError::ProcessIo(kill_error));
                    }
                } else {
                    process.wait().map_err(WorkerShutdownError::ProcessIo)?;
                }
            }
        }

        self.process.take();
        // Worker termination closes stdout; dropping the event receiver allows the
        // reader thread to switch to its existing drain path before joining.
        drop(self.event_receiver.take());
        let result = self.join_stdout_reader();
        self.join_stderr_reader();
        result
    }

    fn join_stdout_reader(&mut self) -> Result<(), WorkerShutdownError> {
        let Some(reader) = self.stdout_reader.take() else {
            return Ok(());
        };

        match reader.join() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(WorkerShutdownError::Reader(error)),
            Err(_) => Err(WorkerShutdownError::Reader(io::Error::other(
                "Worker stdout reader thread panicked",
            ))),
        }
    }

    fn join_stderr_reader(&mut self) {
        // Stderr is best-effort diagnostics: a drain failure must not fail shutdown.
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for WorkerSession {
    fn drop(&mut self) {
        drop(self.process.take());
        drop(self.event_receiver.take());
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr_reader.take() {
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
    ExitedBeforeReady {
        status: ExitStatus,
        diagnostic: Option<String>,
    },
    InvalidReady(serde_json::Error),
    InvalidContract(String),
    UnsupportedSchemaVersion(u32),
}

impl fmt::Display for WorkerStartError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) => write!(formatter, "failed to spawn Worker: {error}"),
            Self::ProcessIo(error) => write!(formatter, "Worker process I/O error: {error}"),
            Self::Reader(error) => write!(formatter, "Worker stream reader error: {error}"),
            Self::StartupTimeout(timeout) => {
                write!(formatter, "Worker startup timed out after {timeout:?}")
            }
            Self::ExitedBeforeReady { status, diagnostic } => match diagnostic {
                Some(diagnostic) => write!(
                    formatter,
                    "Worker exited before ready with {status}: {diagnostic}"
                ),
                None => write!(formatter, "Worker exited before ready with {status}"),
            },
            Self::InvalidReady(error) => write!(formatter, "invalid Worker ready payload: {error}"),
            Self::InvalidContract(message) => {
                write!(formatter, "invalid Worker v3 ready: {message}")
            }
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
            | Self::ExitedBeforeReady { .. }
            | Self::UnsupportedSchemaVersion(_)
            | Self::InvalidContract(_) => None,
        }
    }
}

/// Errors produced while shutting down a Worker session.
#[derive(Debug)]
pub enum WorkerShutdownError {
    Stop(WorkerHttpError),
    GracefulTimeout(Duration),
    ProcessIo(io::Error),
    Reader(io::Error),
    Contract(String),
}

impl fmt::Display for WorkerShutdownError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stop(error) => write!(formatter, "failed to stop Worker: {error}"),
            Self::GracefulTimeout(timeout) => {
                write!(formatter, "Worker did not stop within {timeout:?}")
            }
            Self::ProcessIo(error) => write!(formatter, "Worker process I/O error: {error}"),
            Self::Reader(error) => write!(formatter, "Worker stdout reader error: {error}"),
            Self::Contract(message) => write!(formatter, "Worker v3 shutdown: {message}"),
        }
    }
}

impl Error for WorkerShutdownError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Stop(source) => Some(source),
            Self::ProcessIo(source) | Self::Reader(source) => Some(source),
            Self::GracefulTimeout(_) | Self::Contract(_) => None,
        }
    }
}

/// Errors produced while receiving a runtime Worker event.
#[derive(Debug)]
pub enum WorkerEventError {
    Timeout(Duration),
    Disconnected,
    Io(io::Error),
    InvalidJson(serde_json::Error),
    Protocol(String),
}

impl fmt::Display for WorkerEventError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout(timeout) => {
                write!(
                    formatter,
                    "Worker event receive timed out after {timeout:?}"
                )
            }
            Self::Disconnected => write!(formatter, "Worker event channel disconnected"),
            Self::Io(error) => write!(formatter, "Worker event I/O error: {error}"),
            Self::InvalidJson(error) => {
                write!(formatter, "Worker event contained invalid JSON: {error}")
            }
            Self::Protocol(message) => write!(formatter, "Worker event protocol error: {message}"),
        }
    }
}

impl Error for WorkerEventError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            Self::InvalidJson(source) => Some(source),
            Self::Timeout(_) | Self::Disconnected | Self::Protocol(_) => None,
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

    let parsed: Value = serde_json::from_slice(line).map_err(WorkerStartError::InvalidReady)?;
    let origin = common_v3::ready(&parsed, None).map_err(WorkerStartError::InvalidContract)?;
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
        cancel_url: raw.cancel_url,
        features: raw.features,
        stream: raw.stream,
        origin,
    }))
}

#[derive(Deserialize)]
struct RawWorkerErrorEvent {
    event: String,
    message: Option<String>,
    error: Option<Value>,
}

/// Best-effort extraction of a Common Worker startup `event:"error"` message.
///
/// Returns `None` for malformed JSON, non-error events, or missing/empty
/// messages. Never alters the existing `parse_ready()` error contract:
/// callers must still run `parse_ready()` first so malformed lines keep
/// producing `WorkerStartError::InvalidReady`.
fn startup_error_message(line: &[u8]) -> Option<String> {
    let event: RawWorkerErrorEvent = serde_json::from_slice(line).ok()?;
    if event.event != "error" {
        return None;
    }
    let message = event
        .error
        .as_ref()
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or(event.message.as_deref())?
        .trim()
        .to_owned();
    if message.is_empty() {
        None
    } else {
        Some(message)
    }
}

fn disconnected_reader_error() -> WorkerStartError {
    WorkerStartError::Reader(io::Error::other(
        "Worker stdout reader stopped before reporting ready",
    ))
}

/// Recent stderr bytes kept for startup diagnostics.
const MAX_STARTUP_STDERR_BYTES: usize = 8 * 1024;

#[derive(Debug, Default)]
struct StderrTail {
    bytes: Mutex<Vec<u8>>,
}

impl StderrTail {
    fn push(&self, chunk: &[u8]) {
        let mut bytes = self
            .bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if chunk.len() >= MAX_STARTUP_STDERR_BYTES {
            bytes.clear();
            bytes.extend_from_slice(&chunk[chunk.len() - MAX_STARTUP_STDERR_BYTES..]);
        } else {
            let overflow = bytes
                .len()
                .saturating_add(chunk.len())
                .saturating_sub(MAX_STARTUP_STDERR_BYTES);
            if overflow > 0 {
                bytes.drain(..overflow);
            }
            bytes.extend_from_slice(chunk);
        }
    }

    fn diagnostic(&self) -> Option<String> {
        let bytes = self
            .bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let text = String::from_utf8_lossy(&bytes).trim().to_owned();
        if text.is_empty() { None } else { Some(text) }
    }
}

/// Continuously drains piped stderr while keeping a bounded recent tail and
/// passing output through to the parent stderr.
///
/// Stderr is best-effort diagnostics: read or passthrough failures only end
/// this thread and never fail the Worker itself.
fn drain_stderr(stderr: ChildStderr, tail: Arc<StderrTail>) {
    let mut pipe = stderr;
    let mut chunk = [0_u8; 4096];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                tail.push(&chunk[..read]);
                let _ = io::stderr().write_all(&chunk[..read]);
            }
            Err(_) => break,
        }
    }
}

enum WaitForReadyError {
    ProcessExited {
        status: ExitStatus,
        diagnostic: Option<String>,
    },
    Startup(WorkerStartError),
}

fn wait_for_ready(
    process: &mut ManagedProcess,
    receiver: &Receiver<StdoutMessage>,
    startup_timeout: Duration,
) -> Result<WorkerReady, WaitForReadyError> {
    let deadline = Instant::now() + startup_timeout;
    let mut stdout_closed = false;
    // Latest non-empty structured `event:"error"` message seen so far.
    let mut diagnostic: Option<String> = None;

    loop {
        if !stdout_closed {
            match receiver.try_recv() {
                Ok(StdoutMessage::Line(line)) => {
                    if let Some(ready) = parse_ready(&line).map_err(WaitForReadyError::Startup)? {
                        return Ok(ready);
                    }
                    if let Some(message) = startup_error_message(&line) {
                        diagnostic = Some(message);
                    }
                }
                Ok(StdoutMessage::Error(error)) => {
                    return Err(WaitForReadyError::Startup(WorkerStartError::Reader(error)));
                }
                Ok(StdoutMessage::Eof) => stdout_closed = true,
                Err(TryRecvError::Disconnected) => {
                    return Err(WaitForReadyError::Startup(disconnected_reader_error()));
                }
                Err(TryRecvError::Empty) => {}
            }
        }

        if let Some(status) = process
            .try_wait()
            .map_err(|error| WaitForReadyError::Startup(WorkerStartError::ProcessIo(error)))?
        {
            if !stdout_closed {
                match receiver.recv_timeout(STARTUP_POLL_INTERVAL) {
                    Ok(StdoutMessage::Line(line)) => {
                        if let Some(ready) =
                            parse_ready(&line).map_err(WaitForReadyError::Startup)?
                        {
                            return Ok(ready);
                        }
                        if let Some(message) = startup_error_message(&line) {
                            diagnostic = Some(message);
                        }
                        continue;
                    }
                    Ok(StdoutMessage::Error(error)) => {
                        return Err(WaitForReadyError::Startup(WorkerStartError::Reader(error)));
                    }
                    Ok(StdoutMessage::Eof)
                    | Err(RecvTimeoutError::Timeout)
                    | Err(RecvTimeoutError::Disconnected) => {}
                }
            }
            return Err(WaitForReadyError::ProcessExited { status, diagnostic });
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(WaitForReadyError::Startup(
                WorkerStartError::StartupTimeout(startup_timeout),
            ));
        }

        let wait = STARTUP_POLL_INTERVAL.min(deadline.saturating_duration_since(now));
        if stdout_closed {
            thread::sleep(wait);
            continue;
        }

        match receiver.recv_timeout(wait) {
            Ok(StdoutMessage::Line(line)) => {
                if let Some(ready) = parse_ready(&line).map_err(WaitForReadyError::Startup)? {
                    return Ok(ready);
                }
                if let Some(message) = startup_error_message(&line) {
                    diagnostic = Some(message);
                }
            }
            Ok(StdoutMessage::Error(error)) => {
                return Err(WaitForReadyError::Startup(WorkerStartError::Reader(error)));
            }
            Ok(StdoutMessage::Eof) => stdout_closed = true,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err(WaitForReadyError::Startup(disconnected_reader_error()));
            }
        }
    }
}

/// Starts a Worker and waits for a valid Common Worker ready event.
pub fn start_worker(
    spec: &WorkerLaunchSpec,
    startup_timeout: Duration,
) -> Result<WorkerSession, WorkerStartError> {
    let (mut process, stdout, stderr) = spawn_with_piped_stdio(spec.executable(), spec.arguments())
        .map_err(WorkerStartError::Spawn)?;
    let (sender, receiver) = mpsc::channel();
    let stdout_reader = thread::Builder::new()
        .name("worker-stdout-reader".to_owned())
        .spawn(move || read_and_drain_stdout(stdout, sender))
        .map_err(WorkerStartError::Reader)?;
    let stderr_tail = Arc::new(StderrTail::default());
    let stderr_reader = match thread::Builder::new()
        .name("worker-stderr-reader".to_owned())
        .spawn({
            let tail = Arc::clone(&stderr_tail);
            move || drain_stderr(stderr, tail)
        }) {
        Ok(reader) => reader,
        Err(error) => {
            drop(process);
            let _ = stdout_reader.join();
            return Err(WorkerStartError::Reader(error));
        }
    };

    match wait_for_ready(&mut process, &receiver, startup_timeout) {
        Ok(ready) => {
            if let Some(manifest) = spec.manifest()
                && let Err(error) = manifest.validate_runtime_features(ready.features(), &[])
            {
                drop(process);
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(WorkerStartError::InvalidContract(error));
            }
            let tracker =
                JobTracker::new(ready.run_id()).map_err(WorkerStartError::InvalidContract)?;
            Ok(WorkerSession {
                manifest: spec.manifest().cloned(),
                jobs: Mutex::new(tracker),
                evidence: Mutex::new(RunEvidence::default()),
                stream_state: Mutex::new(None),
                process: Some(process),
                ready,
                stdout_reader: Some(stdout_reader),
                stderr_reader: Some(stderr_reader),
                event_receiver: Some(receiver),
                pending_events: Mutex::new(VecDeque::new()),
            })
        }
        Err(WaitForReadyError::ProcessExited {
            status,
            mut diagnostic,
        }) => {
            // The child has exited, so both pipes will reach EOF; join readers
            // first to guarantee both tails are fully drained before the
            // startup error is built. The stdout reader has joined, so no new
            // sender writes can arrive; draining to Empty/Disconnected ends.
            drop(process);
            let _ = stdout_reader.join();
            // A late structured `event:"error"` line may still sit queued in
            // the channel; the newest one overwrites the earlier diagnostic.
            // Malformed queued lines are ignored here: any malformed line
            // seen during `wait_for_ready` already returned `InvalidReady`
            // through the existing `parse_ready()` path above.
            // A queued stdout I/O error keeps the existing Reader semantics
            // instead of being downgraded to an exit-code failure.
            let mut stdout_reader_error: Option<io::Error> = None;
            loop {
                match receiver.try_recv() {
                    Ok(StdoutMessage::Line(line)) => {
                        if let Some(message) = startup_error_message(&line) {
                            diagnostic = Some(message);
                        }
                    }
                    Ok(StdoutMessage::Error(error)) => {
                        stdout_reader_error = Some(error);
                        break;
                    }
                    Ok(StdoutMessage::Eof) => {}
                    Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
                }
            }
            let _ = stderr_reader.join();
            if let Some(error) = stdout_reader_error {
                return Err(WorkerStartError::Reader(error));
            }
            let diagnostic = diagnostic.or_else(|| stderr_tail.diagnostic());
            Err(WorkerStartError::ExitedBeforeReady { status, diagnostic })
        }
        Err(WaitForReadyError::Startup(error)) => {
            // Ensure the child is terminated (or already exited) before joining
            // readers so neither thread waits on a pipe that never closes.
            drop(process);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            Err(error)
        }
    }
}
