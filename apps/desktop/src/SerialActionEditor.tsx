import { open } from '@tauri-apps/plugin-dialog'
import InputValueEditor from './InputValueEditor'
import type { InputValueWire } from './inputValue'
import type { ToolInstance } from './ToolSetupEditor'
import type { ToolActionStep, WorkflowStep } from './workflow'

/** Editor only: Serial encoding and job validation are owned by Core. */
export default function SerialActionEditor({ step, instances, earlierSteps, earlierVariables,
  disabled, onChange, stepLabel }: {
  step: ToolActionStep; instances: ToolInstance[]; earlierSteps: WorkflowStep[]
  earlierVariables: string[]; disabled: boolean
  onChange: (step: ToolActionStep) => void; stepLabel: (step: WorkflowStep) => string
}) {
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
    const args = { ...step.arguments, tx_format: mode }
    if (!step.bindings?.tx_value) {
      args.tx_value = mode === 'text' ? '' : 0
    }
    onChange({ ...step, arguments: args })
  }
  const hasTx = step.action === 'send' || step.action === 'query'
  return <div className="step-properties-fields">
    {hasTx && <>
      <label className="step-property-field">
        <span className="step-property-label">TX Format</span>
        <select aria-label="TX Format" disabled={disabled} value={txFormat}
          onChange={event => changeMode(event.target.value)}>
          <option value="text">Text (UTF-8 string)</option>
          <option value="hex-byte">Hex Byte (one byte)</option>
        </select>
      </label>
      <p className="value-source-help">{txFormat === 'text'
        ? 'Text sends UTF-8 bytes of a string only. "00FF" sends four ASCII characters, not 00 FF.'
        : 'Hex Byte sends one byte from a non-negative integer. High bytes are discarded (4660 → 34). Negative, fractional, string, and Boolean values fail this step.'}</p>
      <InputValueEditor key={`${step.id}-tx`}
        value={txValue} literalDefault={txFormat === 'text' ? '' : 0}
        allowStringLiteral={txFormat === 'text'}
        sourceLabel="TX Source" literalLabel="TX Value"
        earlierSteps={earlierSteps} earlierVariables={earlierVariables}
        instances={instances} stepLabel={stepLabel} disabled={disabled}
        onChange={updateTx} />
    </>}
    {step.action === 'send-file' && <>
      <label className="step-property-field">
        <span className="step-property-label">Absolute File Path (Worker-local)</span>
        <input type="text" disabled={disabled} value={String(step.arguments.path ?? '')}
          onChange={event => change('path', event.target.value)} />
      </label>
      <button type="button" className="action-button" disabled={disabled}
        onClick={async () => {
          const picked = await open({ directory: false, multiple: false, title: 'Select Serial file to send' })
          if (typeof picked === 'string') change('path', picked)
        }}>Browse File</button>
      <p className="value-source-help">The absolute path is stored in the Template. Missing files warn on Template load and block Run before any Worker starts.</p>
    </>}
    {step.action === 'query' && <>
      <label className="step-property-field">
        <span className="step-property-label">Delimiter Format</span>
        <select aria-label="Delimiter Format" disabled={disabled}
          value={String(step.arguments.delimiter_format ?? 'text')}
          onChange={event => change('delimiter_format', event.target.value)}>
          <option value="text">Text</option>
          <option value="hex">Hex Bytes</option>
        </select>
      </label>
      <label className="step-property-field">
        <span className="step-property-label">Delimiter Value</span>
        <input type="text" disabled={disabled}
          value={String(step.arguments.delimiter_value ?? '')}
          onChange={event => change('delimiter_value', event.target.value)} />
      </label>
      <p className="value-source-help">Delimiter may contain multiple bytes: Text supports \\r, \\n and \\\\ escapes; Hex accepts pairs of digits (e.g. 0D 0A). It is independent of TX Hex Byte.</p>
    </>}
    {(step.action === 'receive' || step.action === 'query') && <label className="step-property-field">
      <span className="step-property-label">Max Bytes (1–1048576)</span>
      <input type="number" min={1} max={1048576} step={1} disabled={disabled}
        value={Number(step.arguments.max_bytes ?? 1024)}
        onChange={event => {
          const value = event.currentTarget.valueAsNumber
          if (Number.isInteger(value)) change('max_bytes', value)
        }} />
    </label>}
  </div>
}
