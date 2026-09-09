import { EXPRESSION_OPERATORS } from './inputValue'
import type { ExpressionOperandWire, InputValueWire } from './inputValue'

type ReferenceOptions = {
  earlierSteps: readonly { id: string }[]
  earlierVariables: readonly string[]
  disabled: boolean
}

type OperandEditorProps = ReferenceOptions & {
  value: ExpressionOperandWire
  onChange: (value: ExpressionOperandWire) => void
  literalLabel?: string
}

function OperandEditor({ value, onChange, earlierSteps, earlierVariables, disabled, literalLabel = 'Value' }: OperandEditorProps) {
  switch (value.source) {
    case 'literal':
      return typeof value.value === 'number' ? (
        <label className="step-property-field">
          <span className="step-property-label">{literalLabel}</span>
          <input type="number" step="any" value={value.value} disabled={disabled}
            onChange={(event) => {
              const number = event.currentTarget.valueAsNumber
              if (Number.isFinite(number)) onChange({ source: 'literal', value: number })
            }} />
        </label>
      ) : (
        <>
          <p className="step-properties-empty">
            Value preserved (only numeric literals are editable): {JSON.stringify(value.value)}
          </p>
          <button className="action-button" type="button" disabled={disabled}
            onClick={() => onChange({ source: 'literal', value: 0 })}>
            Replace with numeric literal
          </button>
        </>
      )
    case 'variable':
      return (
        <>
          <label className="step-property-field">
            <span className="step-property-label">Referenced Variable</span>
            <select value={earlierVariables.includes(value.variable) ? value.variable : ''}
              disabled={disabled || earlierVariables.length === 0}
              onChange={(event) => onChange({ source: 'variable', variable: event.target.value })}>
              <option value="" disabled>Select an earlier variable...</option>
              {earlierVariables.map((variable) => <option key={variable} value={variable}>{variable}</option>)}
            </select>
          </label>
          {!earlierVariables.includes(value.variable) && (
            <p className="step-properties-empty">Reference preserved: {value.variable} is not defined by an earlier Set Variable step.</p>
          )}
        </>
      )
    case 'step-output':
      return (
        <>
          <label className="step-property-field">
            <span className="step-property-label">Step</span>
            <select value={earlierSteps.some((step) => step.id === value.step_id) ? value.step_id : ''}
              disabled={disabled || earlierSteps.length === 0}
              onChange={(event) => onChange({ ...value, step_id: event.target.value })}>
              <option value="" disabled>Select an earlier step...</option>
              {earlierSteps.map((step) => <option key={step.id} value={step.id}>{step.id}</option>)}
            </select>
          </label>
          {!earlierSteps.some((step) => step.id === value.step_id) && (
            <p className="step-properties-empty">Reference preserved: {value.step_id} is not an earlier step. Validate to check it.</p>
          )}
          <label className="step-property-field">
            <span className="step-property-label">Pointer</span>
            <input type="text" value={value.pointer} disabled={disabled}
              onChange={(event) => onChange({ ...value, pointer: event.target.value })} />
          </label>
        </>
      )
  }
}

function SourceOptions({ earlierSteps, earlierVariables }: ReferenceOptions) {
  return (
    <>
      <option value="literal">Literal</option>
      <option value="variable" disabled={earlierVariables.length === 0}>Variable</option>
      <option value="step-output" disabled={earlierSteps.length === 0}>Step Output</option>
    </>
  )
}

type InputValueEditorProps = ReferenceOptions & {
  value: InputValueWire
  onChange: (value: InputValueWire) => void
  sourceLabel?: string
  literalLabel?: string
  literalDefault?: number
}

export default function InputValueEditor({ value, onChange, sourceLabel = 'Source', literalLabel,
  literalDefault = 0, ...references }: InputValueEditorProps) {
  const defaultOperand = (source: string, literal = 0): ExpressionOperandWire => {
    switch (source) {
      case 'variable': return { source, variable: references.earlierVariables[0] }
      case 'step-output': return { source, step_id: references.earlierSteps[0].id, pointer: '/value' }
      default: return { source: 'literal', value: literal }
    }
  }

  const operandEditor = (side: 'left' | 'right') => value.source === 'expression' && (
    <div className="step-properties-fields" role="group" aria-label={`${side === 'left' ? 'Left' : 'Right'} operand`}>
      <label className="step-property-field">
        <span className="step-property-label">{side === 'left' ? 'Left' : 'Right'} Source</span>
        <select value={value[side].source} disabled={references.disabled}
          onChange={(event) => onChange({ ...value, [side]: defaultOperand(event.target.value) })}>
          <SourceOptions {...references} />
        </select>
      </label>
      <OperandEditor {...references} value={value[side]}
        onChange={(operand) => onChange({ ...value, [side]: operand })} />
    </div>
  )

  return (
    <>
      <label className="step-property-field">
        <span className="step-property-label">{sourceLabel}</span>
        <select value={value.source} disabled={references.disabled}
          onChange={(event) => onChange(event.target.value === 'expression'
            ? { source: 'expression', left: { source: 'literal', value: 0 }, operator: 'add', right: { source: 'literal', value: 0 } }
            : defaultOperand(event.target.value, literalDefault))}>
          <SourceOptions {...references} />
          <option value="expression">Expression</option>
        </select>
      </label>
      {value.source === 'expression' ? (
        <div className="step-properties-fields" role="group" aria-label="Expression">
          <span className="step-property-label">Expression</span>
          {operandEditor('left')}
          <label className="step-property-field">
            <span className="step-property-label">Operator</span>
            <select value={value.operator} disabled={references.disabled}
              onChange={(event) => onChange({ ...value, operator: event.target.value as typeof value.operator })}>
              {Object.entries(EXPRESSION_OPERATORS).map(([operator, symbol]) => (
                <option key={operator} value={operator}>{symbol}</option>
              ))}
            </select>
          </label>
          {operandEditor('right')}
        </div>
      ) : (
        <OperandEditor {...references} value={value} literalLabel={literalLabel} onChange={onChange} />
      )}
    </>
  )
}
