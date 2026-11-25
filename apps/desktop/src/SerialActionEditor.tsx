import { useI18n } from './i18n/I18nProvider'
import { open } from '@tauri-apps/plugin-dialog'
import InputValueEditor from './InputValueEditor'
import type { InputValueWire } from './inputValue'
import type { ToolInstance } from './ToolSetupEditor'
import type { BackgroundConfig, ToolActionStep, WorkflowStep } from './workflow'

/** Editor only: Serial encoding and job validation are owned by Core. */
export default function SerialActionEditor({ step, instances, backgrounds, earlierSteps, earlierVariables,
  disabled, onChange, stepLabel, showStepHelp = true }: {
  step: ToolActionStep; instances: ToolInstance[]; backgrounds?: readonly BackgroundConfig[]; earlierSteps: WorkflowStep[]
  earlierVariables: string[]; disabled: boolean
  onChange: (step: ToolActionStep) => void; stepLabel: (step: WorkflowStep) => string
  showStepHelp?: boolean
}) {
  const { t } = useI18n()
  const change = (key: string, value: unknown) =>
    onChange({ ...step, arguments: { ...step.arguments, [key]: value } })
  const updateTx = (value: InputValueWire) => {
    const bindings = { ...step.bindings }
    const arguments_ = { ...step.arguments }
    if (value.source === 'literal') {
      arguments_.tx_value = value.value
      delete bindings.tx_value
    } else {
      bindings.tx_value = value
    }
    const next: ToolActionStep = { ...step, arguments: arguments_, bindings }
    if (Object.keys(bindings).length === 0) delete next.bindings
    onChange(next)
  }
  const txFormat = step.arguments.tx_format === 'hex-byte' ? 'hex-byte' : 'text'
  const txValue = step.bindings?.tx_value ??
    { source: 'literal' as const, value: step.arguments.tx_value ?? (txFormat === 'text' ? '' : 0) }
  const changeMode = (mode: string) => {
    const args: Record<string, unknown> = { ...step.arguments, tx_format: mode }
    if (!step.bindings?.tx_value) {
      args.tx_value = mode === 'text' ? '' : 0
    }
    onChange({ ...step, arguments: args })
  }
  const hasTx = step.action === 'send' || step.action === 'query'
  const hasRx = step.action === 'receive' || step.action === 'query'
  const receiveMode = String(step.arguments.receive_mode ??
    (step.action === 'receive' ? 'single' : 'delimiter'))
  return <div className="step-properties-fields">
    {showStepHelp && <p className="value-source-help">{t(`steps.hint.serial-${step.action}`)}</p>}
    {hasTx && <>
      <label className="step-property-field">
        <span className="step-property-label">{t("serialActionEditor.tXFormat")}</span>
        <select aria-label={t("serialActionEditor.tXFormat")} disabled={disabled} value={txFormat}
          onChange={event => changeMode(event.target.value)}>
          <option value="text">{t("serialActionEditor.textUTF8String")}</option>
          <option value="hex-byte">{t("serialActionEditor.hexByteOneByte")}</option>
        </select>
      </label>
      <p className="value-source-help">{txFormat === 'text'
        ? t("serialActionEditor.textSendsUTF8BytesOfAStringOnly")
        : t("serialActionEditor.hexByteInteger0FixedValuesMustBeIntegers")}</p>
      <p className="value-source-help">{t(txFormat === 'text'
        ? "serialActionEditor.textSourceTypes"
        : "serialActionEditor.hexSourceTypes")}</p>
      <InputValueEditor key={`${step.id}-tx`}
        value={txValue} literalDefault={txFormat === 'text' ? '' : 0}
        allowStringLiteral={txFormat === 'text'}
        numericCalculation={txFormat === 'hex-byte'}
        sourceLabel={t("serialActionEditor.tXSource")} literalLabel={t("serialActionEditor.tXValue")}
        earlierSteps={earlierSteps} earlierVariables={earlierVariables}
        instances={instances} backgrounds={backgrounds} stepLabel={stepLabel} disabled={disabled}
        onChange={updateTx} />
    </>}
    {step.action === 'send-file' && <>
      <label className="step-property-field">
        <span className="step-property-label">{t("serialActionEditor.absoluteFilePathWorkerLocal")}</span>
        <input type="text" disabled={disabled} value={String(step.arguments.path ?? '')}
          onChange={event => change('path', event.target.value)} />
      </label>
      <button type="button" className="action-button" disabled={disabled}
        onClick={async () => {
          const picked = await open({ directory: false, multiple: false, title: t("serialActionEditor.selectSerialFileToSend") })
          if (typeof picked === 'string') change('path', picked)
        }}>{t("serialActionEditor.browseFile")}</button>
      <p className="value-source-help">{t("serialActionEditor.theAbsolutePathIsStoredInTheTemplateMissing")}</p>
    </>}
    {hasRx && <>
      <label className="step-property-field">
        <span className="step-property-label">{t("serialActionEditor.receiveMode")}</span>
        <select aria-label={t("serialActionEditor.receiveMode")} disabled={disabled} value={receiveMode}
          onChange={event => change('receive_mode', event.target.value)}>
          {step.action === 'receive' && <option value="single">{t("serialActionEditor.mode.single")}</option>}
          <option value="delimiter">{t("serialActionEditor.mode.delimiter")}</option>
          <option value="fixed">{t("serialActionEditor.mode.fixed")}</option>
          <option value="idle">{t("serialActionEditor.mode.idle")}</option>
        </select>
      </label>
      <p className="value-source-help">{t(`serialActionEditor.modeHelp.${receiveMode}`)}</p>
    </>}
    {hasRx && receiveMode === 'delimiter' && <>
      <label className="step-property-field">
        <span className="step-property-label">{t("serialActionEditor.delimiterFormat")}</span>
        <select aria-label={t("serialActionEditor.delimiterFormat")} disabled={disabled}
          value={String(step.arguments.delimiter_format ?? 'text')}
          onChange={event => change('delimiter_format', event.target.value)}>
          <option value="text">{t("serialActionEditor.text")}</option>
          <option value="hex">{t("serialActionEditor.hexBytes")}</option>
        </select>
      </label>
      <label className="step-property-field">
        <span className="step-property-label">{t("serialActionEditor.delimiterValue")}</span>
        <input type="text" disabled={disabled}
          value={String(step.arguments.delimiter_value ?? '')}
          onChange={event => change('delimiter_value', event.target.value)} />
      </label>
      <p className="value-source-help">{t("serialActionEditor.delimiterMayContainMultipleBytesTextSupportsRN")}</p>
    </>}
    {hasRx && receiveMode === 'fixed' && <>
      <label className="step-property-field">
        <span className="step-property-label">{t("serialActionEditor.expectedRXBytes")}</span>
        <input type="number" min={1} max={1048576} step={1} disabled={disabled}
          value={step.arguments.expected_bytes == null ? '' : String(step.arguments.expected_bytes)}
          onChange={event => change('expected_bytes', event.currentTarget.value === ''
            ? null : Number(event.currentTarget.value))} />
      </label>
      <p className="value-source-help">{t("serialActionEditor.expectedRXBytesHelp")}</p>
    </>}
    {hasRx && receiveMode === 'idle' && <>
      <label className="step-property-field">
        <span className="step-property-label">{t("serialActionEditor.idleGapMs")}</span>
        <input type="number" min={1} step={1} disabled={disabled}
          value={step.arguments.idle_gap_ms == null ? '' : String(step.arguments.idle_gap_ms)}
          onChange={event => change('idle_gap_ms', event.currentTarget.value === ''
            ? null : Number(event.currentTarget.value))} />
      </label>
      <p className="value-source-help">{t("serialActionEditor.idleGapHelp")}</p>
    </>}
    {hasRx && receiveMode !== 'fixed' && <>
      <label className="step-property-field">
        <span className="step-property-label">{t("serialActionEditor.maxBytes11048576")}</span>
        <input type="number" min={1} max={1048576} step={1} disabled={disabled}
          value={Number(step.arguments.max_bytes ?? 1024)}
          onChange={event => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isInteger(value)) change('max_bytes', value)
          }} />
      </label>
      <p className="value-source-help">{t("serialActionEditor.maxRXBytesHelp")}</p>
    </>}
    {hasRx && <>
      <label className="step-property-field step-property-checkbox">
        <input type="checkbox" disabled={disabled}
          checked={step.arguments.enable_rx_text === true}
          onChange={event => change('enable_rx_text', event.target.checked)} />
        <span className="step-property-label">{t("serialActionEditor.enableRXText")}</span>
      </label>
      <p className="value-source-help">{t("serialActionEditor.enableRXTextHelp")}</p>
    </>}
    {hasRx && <>
      <label className="step-property-field step-property-checkbox">
        <input type="checkbox" disabled={disabled}
          checked={step.arguments.fail_on_read_timeout === true}
          onChange={event => change('fail_on_read_timeout', event.target.checked)} />
        <span className="step-property-label">{t("serialActionEditor.failOnReadTimeout")}</span>
      </label>
      <p className="value-source-help">{t(step.arguments.fail_on_read_timeout === true
        ? 'serialActionEditor.timeoutHelp.checked' : 'serialActionEditor.timeoutHelp.unchecked')}</p>
      <p className="value-source-help">{t("serialActionEditor.failOnReadTimeoutHelp")}</p>
    </>}
  </div>
}
