use std::{
    ffi::OsStr,
    io,
    path::Path,
    process::{Child, Command, ExitStatus},
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

#[cfg(test)]
mod tests {
    use std::{
        env, process, thread,
        time::{Duration, Instant},
    };

    use super::{ManagedProcess, spawn};

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
}
