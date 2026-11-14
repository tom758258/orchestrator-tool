import { useState } from 'react'
import { allWorkflowSteps, inputScope, loopPath, type BackgroundConfig, type InteractionOperation, type InteractionSettings, type InteractionStep, type WorkflowStep } from './workflow'
import SerialActionEditor from './SerialActionEditor'
import type { ToolInstance } from './ToolSetupEditor'

export function InteractionSettingsEditor({ value, disabled, hasBackground, onChange }: {
  value: InteractionSettings; disabled: boolean; hasBackground: boolean
  onChange: (value: InteractionSettings) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const open = hasBackground && expanded
  return <section className="streaming-panel" aria-label="FG/BG Interaction settings">
    <h3><button type="button" className="collapsible-header"
      aria-label={`${open ? 'Collapse' : 'Expand'} FG/BG Interaction`}
      aria-expanded={open} disabled={!hasBackground}
      aria-describedby={!hasBackground ? 'fg-bg-interaction-hint' : undefined}
      onClick={() => setExpanded(current => !current)}>
      FG/BG Interaction <span aria-hidden="true">{!hasBackground ? '🔒' : open ? '−' : '+'}</span>
    </button></h3>
    {!hasBackground && <p className="step-category-hint" id="fg-bg-interaction-hint">
      No Background binding. Enable Background Streaming in Setup.
    </p>}
    {open && <div className="interaction-settings-fields">
      <label className="streaming-toggle"><input type="checkbox" checked={value.enabled} disabled={disabled}
        onChange={event => onChange({ ...value, enabled: event.target.checked })} /> Enable FG/BG Interaction</label>
      <label className="step-property-field">Max Active Command Status
        <input type="number" min={1} max={65536} step={1} required
          value={value.max_active_command_status} disabled={disabled || !value.enabled}
          onChange={event => onChange({ ...value, max_active_command_status: Number(event.target.value) })} />
      </label>
      <p className="tool-setup-hint">Shared by all Backgrounds in this Run. Completed, settled commands release capacity.</p>
    </div>}
  </section>
}

export function InteractionEditor({ step, steps, backgrounds, instances = [], disabled, onChange }: {
  step: InteractionStep; steps: WorkflowStep[]; backgrounds: BackgroundConfig[]; disabled: boolean; onChange: (step: InteractionStep) => void
  instances?: ToolInstance[]
}) {
  const [savedCommands, setSavedCommands] = useState<Record<string, InteractionOperation>>({})
  const instanceId = backgrounds.find(b => b.id === step.background_id)?.tool_instance_id
  const tool = instances.find(i => i.id === instanceId)?.tool
  const operation = step.operation
  const supported = operation.kind !== 'command' || (tool === 'serial'
    ? operation.command !== 'software-trigger' : tool === 'meters' && operation.command === 'software-trigger')
  const { earlierSteps, earlierVariables } = inputScope(steps, step.id)
  const selectCommand = (command: 'software-trigger' | 'serial-send' | 'serial-send-file') => {
    if (operation.kind !== 'command') return
    setSavedCommands(current => ({ ...current, [`${step.id}:${operation.command}`]: operation }))
    const saved = savedCommands[`${step.id}:${command}`]
    onChange({ ...step, operation: saved ?? (command === 'software-trigger'
      ? { kind: 'command', command, wait_for_completion: operation.wait_for_completion }
      : { kind: 'command', command, wait_for_completion: operation.wait_for_completion,
          arguments: command === 'serial-send' ? { tx_format: 'text', tx_value: '' } : { path: '' } }) })
  }
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
      <label>Command<select value={step.operation.command} onChange={event => selectCommand(event.target.value as 'software-trigger' | 'serial-send' | 'serial-send-file')}>
        {!supported && <option value={step.operation.command}>{step.operation.command} (unsupported Background)</option>}
        {tool === 'serial' && <><option value="serial-send">Send</option><option value="serial-send-file">Send File</option></>}
        {tool === 'meters' && <option value="software-trigger">Software Trigger</option>}
      </select></label>
      {!supported && <p role="alert">This command does not match the selected Background. Select a supported command or Background.</p>}
      {step.operation.command === 'software-trigger' && <p>Software Trigger · Meters Software (Simple). Select Trigger with BG Command in Background Setup.</p>}
      {operation.kind === 'command' && operation.command !== 'software-trigger' && <SerialActionEditor
        key={step.id} step={{ type: 'tool-action', id: step.id, target: instanceId ?? '',
          action: operation.command === 'serial-send' ? 'send' : 'send-file', arguments: operation.arguments,
          ...(operation.bindings ? { bindings: operation.bindings } : {}) }}
        instances={instances} earlierSteps={earlierSteps} earlierVariables={earlierVariables}
        disabled={disabled || !supported} stepLabel={value => value.id}
        onChange={value => onChange({ ...step, operation: { ...operation, arguments: value.arguments,
          bindings: value.bindings } })} />}
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
    {tool === 'serial' && <p>Get Command Result returns the complete native job_finished event. TX completion does not confirm a device reply.</p>}
  </fieldset>
}
