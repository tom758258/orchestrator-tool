use std::{error::Error, fmt, time::Duration};

use serde_json::Value;

use crate::worker::WorkerReady;

/// A blocking client for Common Worker HTTP endpoints.
pub struct WorkerClient {
    agent: ureq::Agent,
    status_url: String,
    command_url: String,
    stop_url: String,
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
        optional_json_response(response)
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
        optional_json_response(response)
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
        required_json_response(response)
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

    fn status_response(&self) -> Result<(u16, Value), WorkerHttpError> {
        let response = self
            .agent
            .get(&self.status_url)
            .call()
            .map_err(WorkerHttpError::Request)?;
        required_json_response_with_status(response)
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

fn optional_json_response(
    response: ureq::http::Response<ureq::Body>,
) -> Result<Option<Value>, WorkerHttpError> {
    let body = response_body(response)?;
    if body.trim().is_empty() {
        return Ok(None);
    }

    serde_json::from_str(&body)
        .map(Some)
        .map_err(WorkerHttpError::InvalidJson)
}

/// Errors from Common Worker HTTP requests.
#[derive(Debug)]
pub enum WorkerHttpError {
    Request(ureq::Error),
    Non2xx(u16),
    InvalidJson(serde_json::Error),
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
            Self::Non2xx(_) => None,
        }
    }
}
