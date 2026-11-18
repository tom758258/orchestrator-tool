import { useI18n } from './i18n/I18nProvider'
import { useState } from 'react'
import { allWorkflowSteps, inputScope, loopPath, type BackgroundConfig, type InteractionOperation, type InteractionSettings, type InteractionStep, type WorkflowStep } from './workflow'
import SerialActionEditor from './SerialActionEditor'
import type { ToolInstance } from './ToolSetupEditor'

export function InteractionSettingsEditor({ value, disabled, hasBackground, onChange }: {
  value: InteractionSettings; disabled: boolean; hasBackground: boolean
  onChange: (value: InteractionSettings) => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const open = hasBackground && expanded
  return <section className="streaming-panel" aria-label={t("interactionEditor.fGBGInteractionSettings")}>
    <h3><button type="button" className="collapsible-header"
      aria-label={t("interactionEditor.fGBGInteraction", { value1: open ? t("interactionEditor.collapse") : t("interactionEditor.expand") })}
      aria-expanded={open} disabled={!hasBackground}
      aria-describedby={!hasBackground ? 'fg-bg-interaction-hint' : undefined}
      onClick={() => setExpanded(current => !current)}>
      {t("interactionEditor.fGBGInteraction2")}<span aria-hidden="true">{!hasBackground ? '🔒' : open ? '−' : '+'}</span>
    </button></h3>
    {!hasBackground && <p className="step-category-hint" id="fg-bg-interaction-hint">
      {t("interactionEditor.noBackgroundBindingEnableBackgroundStreamingInSetup")}</p>}
    {open && <div className="interaction-settings-fields">
      <label className="streaming-toggle"><input type="checkbox" checked={value.enabled} disabled={disabled}
        onChange={event => onChange({ ...value, enabled: event.target.checked })} /> {t("interactionEditor.enableFGBGInteraction")}</label>
      <label className="step-property-field">{t("interactionEditor.maxActiveCommandStatus")}<input type="number" min={1} max={65536} step={1} required
          value={value.max_active_command_status} disabled={disabled || !value.enabled}
          onChange={event => onChange({ ...value, max_active_command_status: Number(event.target.value) })} />
      </label>
      <p className="tool-setup-hint">{t("interactionEditor.sharedByAllBackgroundsInThisRunCompletedSettled")}</p>
    </div>}
  </section>
}

type CommandOperation = Extract<InteractionOperation, { kind: 'command' }>
export type InteractionCommandDrafts = Partial<Record<CommandOperation['command'], CommandOperation>>

export function InteractionEditor({ step, steps, backgrounds, instances = [], disabled, savedCommands, onSaveCommand, onChange }: {
  step: InteractionStep; steps: WorkflowStep[]; backgrounds: BackgroundConfig[]; disabled: boolean; onChange: (step: InteractionStep) => void
  instances?: ToolInstance[]
  savedCommands: InteractionCommandDrafts; onSaveCommand: (operation: CommandOperation) => void
}) {
  const { t } = useI18n()
  const instanceId = backgrounds.find(b => b.id === step.background_id)?.tool_instance_id
  const tool = instances.find(i => i.id === instanceId)?.tool
  const operation = step.operation
  const supported = operation.kind !== 'command' || (tool === 'serial'
    ? operation.command !== 'software-trigger' : tool === 'meters' && operation.command === 'software-trigger')
  const { earlierSteps, earlierVariables } = inputScope(steps, step.id)
  const selectCommand = (command: 'software-trigger' | 'serial-send' | 'serial-send-file') => {
    if (operation.kind !== 'command') return
    onSaveCommand(operation)
    const saved = savedCommands[command]
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
  return <fieldset className="interaction-step-fieldset" disabled={disabled}>
    <legend>{t("interactionEditor.backgroundInteraction")}</legend>
    <div className="step-properties-fields interaction-step-fields">
    <label className="step-property-field"><span className="step-property-label">{t("interactionEditor.background")}</span><select value={step.background_id} onChange={event => onChange({ ...step, background_id: event.target.value })}>
      {backgrounds.map(b => <option key={b.id} value={b.id}>{b.id} · {b.tool_instance_id}</option>)}
    </select></label>
    {step.operation.kind === 'command' && <>
      <label className="step-property-field"><span className="step-property-label">{t("interactionEditor.command")}</span><select value={step.operation.command} onChange={event => selectCommand(event.target.value as 'software-trigger' | 'serial-send' | 'serial-send-file')}>
        {!supported && <option value={step.operation.command}>{step.operation.command} {t("interactionEditor.unsupportedBackground")}</option>}
        {tool === 'serial' && <><option value="serial-send">{t("interactionEditor.send")}</option><option value="serial-send-file">{t("interactionEditor.sendFile")}</option></>}
        {tool === 'meters' && <option value="software-trigger">{t("interactionEditor.softwareTrigger")}</option>}
      </select></label>
      {!supported && <p role="alert">{t("interactionEditor.thisCommandDoesNotMatchTheSelectedBackgroundSelect")}</p>}
      {step.operation.command === 'software-trigger' && <p>{t("interactionEditor.softwareTriggerMetersSoftwareSimpleSelectTriggerWithBG")}</p>}
      {operation.kind === 'command' && operation.command !== 'software-trigger' && <SerialActionEditor
        key={step.id} step={{ type: 'tool-action', id: step.id, target: instanceId ?? '',
          action: operation.command === 'serial-send' ? 'send' : 'send-file', arguments: operation.arguments,
          ...(operation.bindings ? { bindings: operation.bindings } : {}) }}
        instances={instances} backgrounds={backgrounds} earlierSteps={earlierSteps} earlierVariables={earlierVariables}
        disabled={disabled || !supported} stepLabel={value => value.id}
        onChange={value => onChange({ ...step, operation: { ...operation, arguments: value.arguments,
          bindings: value.bindings } })} />}
      <label className="step-property-field step-property-checkbox"><input type="checkbox" checked={step.operation.wait_for_completion} onChange={event => {
        if (step.operation.kind === 'command') onChange({ ...step, operation: { ...step.operation, wait_for_completion: event.target.checked } })
      }} /><span className="step-property-label">{t("interactionEditor.waitForCompletion")}</span></label>
    </>}
    {step.operation.kind === 'get-command-result' && <label className="step-property-field"><span className="step-property-label">{t("interactionEditor.sourceBGCommandStep")}</span><select value={step.operation.source_step}
      onChange={event => onChange({ ...step, operation: { kind: 'get-command-result', source_step: event.target.value } })}>
      <option value="">{t("interactionEditor.selectABGCommandStep")}</option>
      {sources.map(source => <option key={source.id} value={source.id}>{source.id}</option>)}
    </select></label>}
    <label className="step-property-field"><span className="step-property-label">{t("interactionEditor.stepTimeoutMs")}</span><input type="number" min={1} step={1} placeholder={t("interactionEditor.useActionTimeout")}
      value={step.timeout_ms ?? ''} onChange={event => onChange({ ...step, timeout_ms: event.target.value === '' ? null : Number(event.target.value) })} /></label>
    <p className="value-source-help">{t("interactionEditor.oneDeadlineCoversThisEntireStepWorkerMustBe")}</p>
    {tool === 'serial' && operation.kind === 'get-command-result' && <p className="value-source-help">{t("interactionEditor.getCommandResultReturnsTheCompleteNativeJobFinished")}</p>}
    </div>
  </fieldset>
}
