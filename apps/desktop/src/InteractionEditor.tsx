import { useI18n } from './i18n/I18nProvider'
import { useId, useState } from 'react'
import { allWorkflowSteps, inputScope, loopPath, type BackgroundConfig, type InteractionOperation, type InteractionSettings, type InteractionStep, type WorkflowStep } from './workflow'
import { ProcessOperandEditor } from './InputValueEditor'
import SerialActionEditor from './SerialActionEditor'
import type { ToolInstance } from './ToolSetupEditor'

export function InteractionSettingsEditor({ value, disabled, hasBackground, onChange }: {
  value: InteractionSettings; disabled: boolean; hasBackground: boolean
  onChange: (value: InteractionSettings) => void
}) {
  const { t } = useI18n()
  const helpId = useId()
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
      <label className="streaming-toggle"><input aria-describedby={helpId + '-enableHelp'} type="checkbox" checked={value.enabled} disabled={disabled}
        onChange={event => onChange({ ...value, enabled: event.target.checked, buffer: { ...value.buffer, enabled: event.target.checked && value.buffer.enabled } })} /> {t("interactionEditor.enableFGBGInteraction")}</label>
      <p id={helpId + '-enableHelp'} className="value-source-help">{t('interactionEditor.enableHelp')}</p>
      <label className="step-property-field">{t("interactionEditor.maxActiveCommandStatus")}<input aria-describedby={helpId + '-sharedByAllBackgroundsInThisRunCompletedSettled'} type="number" min={1} max={65536} step={1} required
          value={value.max_active_command_status} disabled={disabled || !value.enabled}
          onChange={event => onChange({ ...value, max_active_command_status: Number(event.target.value) })} />
      </label>
      <p id={helpId + '-sharedByAllBackgroundsInThisRunCompletedSettled'} className="value-source-help">{t("interactionEditor.sharedByAllBackgroundsInThisRunCompletedSettled")}</p>
      <label className="streaming-toggle"><input aria-describedby={helpId + '-bufferEnableHelp'} type="checkbox" checked={value.buffer.enabled}
        disabled={disabled || !value.enabled} onChange={event => onChange({ ...value, buffer: { ...value.buffer, enabled: event.target.checked } })} /> {t('interactionEditor.enableBuffer')}</label>
      <p id={helpId + '-bufferEnableHelp'} className="value-source-help">{t('interactionEditor.bufferEnableHelp')}</p>
      {value.buffer.enabled && <>
        <div className="workflow-help-group"><span className="step-property-label">{t('interactionEditor.capacityLabel')}</span><strong>1024 Events · 16 MiB</strong><p className="value-source-help">{t('interactionEditor.bufferLimits')}</p></div>
        <label className="step-property-field">{t('interactionEditor.bufferMode')}<select aria-describedby={helpId + '-mode'} disabled={disabled || !value.enabled} value={value.buffer.mode}
          onChange={event => onChange({ ...value, buffer: { ...value.buffer, mode: event.target.value as 'fifo' | 'ring' } })}>
          <option value="fifo">FIFO</option><option value="ring">Ring Buffer</option>
        </select></label>
        <p id={helpId + '-mode'} className="value-source-help">{t(`interactionEditor.modeHelp.${value.buffer.mode}`)}</p>
        <label className="step-property-field">{t('interactionEditor.overflowPolicy')}<select aria-describedby={helpId + '-overflow'} disabled={disabled || !value.enabled} value={value.buffer.overflow_policy}
          onChange={event => onChange({ ...value, buffer: { ...value.buffer, overflow_policy: event.target.value as 'fail-run' | 'continue' } })}>
          <option value="fail-run">{t('interactionEditor.failRun')}</option><option value="continue">{t('interactionEditor.continue')}</option>
        </select></label>
        <p id={helpId + '-overflow'} className="value-source-help">{t(`interactionEditor.overflowHelp.${value.buffer.overflow_policy}`)}</p>
        <p className="value-source-help">{t('interactionEditor.oversizeHelp')}</p>
      </>}
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
  const helpId = useId()
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
    <label className="step-property-field"><span className="step-property-label">{t("interactionEditor.background")}</span><select aria-describedby={helpId + '-backgroundHelp'} value={step.background_id} onChange={event => onChange({ ...step, background_id: event.target.value })}>
      {backgrounds.map(b => <option key={b.id} value={b.id}>{b.id} · {b.tool_instance_id}</option>)}
    </select></label>
    <p id={helpId + '-backgroundHelp'} className="value-source-help">{t('interactionEditor.backgroundHelp')}</p>
    {step.operation.kind === 'command' && <>
      <label className="step-property-field"><span className="step-property-label">{t("interactionEditor.command")}</span><select value={step.operation.command} onChange={event => selectCommand(event.target.value as 'software-trigger' | 'serial-send' | 'serial-send-file')}>
        {!supported && <option value={step.operation.command}>{step.operation.command.replace(/[a-z]/i, letter => letter.toUpperCase())} {t("interactionEditor.unsupportedBackground")}</option>}
        {tool === 'serial' && <><option value="serial-send">{t("interactionEditor.send")}</option><option value="serial-send-file">{t("interactionEditor.sendFile")}</option></>}
        {tool === 'meters' && <option value="software-trigger">{t("interactionEditor.softwareTrigger")}</option>}
      </select></label>
      {!supported && <p role="alert">{t("interactionEditor.thisCommandDoesNotMatchTheSelectedBackgroundSelect")}</p>}
      {step.operation.command === 'software-trigger' && <p className="value-source-help">{t("interactionEditor.softwareTriggerMetersSoftwareSimpleSelectTriggerWithBG")}</p>}
      {operation.kind === 'command' && operation.command !== 'software-trigger' && <SerialActionEditor
        key={step.id} step={{ type: 'tool-action', id: step.id, target: instanceId ?? '',
          action: operation.command === 'serial-send' ? 'send' : 'send-file', arguments: operation.arguments,
          ...(operation.bindings ? { bindings: operation.bindings } : {}) }}
        instances={instances} backgrounds={backgrounds} earlierSteps={earlierSteps} earlierVariables={earlierVariables}
        disabled={disabled || !supported} stepLabel={value => value.id}
        onChange={value => onChange({ ...step, operation: { ...operation, arguments: value.arguments,
          bindings: value.bindings } })} />}
      <label className="step-property-field step-property-checkbox"><input aria-describedby={helpId + '-completion'} type="checkbox" checked={step.operation.wait_for_completion} onChange={event => {
        if (step.operation.kind === 'command') onChange({ ...step, operation: { ...step.operation, wait_for_completion: event.target.checked } })
      }} /><span className="step-property-label">{t("interactionEditor.waitForCompletion")}</span></label>
      <p id={helpId + '-completion'} className="value-source-help">{t(step.operation.wait_for_completion ? 'interactionEditor.waitCompletedHelp' : 'interactionEditor.waitAcceptedHelp')}</p>
      <p className="value-source-help">{t('interactionEditor.commandOutputHelp')}</p>
    </>}
    {step.operation.kind === 'get-command-result' && <><label className="step-property-field"><span className="step-property-label">{t("interactionEditor.sourceBGCommandStep")}</span><select aria-describedby={helpId + '-sourceCommandHelp'} value={step.operation.source_step}
      onChange={event => onChange({ ...step, operation: { kind: 'get-command-result', source_step: event.target.value } })}>
      <option value="">{t("interactionEditor.selectABGCommandStep")}</option>
      {sources.map(source => <option key={source.id} value={source.id}>{source.id}</option>)}
    </select></label><p id={helpId + '-sourceCommandHelp'} className="value-source-help">{t('interactionEditor.sourceCommandHelp')}</p></>}
    {operation.kind === 'get-buffer-data' && <>
      <label className="step-property-field">{t('interactionEditor.readMode')}<select aria-describedby={helpId + '-readMode'} value={operation.read_mode}
        onChange={event => onChange({ ...step, operation: { ...operation, read_mode: event.target.value as 'peek' | 'pop' } })}>
        <option value="peek">Peek</option><option value="pop">Pop</option>
      </select></label>
      <p id={helpId + '-readMode'} className="value-source-help">{t(`interactionEditor.readHelp.${operation.read_mode}`)}</p>
      <label className="step-property-field">{t('interactionEditor.getMode')}<select aria-describedby={helpId + '-selection'} value={operation.selection.kind}
        onChange={event => onChange({ ...step, operation: { ...operation, selection: event.target.value === 'all' ? { kind: 'all' } : { kind: 'count', count: { source: 'literal', value: 1 } } } })}>
        <option value="all">ALL</option><option value="count">{t('interactionEditor.count')}</option>
      </select></label>
      <p id={helpId + '-selection'} className="value-source-help">{t(`interactionEditor.selectionHelp.${operation.selection.kind}`)}</p>
      {operation.selection.kind === 'count' && <ProcessOperandEditor label={t('interactionEditor.count')} help={t('interactionEditor.countHelp')} literalDefault={1}
        value={operation.selection.count} earlierSteps={earlierSteps} earlierVariables={earlierVariables}
        instances={instances} backgrounds={backgrounds} stepLabel={item => item.id} disabled={disabled}
        onChange={count => onChange({ ...step, operation: { ...operation, selection: { kind: 'count', count } } })} />}
      <p className="value-source-help">{t('interactionEditor.bufferReadHelp')}</p>
      {tool === 'serial' && <p className="value-source-help">{t('interactionEditor.serialEventHelp')}</p>}
      <p className="value-source-help">{t('interactionEditor.bufferDataResult')}</p>
    </>}
    {operation.kind === 'get-buffer-status' && <p className="value-source-help">{t('interactionEditor.bufferStatusHelp')}</p>}
    {(operation.kind === 'get-latest' || operation.kind === 'wait-next') && tool === 'serial' && <p className="value-source-help">{t('interactionEditor.serialEventHelp')}</p>}
    {operation.kind !== 'get-buffer-data' && operation.kind !== 'get-buffer-status' && <>
    <label className="step-property-field"><span className="step-property-label">{t("interactionEditor.stepTimeoutMs")}</span><input aria-describedby={helpId + '-timeout'} type="number" min={1} step={1} placeholder={t("interactionEditor.useActionTimeout")}
      value={step.timeout_ms ?? ''} onChange={event => onChange({ ...step, timeout_ms: event.target.value === '' ? null : Number(event.target.value) })} /></label>
    <p id={helpId + '-timeout'} className="value-source-help">{t("interactionEditor.oneDeadlineCoversThisEntireStepWorkerMustBe")}</p></>}
    {tool === 'serial' && operation.kind === 'get-command-result' && <p className="value-source-help">{t("interactionEditor.getCommandResultReturnsTheCompleteNativeJobFinished")}</p>}
    </div>
  </fieldset>
}
