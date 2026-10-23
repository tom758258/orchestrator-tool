use std::{error::Error, fmt, time::Duration};

use serde_json::Value;

use crate::{common_v3, worker::WorkerReady};

/// A blocking client for Common Worker HTTP endpoints.
pub struct WorkerClient {
    agent: ureq::Agent,
    status_url: String,
    command_url: String,
    stop_url: String,
    cancel_url: Option<String>,
    ready: WorkerReady,
}

impl WorkerClient {
    /// Creates a client from validated Worker ready information.
    pub fn new(ready: &WorkerReady) -> Self {
        let config = ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .proxy(None)
            .build();

        Self {
            agent: ureq::Agent::new_with_config(config),
            status_url: ready.status_url().to_owned(),
            command_url: ready.command_url().to_owned(),
            stop_url: ready.stop_url().to_owned(),
            cancel_url: ready.cancel_url().map(str::to_owned),
            ready: ready.clone(),
        }
    }

    /// Gets the current generic Worker status payload.
    pub fn status(&self) -> Result<Value, WorkerHttpError> {
        self.status_response().map(|(_, value)| value)
    }

    /// Sends a generic JSON command payload to the Worker.
    pub fn command(&self, payload: &Value) -> Result<Value, WorkerHttpError> {
        self.command_response(payload).map(|(_, value)| value)
    }

    /// Requests that the Worker stop.
    pub fn stop(&self) -> Result<Option<Value>, WorkerHttpError> {
        let response = self
            .agent
            .post(&self.stop_url)
            .send_empty()
            .map_err(WorkerHttpError::Request)?;
        let (code, value) = required_json_response_with_status(response)?;
        common_v3::stop_accepted(&value, code, self.ready.run_id())
            .map_err(WorkerHttpError::Contract)?;
        Ok(Some(value))
    }

    pub(crate) fn stop_with_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<Value>, WorkerHttpError> {
        let response = self
            .agent
            .post(&self.stop_url)
            .config()
            .timeout_global(Some(timeout))
            .build()
            .send_empty()
            .map_err(WorkerHttpError::Request)?;
        let (code, value) = required_json_response_with_status(response)?;
        common_v3::stop_accepted(&value, code, self.ready.run_id())
            .map_err(WorkerHttpError::Contract)?;
        Ok(Some(value))
    }

    pub(crate) fn status_with_timeout(&self, timeout: Duration) -> Result<Value, WorkerHttpError> {
        let response = self
            .agent
            .get(&self.status_url)
            .config()
            .timeout_global(Some(timeout))
            .build()
            .call()
            .map_err(WorkerHttpError::Request)?;
        if response.status().as_u16() != 200 {
            return Err(WorkerHttpError::Contract(
                "GET /status must return HTTP 200".into(),
            ));
        }
        let status = required_json_response(response)?;
        self.validate_status(&status)?;
        Ok(status)
    }

    pub(crate) fn command_with_timeout(
        &self,
        payload: &Value,
        timeout: Duration,
    ) -> Result<(u16, Value), WorkerHttpError> {
        let response = self
            .agent
            .post(&self.command_url)
            .config()
            .timeout_global(Some(timeout))
            .build()
            .send_json(payload)
            .map_err(WorkerHttpError::Request)?;
        required_json_response_with_status(response)
    }

    /// Preserves the structured admission rejection returned by a Worker.
    pub(crate) fn command_with_rejection_timeout(
        &self,
        payload: &Value,
        timeout: Duration,
    ) -> Result<(u16, Value), WorkerHttpError> {
        let mut response = self
            .agent
            .post(&self.command_url)
            .config()
            .timeout_global(Some(timeout))
            .build()
            .send_json(payload)
            .map_err(WorkerHttpError::Request)?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(WorkerHttpError::Request)?;
        let value = serde_json::from_str(&body).map_err(WorkerHttpError::InvalidJson)?;
        common_v3::version(&value).map_err(WorkerHttpError::Contract)?;
        Ok((status, value))
    }

