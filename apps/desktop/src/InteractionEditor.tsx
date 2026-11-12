import { allWorkflowSteps, loopPath, type BackgroundConfig, type InteractionSettings, type InteractionStep, type WorkflowStep } from './workflow'

export function InteractionSettingsEditor({ value, disabled, onChange }: {
  value: InteractionSettings; disabled: boolean; onChange: (value: InteractionSettings) => void
}) {
  return <section aria-label="FG/BG Interaction settings">
    <h3>FG/BG Interaction</h3>
    <label><input type="checkbox" checked={value.enabled} disabled={disabled}
      onChange={event => onChange({ ...value, enabled: event.target.checked })} />Enable FG/BG Interaction</label>
    <label>Max Active Command Status<input type="number" min={1} max={65536} step={1} required
      value={value.max_active_command_status} disabled={disabled || !value.enabled}
      onChange={event => onChange({ ...value, max_active_command_status: Number(event.target.value) })} /></label>
    <p>Shared by all Backgrounds in this Run. Completed, settled commands release capacity.</p>
  </section>
}

export function InteractionEditor({ step, steps, backgrounds, disabled, onChange }: {
  step: InteractionStep; steps: WorkflowStep[]; backgrounds: BackgroundConfig[]; disabled: boolean; onChange: (step: InteractionStep) => void
}) {
  const flat = allWorkflowSteps(steps)
  const scope = loopPath(steps, step.id).map(loop => loop.id)
  const sources = flat.slice(0, flat.findIndex(s => s.id === step.id)).filter((s): s is InteractionStep => {
    const sourceScope = loopPath(steps, s.id).map(loop => loop.id)
    return s.type === 'bg-interaction' && s.operation.kind === 'command' && s.background_id === step.background_id &&
      sourceScope.every((id, index) => scope[index] === id)
  })
  return <fieldset disabled={disabled}>
    <legend>Background interaction</legend>
    <label>Background<select value={step.background_id} onChange={event => onChange({ ...step, background_id: event.target.value })}>
      {backgrounds.map(b => <option key={b.id} value={b.id}>{b.id} · {b.tool_instance_id}</option>)}
    </select></label>
    {step.operation.kind === 'command' && <>
      <p>Software Trigger · Meters Software (Simple). Select Trigger with BG Command in Background Setup.</p>
      <label><input type="checkbox" checked={step.operation.wait_for_completion} onChange={event => {
        if (step.operation.kind === 'command') onChange({ ...step, operation: { ...step.operation, wait_for_completion: event.target.checked } })
      }} />Wait for Completion</label>
    </>}
    {step.operation.kind === 'get-command-result' && <label>Source BG Command Step<select value={step.operation.source_step}
      onChange={event => onChange({ ...step, operation: { kind: 'get-command-result', source_step: event.target.value } })}>
      <option value="">Select a BG Command Step</option>
      {sources.map(source => <option key={source.id} value={source.id}>{source.id}</option>)}
    </select></label>}
    <label>Step timeout (ms)<input type="number" min={1} step={1} placeholder="Use action timeout"
      value={step.timeout_ms ?? ''} onChange={event => onChange({ ...step, timeout_ms: event.target.value === '' ? null : Number(event.target.value) })} /></label>
    <p>One deadline covers this entire Step. Worker must be ON; Capture may be OFF.</p>
  </fieldset>
}
