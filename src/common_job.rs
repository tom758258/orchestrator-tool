//! In-memory async Job correlation for one Common Worker v3 runtime.
//!
//! This owns no queue, scheduling, hardware operation or persistent history.
//! Terminals remain confirmed even when last_job advances or the Worker fails.

use crate::common_v3::{common_error, required_string, timestamp, version};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobObservation {
    Accepted,
    Confirmed,
    Duplicate,
    Ignored,
    Incomplete,
    Conflict,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Terminal {
    pub worker_job_id: String,
    pub job_id: Option<String>,
    pub command: String,
    pub state: String,
    pub timestamp_utc: String,
    pub ok: bool,
    pub result: Value,
    pub error: Value,
    /// Complete original event or snapshot for the domain adapter.
    pub original: Value,
}

impl Terminal {
    pub fn from_value(value: &Value) -> Result<Self, String> {
        timestamp(value)?;
        let state = required_string(value, "state")?;
        if !matches!(state, "succeeded" | "failed" | "cancelled") {
            return Err("invalid async terminal state".into());
        }
        let ok = value
            .get("ok")
            .and_then(Value::as_bool)
            .ok_or("async terminal missing boolean ok")?;
        let result = value
            .get("result")
            .ok_or("async terminal missing result")?
            .clone();
        let error = value
            .get("error")
            .ok_or("async terminal missing error")?
            .clone();
        if !error.is_null() {
            common_error(&error)?;
        }
        if (state == "succeeded" && (!ok || !error.is_null()))
            || (state == "failed" && (ok || error.is_null()))
            || (state == "cancelled" && ok)
        {
            return Err("async terminal state/ok/error mismatch".into());
        }
        let job_id = match value.get("job_id") {
            Some(Value::String(id)) => Some(id.clone()),
            Some(Value::Null) => None,
            _ => return Err("async terminal job_id must be string or null".into()),
        };
        Ok(Self {
            worker_job_id: required_string(value, "worker_job_id")?.to_owned(),
            command: required_string(value, "command")?.to_owned(),
            state: state.to_owned(),
            timestamp_utc: required_string(value, "timestamp_utc")?.to_owned(),
            job_id,
            ok,
            result,
            error,
            original: value.clone(),
        })
    }

    fn common_equivalent(&self, other: &Self) -> bool {
        self.worker_job_id == other.worker_job_id
            && self.job_id == other.job_id
            && self.command == other.command
            && self.state == other.state
            && self.ok == other.ok
            && self.timestamp_utc == other.timestamp_utc
            // An extra diagnostic field outside the terminal does not change
            // its meaning; different results or Common Error payloads do.
            && self.result == other.result
            && self.error == other.error
    }
}

#[derive(Clone, Debug)]
pub struct TrackedJob {
    command: String,
    worker_job_id: Option<String>,
    terminal: Option<Terminal>,
    evidence: Vec<String>,
    unconfirmed: Option<String>,
}

impl TrackedJob {
    pub fn terminal(&self) -> Option<&Terminal> {
        self.terminal.as_ref()
    }
    pub fn worker_job_id(&self) -> Option<&str> {
        self.worker_job_id.as_deref()
    }
    pub fn conflicts(&self) -> &[String] {
        &self.evidence
    }
    pub fn unconfirmed(&self) -> Option<&str> {
        self.unconfirmed.as_deref()
    }
}

#[derive(Debug)]
pub struct JobTracker {
    run_id: String,
    jobs: HashMap<String, TrackedJob>,
    worker_ids: HashMap<String, String>,
}

impl JobTracker {
    pub fn new(run_id: &str) -> Result<Self, String> {
        if run_id.trim().is_empty() {
            return Err("empty Worker run_id".into());
        }
        Ok(Self {
            run_id: run_id.to_owned(),
            jobs: HashMap::new(),
            worker_ids: HashMap::new(),
        })
    }

    /// Register before sending HTTP, so a terminal may arrive before Accepted.
    pub fn register(&mut self, job_id: &str, command: &str) -> Result<(), String> {
        if job_id.trim().is_empty() || command.trim().is_empty() {
            return Err("client job_id/command must be non-empty".into());
        }
        if self.jobs.contains_key(job_id) {
            return Err("duplicate client job_id (not an idempotency key)".into());
        }
        self.jobs.insert(
            job_id.to_owned(),
            TrackedJob {
                command: command.to_owned(),
                worker_job_id: None,
                terminal: None,
                evidence: Vec::new(),
                unconfirmed: None,
            },
        );
        Ok(())
    }

    pub fn job(&self, job_id: &str) -> Option<&TrackedJob> {
        self.jobs.get(job_id)
    }

    pub fn has_conflicts(&self) -> bool {
        self.jobs.values().any(|job| !job.evidence.is_empty())
    }

    pub fn accepted(
        &mut self,
        job_id: &str,
        command: &str,
        worker_job_id: &str,
    ) -> Result<JobObservation, String> {
        if worker_job_id.trim().is_empty() {
            return Err("empty worker_job_id".into());
        }
        let Some(job) = self.jobs.get_mut(job_id) else {
            return Err(format!("unregistered accepted job_id {job_id}"));
        };
        if job.command != command
            || job
                .worker_job_id
                .as_deref()
                .is_some_and(|known| known != worker_job_id)
            || self
                .worker_ids
                .get(worker_job_id)
                .is_some_and(|owner| owner != job_id)
        {
            job.evidence.push(format!(
                "HTTP Accepted job identity conflict: {job_id}/{worker_job_id}"
            ));
            return Ok(JobObservation::Conflict);
        }
        let duplicate = job.worker_job_id.is_some();
        job.worker_job_id = Some(worker_job_id.to_owned());
        self.worker_ids
            .insert(worker_job_id.to_owned(), job_id.to_owned());
        Ok(if duplicate {
            JobObservation::Duplicate
        } else {
            JobObservation::Accepted
        })
    }

    /// Common JSONL event; unknown domain events are left to their adapters.
    pub fn event(&mut self, value: &Value) -> Result<JobObservation, String> {
        version(value)?;
        let event = required_string(value, "event")?;
        self.check_run(value)?;
        if event != "job_finished" {
            return Ok(JobObservation::Ignored);
        }
        self.observe_terminal(value)
    }

    /// Observe one complete last_job; never interpret it as full job history.
    pub fn snapshot(&mut self, status: &Value) -> Result<JobObservation, String> {
        version(status)?;
        self.check_run(status)?;
        let job = status
            .get("last_job")
            .ok_or("async Status missing last_job")?;
        if job.is_null() {
            return Ok(JobObservation::Ignored);
        }
        let state = required_string(job, "state")?;
        if matches!(state, "queued" | "running") {
            // The Status owner must not treat a malformed non-terminal
            // snapshot as evidence. A valid queued/running observation does
            // not regress an already confirmed terminal.
            required_string(job, "worker_job_id")?;
            required_string(job, "command")?;
            timestamp(job)?;
            if !job
                .get("job_id")
                .is_some_and(|x| x.is_null() || x.is_string())
            {
                return Err("async active snapshot missing client job_id".into());
            }
            return Ok(JobObservation::Ignored);
        }
        if job.get("result").is_none() || job.get("error").is_none() {
            return Ok(JobObservation::Incomplete);
        }
        let mut nested = job.clone();
        let map = nested.as_object_mut().ok_or("last_job must be an object")?;
        map.insert("schema_version".into(), Value::from(3));
        map.insert("run_id".into(), Value::String(self.run_id.clone()));
        self.observe_terminal(&nested)
    }

    fn observe_terminal(&mut self, value: &Value) -> Result<JobObservation, String> {
        version(value)?;
        self.check_run(value)?;
        let terminal = Terminal::from_value(value)?;
        let Some(job_id) = terminal.job_id.as_deref() else {
            return Ok(JobObservation::Ignored);
        };
        let Some(job) = self.jobs.get_mut(job_id) else {
            return Ok(JobObservation::Ignored);
        };
        if job.command != terminal.command
            || job
                .worker_job_id
                .as_deref()
                .is_some_and(|x| x != terminal.worker_job_id)
            || self
                .worker_ids
                .get(&terminal.worker_job_id)
                .is_some_and(|x| x != job_id)
        {
            job.evidence
                .push(format!("terminal identity conflict for {job_id}"));
            return Ok(JobObservation::Conflict);
        }
        if let Some(existing) = &job.terminal {
            if existing.common_equivalent(&terminal) {
                return Ok(JobObservation::Duplicate);
            }
            job.evidence
                .push(format!("contradictory terminal for {job_id}: {value}"));
            return Ok(JobObservation::Conflict);
        }
        self.worker_ids
            .insert(terminal.worker_job_id.clone(), job_id.to_owned());
        job.worker_job_id = Some(terminal.worker_job_id.clone());
        job.terminal = Some(terminal);
        job.unconfirmed = None;
        Ok(JobObservation::Confirmed)
    }

    pub fn mark_unconfirmed(&mut self, job_id: &str, reason: &str) -> Result<(), String> {
        let job = self.jobs.get_mut(job_id).ok_or("unknown client job_id")?;
        if job.terminal.is_none() {
            job.unconfirmed = Some(reason.to_owned());
        }
        Ok(())
    }

    fn check_run(&self, value: &Value) -> Result<(), String> {
        if required_string(value, "run_id")? == self.run_id {
            Ok(())
        } else {
            Err("Worker Job run_id mismatch".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tracker() -> JobTracker {
        let mut tracker = JobTracker::new("run").unwrap();
        tracker.register("client-1", "read").unwrap();
        tracker
    }
    fn terminal() -> Value {
        json!({"event":"job_finished","schema_version":3,
            "timestamp_utc":"2026-10-23T10:00:00Z","run_id":"run",
            "worker_job_id":"worker-1","job_id":"client-1","command":"read",
            "state":"succeeded","ok":true,"result":{"value":42},"error":null})
    }

    #[test]
    fn terminal_before_accepted_or_lost_response() {
        let mut tracker = tracker();
        assert_eq!(
            tracker.event(&terminal()).unwrap(),
            JobObservation::Confirmed
        );
        assert_eq!(
            tracker.accepted("client-1", "read", "worker-1").unwrap(),
            JobObservation::Duplicate
        );
        assert_eq!(
            tracker.job("client-1").unwrap().terminal().unwrap().result["value"],
            42
        );
    }
    #[test]
    fn snapshot_can_confirm_without_jsonl_and_stale_status_cannot_regress() {
        let mut tracker = tracker();
        let mut nested = terminal();
        nested.as_object_mut().unwrap().remove("event");
        nested.as_object_mut().unwrap().remove("schema_version");
        nested.as_object_mut().unwrap().remove("run_id");
        let status = json!({"schema_version":3,"run_id":"run","last_job":nested});
        assert_eq!(
            tracker.snapshot(&status).unwrap(),
            JobObservation::Confirmed
        );
        assert_eq!(
            tracker.snapshot(&status).unwrap(),
            JobObservation::Duplicate
        );
        assert_eq!(
            tracker
                .snapshot(&json!({"schema_version":3,"run_id":"run",
            "last_job":{"state":"running","worker_job_id":"worker-1",
              "job_id":"client-1","command":"read",
              "timestamp_utc":"2026-10-23T10:00:00Z"}}))
                .unwrap(),
            JobObservation::Ignored
        );
        assert!(tracker.job("client-1").unwrap().terminal().is_some());
    }
    #[test]
    fn conflicting_terminals_preserve_first_success() {
        let mut tracker = tracker();
        tracker.event(&terminal()).unwrap();
        let mut conflicting = terminal();
        conflicting["state"] = json!("failed");
        conflicting["ok"] = json!(false);
        conflicting["error"] = json!({"category":"execution","code":"failed",
            "message":"failure","details":{}});
        assert_eq!(
            tracker.event(&conflicting).unwrap(),
            JobObservation::Conflict
        );
        assert!(tracker.has_conflicts());
        assert_eq!(
            tracker.job("client-1").unwrap().terminal().unwrap().state,
            "succeeded"
        );
        let mut changed_result = terminal();
        changed_result["result"]["value"] = json!(99);
        assert_eq!(
            tracker.event(&changed_result).unwrap(),
            JobObservation::Conflict
        );
        assert_eq!(
            tracker.job("client-1").unwrap().terminal().unwrap().result["value"],
            42
        );
    }
    #[test]
    fn incomplete_snapshot_and_crash_are_unconfirmed() {
        let mut tracker = tracker();
        let incomplete = json!({"schema_version":3,"run_id":"run",
            "last_job":{"state":"succeeded","worker_job_id":"worker-1"}});
        assert_eq!(
            tracker.snapshot(&incomplete).unwrap(),
            JobObservation::Incomplete
        );
        tracker
            .mark_unconfirmed("client-1", "Worker crash")
            .unwrap();
        assert_eq!(
            tracker.job("client-1").unwrap().unconfirmed(),
            Some("Worker crash")
        );
    }
    #[test]
    fn retain_old_confirmed_terminal_after_new_last_job() {
        let mut tracker = tracker();
        tracker.event(&terminal()).unwrap();
        tracker.register("client-2", "read").unwrap();
        let mut next = terminal();
        next["job_id"] = json!("client-2");
        next["worker_job_id"] = json!("worker-2");
        let status = json!({"schema_version":3,"run_id":"run","last_job":next});
        assert_eq!(
            tracker.snapshot(&status).unwrap(),
            JobObservation::Confirmed
        );
        assert!(tracker.job("client-1").unwrap().terminal().is_some());
        assert!(tracker.job("client-2").unwrap().terminal().is_some());
    }
}