    fn validate_status(&self, value: &Value) -> Result<(), WorkerHttpError> {
        common_v3::status(
            value,
            self.ready.run_id(),
            self.ready.origin(),
            None,
            self.ready.features(),
            false,
        )
        .map_err(WorkerHttpError::Contract)
    }

    /// An accepted cancellation does not imply a cancelled job terminal.
    pub fn cancel(
        &self,
        worker_job_id: &str,
        reason: Option<&str>,
    ) -> Result<Value, WorkerHttpError> {
        let url = self.cancel_url.as_ref().ok_or_else(|| {
            WorkerHttpError::Contract("Worker did not adopt common.job_cancel".into())
        })?;
        let mut body = serde_json::json!({"schema_version":3,"worker_job_id":worker_job_id});
        if let Some(reason) = reason {
            body["reason"] = Value::String(reason.to_owned());
        }
        let response = self
            .agent
            .post(url.as_str())
            .send_json(&body)
            .map_err(WorkerHttpError::Request)?;
        let (code, value) = required_json_response_with_status(response)?;
        if code != 202
            || value["status"] != "accepted"
            || value["run_id"] != self.ready.run_id()
            || value["worker_job_id"] != worker_job_id
            || !value.get("error").is_some_and(Value::is_null)
        {
            return Err(WorkerHttpError::Contract(
                "invalid cancel acceptance envelope".into(),
            ));
        }
        common_v3::version(&value).map_err(WorkerHttpError::Contract)?;
        Ok(value)
    }

    fn status_response(&self) -> Result<(u16, Value), WorkerHttpError> {
        let response = self
            .agent
            .get(&self.status_url)
            .call()
            .map_err(WorkerHttpError::Request)?;
        let (code, value) = required_json_response_with_status(response)?;
        if code != 200 {
            return Err(WorkerHttpError::Contract(
                "GET /status must return HTTP 200".into(),
            ));
        }
        self.validate_status(&value)?;
        Ok((code, value))
    }

    fn command_response(&self, payload: &Value) -> Result<(u16, Value), WorkerHttpError> {
        let response = self
            .agent
            .post(&self.command_url)
            .send_json(payload)
            .map_err(WorkerHttpError::Request)?;
        required_json_response_with_status(response)
    }
}

fn response_body(
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<String, WorkerHttpError> {
    let status = response.status();
    if !status.is_success() {
        return Err(WorkerHttpError::Non2xx(status.as_u16()));
    }

    response
        .body_mut()
        .read_to_string()
        .map_err(WorkerHttpError::Request)
}

fn required_json_response(
    response: ureq::http::Response<ureq::Body>,
) -> Result<Value, WorkerHttpError> {
    required_json_response_with_status(response).map(|(_, value)| value)
}

fn required_json_response_with_status(
    response: ureq::http::Response<ureq::Body>,
) -> Result<(u16, Value), WorkerHttpError> {
    let status = response.status().as_u16();
    let body = response_body(response)?;
    let value = serde_json::from_str(&body).map_err(WorkerHttpError::InvalidJson)?;
    Ok((status, value))
}

/// Errors from Common Worker HTTP requests.
#[derive(Debug)]
pub enum WorkerHttpError {
    Request(ureq::Error),
    Non2xx(u16),
    InvalidJson(serde_json::Error),
    Contract(String),
}

impl fmt::Display for WorkerHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Request(error) => write!(formatter, "Worker HTTP request failed: {error}"),
            Self::Non2xx(status) => {
                write!(
                    formatter,
                    "Worker HTTP response had non-2xx status {status}"
                )
            }
            Self::Contract(message) => write!(formatter, "Worker v3 HTTP contract: {message}"),
            Self::InvalidJson(error) => {
                write!(
                    formatter,
                    "Worker HTTP response contained invalid JSON: {error}"
                )
            }
        }
    }
}

impl Error for WorkerHttpError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Request(source) => Some(source),
            Self::InvalidJson(source) => Some(source),
            Self::Non2xx(_) | Self::Contract(_) => None,
        }
    }
}
