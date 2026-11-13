//! Run-scoped FG/BG facts. Workflow policy and native command evidence live outside this module.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InteractionSettings {
    pub enabled: bool,
    pub max_active_command_status: usize,
}

impl Default for InteractionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            max_active_command_status: 4096,
        }
    }
}

impl InteractionSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=65_536).contains(&self.max_active_command_status) {
            return Err("Max Active Command Status must be an integer from 1 to 65,536".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum InteractionOperation {
    Command {
        command: BackgroundCommand,
        wait_for_completion: bool,
    },
    GetLatest,
    WaitNext,
    GetCommandResult {
        source_step: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundCommand {
    SoftwareTrigger,
}

pub type CommandId = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandState {
    Dispatching,
    Accepted,
    Running,
    Completed,
    Failed,
    DispatchOutcomeUnknown,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", content = "value", rename_all = "kebab-case")]
pub enum ResultState {
    Unrequested,
    Pending,
    Ready(Value),
    Failed(String),
}

#[derive(Clone, Debug, Serialize)]
pub struct CommandStatus {
    pub id: CommandId,
    pub background_id: String,
    pub generation: u64,
    pub state: CommandState,
    pub result: ResultState,
    pub error: Option<String>,
    interest: bool,
    dispatch_observer: bool,
}

#[derive(Clone, Debug)]
pub struct StatusSnapshot {
    pub revision: u64,
    pub commands: Vec<CommandStatus>,
    pub failure: Option<String>,
}

#[derive(Default)]
struct Source {
    generation: u64,
    on: bool,
    active: bool,
    ended: bool,
    quarantined: bool,
    latest: Option<Result<Value, String>>,
    next: HashMap<u64, Option<Result<Value, String>>>,
}

struct State {
    capacity: usize,
    next_id: u64,
    revision: u64,
    sources: HashMap<String, Source>,
    commands: HashMap<CommandId, CommandStatus>,
    failure: Option<String>,
}

#[derive(Clone)]
pub struct InteractionCore(Arc<(Mutex<State>, Condvar)>);

impl InteractionCore {
    pub fn new(capacity: usize) -> Result<Self, String> {
        InteractionSettings {
            enabled: true,
            max_active_command_status: capacity,
        }
        .validate()?;
        Ok(Self(Arc::new((
            Mutex::new(State {
                capacity,
                next_id: 0,
                revision: 0,
                sources: HashMap::new(),
                commands: HashMap::new(),
                failure: None,
            }),
            Condvar::new(),
        ))))
    }

    fn update<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        let mut state = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        let result = f(&mut state);
        state.revision = state.revision.wrapping_add(1);
        self.0.1.notify_all();
        result
    }

    pub fn worker_on(&self, background: &str) -> Result<u64, String> {
        self.update(|s| {
            let source = s.sources.entry(background.into()).or_default();
            if source.on || source.quarantined {
                return Err(format!(
                    "{background}: Worker is already ON or its shutdown is unconfirmed"
                ));
            }
            let generation = source
                .generation
                .checked_add(1)
                .ok_or("Runtime generation exhausted")?;
            *source = Source {
                generation,
                on: true,
                ..Source::default()
            };
            Ok(generation)
        })
    }

    pub fn worker_off(&self, background: &str, generation: u64, confirmed: bool) {
        self.update(|s| {
            if let Some(source) = s
                .sources
                .get_mut(background)
                .filter(|v| v.generation == generation)
            {
                source.on = false;
                source.quarantined = !confirmed;
                source.latest = None;
                for waiter in source.next.values_mut() {
                    if waiter.is_none() {
                        *waiter = Some(Err("Worker is OFF".into()));
                    }
                }
                // A new lifecycle must never resolve old command/result references.
                for status in s
                    .commands
                    .values_mut()
                    .filter(|v| v.background_id == background && v.generation == generation)
                {
                    if !matches!(status.state, CommandState::Completed | CommandState::Failed) {
                        status.state = CommandState::Failed;
                        status.error = Some("Worker stopped before Command completion".into());
                        s.failure
                            .get_or_insert_with(|| status.error.clone().unwrap());
                    }
                }
            }
        });
    }

    pub fn source_ended(&self, background: &str, generation: u64) {
        self.update(|s| {
            if let Some(source) = s
                .sources
                .get_mut(background)
                .filter(|v| v.generation == generation)
            {
                source.ended = true;
                for waiter in source.next.values_mut() {
                    if waiter.is_none() {
                        *waiter = Some(Err("Background Source has ended".into()));
                    }
                }
            }
        });
    }

    pub fn source_active(&self, background: &str, generation: u64) {
        self.update(|s| {
            if let Some(source) = s
                .sources
                .get_mut(background)
                .filter(|v| v.generation == generation)
            {
                source.active = true;
            }
        });
    }

    pub fn is_active(&self, background: &str) -> Result<bool, String> {
        let s = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        let source = active_source(&s, background)?;
        if source.ended {
            return Err("Background Source has ended".into());
        }
        Ok(source.active)
    }

    /// The sole dispatcher publishes the complete native event, including invalid first events.
    pub fn data(&self, background: &str, generation: u64, event: Result<Value, String>) {
        self.update(|s| {
            if let Some(source) = s
                .sources
                .get_mut(background)
                .filter(|v| v.on && v.generation == generation)
            {
                source.latest = Some(event.clone());
                for waiter in source.next.values_mut() {
                    if waiter.is_none() {
                        *waiter = Some(event.clone());
                    }
                }
            }
        });
    }

    pub fn latest(&self, background: &str) -> Result<Value, String> {
        let s = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        let source = active_source(&s, background)?;
        source
            .latest
            .clone()
            .ok_or("No Background data has arrived")?
    }

    /// Registers and checks Source state under the same lock as publication.
    pub fn next(&self, background: &str) -> Result<NextEvent, String> {
        self.update(|s| {
            if active_source(s, background)?.ended {
                return Err("Background Source has ended".into());
            }
            let id = next_id(s)?;
            let source = s.sources.get_mut(background).unwrap();
            source.next.insert(id, None);
            Ok(NextEvent {
                core: self.clone(),
                background: background.into(),
                generation: source.generation,
                id,
            })
        })
    }

    /// Atomically reserves the run-wide status and per-Runtime result slot before any I/O.
    pub fn reserve(&self, background: &str, interest: bool) -> Result<CommandId, String> {
        self.update(|s| {
            let source = active_source(s, background)?;
            if source.quarantined {
                return Err("Dispatch Outcome Unknown: Runtime reuse is blocked".into());
            }
            if source.ended {
                return Err("Background Source has ended".into());
            }
            let generation = source.generation;
            if s.commands.len() >= s.capacity {
                return Err("Max Active Command Status reached".into());
            }
            if interest
                && s.commands.values().any(|v| {
                    v.background_id == background && v.generation == generation && slot_held(v)
                })
            {
                return Err("Background Result Slot is busy".into());
            }
            let id = next_id(s)?;
            s.commands.insert(
                id,
                CommandStatus {
                    id,
                    background_id: background.into(),
                    generation,
                    state: CommandState::Dispatching,
                    result: if interest {
                        ResultState::Pending
                    } else {
                        ResultState::Unrequested
                    },
                    error: None,
                    interest,
                    dispatch_observer: true,
                },
            );
            Ok(id)
        })
    }

    /// Use only after a validated rejection proves that the Worker did not execute the command.
    pub fn rejected(&self, id: CommandId) {
        self.update(|s| {
            s.commands.remove(&id);
        });
    }

    pub fn observe(
        &self,
        id: CommandId,
        generation: u64,
        state: CommandState,
        error: Option<String>,
    ) {
        self.update(|s| {
            let Some(status) = s
                .commands
                .get_mut(&id)
                .filter(|v| v.generation == generation)
            else {
                return;
            };
            if matches!(status.state, CommandState::Completed | CommandState::Failed) {
                if status.state != state
                    && !matches!(state, CommandState::Accepted | CommandState::Running)
                {
                    s.failure.get_or_insert_with(|| {
                        format!("Command {id}: contradictory terminal evidence")
                    });
                }
                return;
            }
            status.state = state;
            status.error = error;
            if matches!(
                state,
                CommandState::Failed | CommandState::DispatchOutcomeUnknown
            ) {
                s.failure.get_or_insert_with(|| {
                    format!(
                        "Command {id}: {}",
                        status.error.as_deref().unwrap_or("failed")
                    )
                });
                if state == CommandState::DispatchOutcomeUnknown {
                    if let Some(source) = s.sources.get_mut(&status.background_id) {
                        source.quarantined = true;
                    }
                } else if matches!(status.result, ResultState::Pending | ResultState::Ready(_)) {
                    status.result = ResultState::Failed(
                        status.error.clone().unwrap_or("Command failed".into()),
                    );
                }
            }
            reclaim(s);
        });
    }

    pub fn result(&self, id: CommandId, generation: u64, result: Result<Value, String>) {
        self.update(|s| {
            if let Some(status) = s
                .commands
                .get_mut(&id)
                .filter(|v| v.generation == generation && matches!(v.result, ResultState::Pending))
            {
                status.result = match result {
                    Ok(v) => ResultState::Ready(v),
                    Err(e) => ResultState::Failed(e),
                };
            }
            reclaim(s);
        });
    }

    pub fn release_interest(&self, id: CommandId) {
        self.update(|s| {
            if let Some(status) = s.commands.get_mut(&id) {
                status.interest = false;
            }
            // Pending results stay retained until their identity is safely settled.
            reclaim(s);
        });
    }

    pub fn finish_dispatch(&self, id: CommandId) {
        self.update(|s| {
            if let Some(status) = s.commands.get_mut(&id) {
                status.dispatch_observer = false;
            }
            reclaim(s);
        });
    }

    pub fn command(&self, id: CommandId) -> Result<CommandStatus, String> {
        let s = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        let status = s
            .commands
            .get(&id)
            .ok_or("Command reference is no longer available")?;
        let source = active_source(&s, &status.background_id)?;
        if source.generation != status.generation {
            return Err("Command belongs to an earlier Worker lifecycle".into());
        }
        Ok(status.clone())
    }

    pub fn take_result(&self, id: CommandId) -> Result<Option<Value>, String> {
        self.update(|s| {
            let status = s
                .commands
                .get(&id)
                .ok_or("Command reference is no longer available")?;
            if active_source(s, &status.background_id)?.generation != status.generation {
                return Err("Command belongs to an earlier Worker lifecycle".into());
            }
            if matches!(
                status.state,
                CommandState::Failed | CommandState::DispatchOutcomeUnknown
            ) {
                return Err(status.error.clone().unwrap_or("Command failed".into()));
            }
            if let ResultState::Failed(error) = &status.result {
                return Err(error.clone());
            }
            if status.state == CommandState::Completed
                && let ResultState::Ready(value) = &status.result
            {
                let value = value.clone();
                let status = s.commands.get_mut(&id).unwrap();
                status.result = ResultState::Unrequested;
                status.interest = false;
                reclaim(s);
                return Ok(Some(value));
            }
            if matches!(status.result, ResultState::Unrequested) {
                return Err("Command has no retained Result".into());
            }
            Ok(None)
        })
    }

    pub fn snapshot(&self) -> StatusSnapshot {
        let s = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        StatusSnapshot {
            revision: s.revision,
            commands: s.commands.values().cloned().collect(),
            failure: s.failure.clone(),
        }
    }

    /// Revision check and subscription share a lock. Notifications carry no facts/history.
    pub fn wait_for_change(&self, revision: u64, deadline: Instant) {
        let guard = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        let _guard = self
            .0
            .1
            .wait_timeout_while(
                guard,
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(10)),
                |s| s.revision == revision,
            )
            .unwrap_or_else(|e| e.into_inner());
    }
}

fn next_id(s: &mut State) -> Result<u64, String> {
    s.next_id = s.next_id.checked_add(1).ok_or("Interaction ID exhausted")?;
    Ok(s.next_id)
}
fn active_source<'a>(s: &'a State, id: &str) -> Result<&'a Source, String> {
    s.sources
        .get(id)
        .filter(|v| v.on)
        .ok_or_else(|| format!("{id}: Worker is OFF"))
}
fn slot_held(status: &CommandStatus) -> bool {
    matches!(status.result, ResultState::Pending | ResultState::Ready(_))
}
fn reclaim(s: &mut State) {
    s.commands.retain(|_, v| {
        v.state != CommandState::Completed
            || v.interest
            || v.dispatch_observer
            || matches!(v.result, ResultState::Pending)
    });
}

pub struct NextEvent {
    core: InteractionCore,
    background: String,
    generation: u64,
    id: u64,
}
impl NextEvent {
    pub fn poll(&self) -> Result<Option<Value>, String> {
        let s = self.core.0.0.lock().unwrap_or_else(|e| e.into_inner());
        let source = active_source(&s, &self.background)?;
        if source.generation != self.generation {
            return Err("Worker lifecycle changed".into());
        }
        source.next.get(&self.id).cloned().flatten().transpose()
    }
}
impl Drop for NextEvent {
    fn drop(&mut self) {
        self.core.update(|s| {
            if let Some(source) = s
                .sources
                .get_mut(&self.background)
                .filter(|v| v.generation == self.generation)
            {
                source.next.remove(&self.id);
            }
        });
    }
}

/// Capability and lexical references are checked at the Template boundary, without path proving IFs.
pub(crate) fn validate_template(template: &crate::template::Template) -> Result<(), String> {
    use crate::{
        meters_setup::MetersTriggerMode,
        workflow::{Step, StepKind},
    };
    let settings = template.workflow().interaction();
    settings.validate()?;
    for background in template.backgrounds().iter().filter(|b| b.command_trigger) {
        let instance = template
            .tool_instances()
            .iter()
            .find(|i| i.id == background.tool_instance_id)
            .unwrap();
        if !settings.enabled
            || !instance
                .meters_setup()
                .is_some_and(|s| s.trigger_mode == MetersTriggerMode::Software)
            || background.timer_interval_ms.is_some()
        {
            return Err("BG Command triggering requires enabled FG/BG Interaction, Meters Software (Simple), and no Timer Interval".into());
        }
    }
    fn visit(
        template: &crate::template::Template,
        steps: &[Step],
        path: &[String],
        commands: &mut HashMap<String, (String, Vec<String>)>,
    ) -> Result<(), String> {
        for step in steps {
            match step.kind() {
                StepKind::Interaction {
                    background_id,
                    operation,
                    timeout_ms,
                } => {
                    if !template.workflow().interaction().enabled {
                        return Err(format!(
                            "{}: Enable FG/BG Interaction before using interaction Steps",
                            step.id()
                        ));
                    }
                    if timeout_ms.is_some_and(|v| {
                        v == 0
                            || Instant::now()
                                .checked_add(Duration::from_millis(v))
                                .is_none()
                    }) {
                        return Err(format!(
                            "{}: timeout must be positive and representable",
                            step.id()
                        ));
                    }
                    let config = template
                        .backgrounds()
                        .iter()
                        .find(|b| &b.id == background_id)
                        .ok_or_else(|| {
                            format!("{}: Unknown Background {background_id}", step.id())
                        })?;
                    match operation {
                        InteractionOperation::Command { .. } => {
                            if !config.command_trigger {
                                return Err(format!(
                                    "{}: Software Trigger requires a Meters Software (Simple) Background with BG Command triggering",
                                    step.id()
                                ));
                            }
                            commands.insert(
                                step.id().to_string(),
                                (background_id.clone(), path.to_vec()),
                            );
                        }
                        InteractionOperation::GetCommandResult { source_step } => {
                            let (source_bg, scope) =
                                commands.get(source_step).ok_or_else(|| {
                                    format!(
                                        "{}: Result source must be an earlier BG Command Step",
                                        step.id()
                                    )
                                })?;
                            if source_bg != background_id || !path.starts_with(scope) {
                                return Err(format!(
                                    "{}: Result source has a different Background or is outside its Loop scope",
                                    step.id()
                                ));
                            }
                        }
                        _ => {}
                    }
                }
                StepKind::For { body, .. } | StepKind::While { body, .. } => {
                    let mut child = path.to_vec();
                    child.push(step.id().to_string());
                    visit(template, body, &child, commands)?;
                }
                StepKind::If {
                    then_steps,
                    else_steps,
                    ..
                } => {
                    visit(template, then_steps, path, commands)?;
                    visit(template, else_steps, path, commands)?;
                }
                _ => {}
            }
        }
        Ok(())
    }
    visit(
        template,
        template.workflow().steps(),
        &[],
        &mut HashMap::new(),
    )
}
