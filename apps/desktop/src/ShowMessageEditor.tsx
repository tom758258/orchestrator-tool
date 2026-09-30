import {
  MAX_MESSAGE_FIELDS,
  MAX_MESSAGE_TEXT_CHARS,
  MESSAGE_TARGETS,
  MESSAGE_TARGET_LABELS,
  composeMessageText,
  limitMessageText,
  showMessageOutputCandidates,
} from './workflow'
import type { MessageFieldWire, MessageTargetWire, OutputStep, ShowMessageStep } from './workflow'

type Props = {
  step: ShowMessageStep
  outputs: readonly OutputStep[]
  disabled: boolean
  onChange: (step: ShowMessageStep) => void
}

const textField = (text: string, newline: boolean): MessageFieldWire =>
  ({ kind: 'text', text, newline })
const outputField = (stepId: string, newline: boolean): MessageFieldWire =>
  ({ kind: 'output', step_id: stepId, pointer: '', newline })

export default function ShowMessageEditor({ step, outputs, disabled, onChange }: Props) {
  const updateField = (index: number, field: MessageFieldWire) => onChange({
    ...step,
    fields: step.fields.map((current, position) => position === index ? field : current),
  })
  // The final field always ends the record, so it never needs a Newline checkbox.
  const replacesLast = (field: MessageFieldWire): MessageFieldWire =>
    step.fields.length === 1 ? { ...field, newline: false } : field
  const addField = () => {
    if (step.fields.length >= MAX_MESSAGE_FIELDS) return
    onChange({ ...step, fields: [...step.fields, textField('', false)] })
  }
  const removeField = (index: number) => {
    if (step.fields.length <= 1) return
    onChange({ ...step, fields: step.fields.filter((_, position) => position !== index) })
  }
  const setTarget = (target: MessageTargetWire) => onChange({ ...step, target })

  return (
    <div className="show-message-editor">
      <label className="step-property-field">
        <span className="step-property-label">Target Message</span>
        <select value={step.target} disabled={disabled}
          onChange={event => setTarget(event.target.value as MessageTargetWire)}>
          {MESSAGE_TARGETS.map(target => (
            <option key={target} value={target}>{MESSAGE_TARGET_LABELS[target]}</option>
          ))}
        </select>
      </label>

      {step.fields.map((field, index) => (
        <fieldset className="show-message-field" key={index}>
          <legend>Field {index + 1}</legend>
          <label className="step-property-field">
            <span className="step-property-label">Type</span>
            <select value={field.kind} disabled={disabled}
              onChange={event => updateField(index, replacesLast(
                event.target.value === 'output'
                  ? outputField(outputs[0]?.id ?? '', field.newline)
                  : textField(field.kind === 'text' ? field.text : '', field.newline)))}>
              <option value="text">String</option>
              <option value="output" disabled={outputs.length === 0}>Output</option>
            </select>
          </label>

          {field.kind === 'text'
            ? <label className="step-property-field">
                <span className="step-property-label">Text</span>
                <input type="text" value={field.text} disabled={disabled}
                  onChange={event => updateField(index,
                    textField(limitMessageText(event.target.value, MAX_MESSAGE_TEXT_CHARS),
                      field.newline))} />
                <span className="step-property-hint">
                  {Array.from(field.text).length} / {MAX_MESSAGE_TEXT_CHARS} characters
                </span>
              </label>
            : <label className="step-property-field">
                <span className="step-property-label">Output</span>
                <select value={field.step_id} disabled={disabled || outputs.length === 0}
                  onChange={event => updateField(index,
                    outputField(event.target.value, field.newline))}>
                  <option value="" disabled>Select an earlier Output...</option>
                  {outputs.map(output => <option key={output.id} value={output.id}>{output.name}</option>)}
                </select>
                {!outputs.some(output => output.id === field.step_id) && (
                  <p className="step-properties-empty">
                    Reference preserved: {field.step_id} is not an eligible earlier Output. Validate to check it.
                  </p>
                )}
              </label>}

          {index < step.fields.length - 1 && (
            <label className="step-property-field show-message-newline">
              <input type="checkbox" checked={field.newline} disabled={disabled}
                onChange={event => updateField(index, { ...field,
                  newline: event.target.checked })} />
              <span className="step-property-label">Newline after this field</span>
            </label>
          )}
          <button className="action-button" type="button" disabled={disabled || step.fields.length <= 1}
            onClick={() => removeField(index)}>Delete Field</button>
        </fieldset>
      ))}

      <button className="action-button" type="button" disabled={disabled || step.fields.length >= MAX_MESSAGE_FIELDS}
        onClick={addField}>Add Field</button>
      {step.fields.length >= MAX_MESSAGE_FIELDS && (
        <p className="step-properties-empty">A Show Message step supports up to {MAX_MESSAGE_FIELDS} fields.</p>
      )}

      <div className="show-message-preview">
        <span className="step-property-label">Message Preview</span>
        <pre>{composeMessageText(step.fields,
          stepId => outputs.find(output => output.id === stepId)?.name)}</pre>
      </div>
    </div>
  )
}
