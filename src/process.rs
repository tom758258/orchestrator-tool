use std::{
    ffi::OsStr,
    io::{self, Read},
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

/// A child process managed by the orchestrator.
pub struct ManagedProcess {
    child: Child,
}

impl ManagedProcess {
    /// Returns the operating system process identifier.
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// Returns the exit status when the process has finished without blocking.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Waits for the process to finish and returns its exit status.
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait()
    }

    /// Forces the process to exit.
    pub fn kill(&mut self) -> io::Result<()> {
        self.child.kill()
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        match self.child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => {
                if self.child.kill().is_ok() {
                    let _ = self.child.wait();
                } else {
                    let _ = self.child.try_wait();
                }
            }
        }
    }
}

/// Starts an external process with inherited standard streams.
pub fn spawn<I, S>(executable: impl AsRef<Path>, args: I) -> io::Result<ManagedProcess>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let child = Command::new(executable.as_ref()).args(args).spawn()?;

    Ok(ManagedProcess { child })
}

/// Captured output from a one-shot process.
#[derive(Debug)]
pub(crate) struct CapturedOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: ExitStatus,
}

/// Error from a one-shot process invocation.
#[derive(Debug)]
pub(crate) enum CaptureError {
    Io(io::Error),
    Timeout,
}

fn join_reader(
    handle: thread::JoinHandle<io::Result<Vec<u8>>>,
    stream: &str,
) -> Result<Vec<u8>, CaptureError> {
    match handle.join() {
        Ok(Ok(buf)) => Ok(buf),
        Ok(Err(error)) => Err(CaptureError::Io(error)),
        Err(_) => Err(CaptureError::Io(io::Error::other(format!(
            "{stream} reader thread panicked"
        )))),
    }
}

/// Runs a process, captures stdout/stderr, and enforces a timeout.
pub(crate) fn run_output_with_timeout<I, S>(
    executable: impl AsRef<Path>,
    args: I,
    timeout: Duration,
) -> Result<CapturedOutput, CaptureError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut child = Command::new(executable.as_ref())
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(CaptureError::Io)?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_handle = thread::spawn(move || -> io::Result<Vec<u8>> {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout {
            pipe.read_to_end(&mut buf)?;
        }
        Ok(buf)
    });
    let stderr_handle = thread::spawn(move || -> io::Result<Vec<u8>> {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr {
            pipe.read_to_end(&mut buf)?;
        }
        Ok(buf)
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_handle.join();
                    let _ = stderr_handle.join();
                    return Err(CaptureError::Timeout);
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(original) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(CaptureError::Io(original));
            }
        }
    };

    let stdout = join_reader(stdout_handle, "stdout")?;
    let stderr = join_reader(stderr_handle, "stderr")?;

    Ok(CapturedOutput {
        stdout,
        stderr,
        status,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        env, process, thread,
        time::{Duration, Instant},
    };

    use super::{CaptureError, ManagedProcess, run_output_with_timeout, spawn};

    fn spawn_short_lived_child() -> ManagedProcess {
        spawn(
            env::current_exe().unwrap(),
            [
                "--quiet",
                "--exact",
                "__orchestrator_process_test_no_match__",
            ],
        )
        .unwrap()
    }

    #[test]
    fn process_can_be_spawned_identified_and_waited_for() {
        let mut child = spawn_short_lived_child();

        assert_ne!(child.id(), 0);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn try_wait_distinguishes_running_and_exited_processes() {
        let mut running = spawn(
            env::current_exe().unwrap(),
            [
                "--quiet",
                "--ignored",
                "--exact",
                "process::tests::blocking_child_fixture",
            ],
        )
        .unwrap();

        assert_eq!(running.try_wait().unwrap(), None);
        running.kill().unwrap();
        assert!(!running.wait().unwrap().success());

        let mut exited = spawn_short_lived_child();
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = exited.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "child process did not exit");
            thread::sleep(Duration::from_millis(10));
        };

        assert!(status.success());
    }

    #[test]
    fn nonexistent_executable_returns_spawn_error() {
        let missing_executable = env::temp_dir()
            .join(format!("orchestrator-tool-process-test-{}", process::id()))
            .join(format!("missing-executable{}", env::consts::EXE_SUFFIX));

        assert!(!missing_executable.exists());
        assert!(spawn(missing_executable, std::iter::empty::<&str>()).is_err());
    }

    #[test]
    #[ignore = "used as a child process fixture"]
    fn blocking_child_fixture() {
        thread::sleep(Duration::from_secs(30));
    }

    #[test]
    #[ignore = "used as a child process fixture"]
    fn output_fixture() {
        println!("__stdout_marker__");
        eprintln!("__stderr_marker__");
    }

    #[test]
    fn one_shot_captures_stdout_stderr_and_status() {
        let output = run_output_with_timeout(
            env::current_exe().unwrap(),
            [
                "--quiet",
                "--ignored",
                "--exact",
                "process::tests::output_fixture",
                "--nocapture",
            ],
            Duration::from_secs(5),
        )
        .unwrap();

        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stdout.contains("__stdout_marker__"),
            "stdout missing marker: {stdout:?}"
        );
        assert!(
            stderr.contains("__stderr_marker__"),
            "stderr missing marker: {stderr:?}"
        );
    }

    #[test]
    fn one_shot_timeout_terminates_child() {
        let start = Instant::now();
        let result = run_output_with_timeout(
            env::current_exe().unwrap(),
            [
                "--quiet",
                "--ignored",
                "--exact",
                "process::tests::blocking_child_fixture",
                "--nocapture",
            ],
            Duration::from_millis(100),
        );

        assert!(matches!(result, Err(CaptureError::Timeout)));
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "timeout should return quickly"
        );
    }
}
