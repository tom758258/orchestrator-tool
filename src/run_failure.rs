//! A fatal run error is independent of the operator's graceful loop stop.
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Default)]
pub struct RunFailure(Arc<Mutex<Option<String>>>);

impl RunFailure {
    /// Keep the first cause, including errors raised by synchronous observers.
    pub fn fail(&self, message: impl Into<String>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_or_insert_with(|| message.into());
    }

    pub fn check(&self) -> Result<(), String> {
        match &*self.0.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(message) => Err(message.clone()),
            None => Ok(()),
        }
    }
}
