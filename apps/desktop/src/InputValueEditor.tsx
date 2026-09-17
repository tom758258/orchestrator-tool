import { useState } from 'react'
import {
  CUSTOM_RESULT,
  EXPRESSION_OPERATORS,
  curatedResultFields,
  resultSelection,
  stepOutputCandidates,
  stepOutputReference,
} from './inputValue'
import type { CuratedResultField, ExpressionOperandWire, InputValueWire } from './inputValue'
import type { WorkflowStep } from './App'
import type { ToolInstance } from './ToolSetupEditor'

type ReferenceOptions = {
  earlierSteps: readonly WorkflowStep[]
  instances: readonly ToolInstance[]
  stepLabel: (step: WorkflowStep) => string
  earlierVariables: readonly string[]
  disabled: boolean
}

const SOURCE_HELP = {
  'elapsed-time': 'Elapsed time since Workflow execution started, in seconds.',
  timestamp: 'Current UTC+08:00 timestamp with millisecond precision.',
  literal: 'Enter a value directly.',
  variable: 'Use an available variable or the enclosing For loop variable.',
  'step-output': 'Use data produced by an earlier step.',
  expression: 'Calculate a value from fixed values, variables, or previous step results.',
}

type OperandEditorProps = ReferenceOptions & {
  value: ExpressionOperandWire
  onChange: (value: ExpressionOperandWire) => void
  literalLabel?: string
}

function ResultPathEditor({ value, onChange, fields, disabled }: {
  value: Extract<ExpressionOperandWire, { source: 'step-output' }>
  onChange: (value: ExpressionOperandWire) => void
  fields: readonly CuratedResultField[]
  disabled: boolean
}) {
  const [customPointer, setCustomPointer] = useState(() => resultSelection(value.pointer, fields) === CUSTOM_RESULT)
  const result = customPointer ? CUSTOM_RESULT : resultSelection(value.pointer, fields)

  return (
    <>
      <label className="step-property-field">
        <span className="step-property-label">Result</span>
        <select value={result} disabled={disabled} onChange={(event) => {
          const pointer = event.target.value
          setCustomPointer(pointer === CUSTOM_RESULT)
          if (pointer !== CUSTOM_RESULT) onChange({ ...value, pointer })
        }}>
          {fields.map(field => <option key={field.pointer} value={field.pointer}>{field.label}</option>)}
          <option value={CUSTOM_RESULT}>Custom pointer...</option>
        </select>
      </label>
      {result === CUSTOM_RESULT && (
        <>
          <label className="step-property-field">
            <span className="step-property-label">JSON Pointer</span>
            <input type="text" value={value.pointer} disabled={disabled}
              onChange={(event) => onChange({ ...value, pointer: event.target.value })} />
          </label>
          <p className="value-source-help">Use a JSON Pointer such as /value. Leave empty for the complete result.</p>
        </>
      )}
    </>
  )
}

function OperandEditor({ value, onChange, earlierSteps, instances, stepLabel, earlierVariables, disabled, literalLabel = 'Value' }: OperandEditorProps) {
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
            Value preserved (only numeric fixed values are editable): {JSON.stringify(value.value)}
          </p>
          <button className="action-button" type="button" disabled={disabled}
            onClick={() => onChange({ source: 'literal', value: 0 })}>
            Replace with numeric fixed value
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
              <option value="" disabled>Select an available variable...</option>
              {earlierVariables.map((variable) => <option key={variable} value={variable}>{variable}</option>)}
            </select>
          </label>
          {!earlierVariables.includes(value.variable) && (
            <p className="step-properties-empty">Reference preserved: {value.variable} is not among the variable suggestions for this scope.</p>
          )}
        </>
      )
    case 'step-output': {
      const candidates = stepOutputCandidates(earlierSteps)
      const previousStep = earlierSteps.find((step) => step.id === value.step_id)
      const fields = curatedResultFields(previousStep, instances)
      return (
        <>
          <label className="step-property-field">
            <span className="step-property-label">Step</span>
            <select value={candidates.some((step) => step.id === value.step_id) ? value.step_id : ''}
              disabled={disabled || candidates.length === 0}
              onChange={(event) => {
                const step = candidates.find(candidate => candidate.id === event.target.value)
                if (step) onChange(stepOutputReference(step, instances))
              }}>
              <option value="" disabled>Select an earlier step...</option>
              {candidates.map((step) => <option key={step.id} value={step.id}>{stepLabel(step)} ({step.id})</option>)}
            </select>
          </label>
          {!candidates.some((step) => step.id === value.step_id) && (
            <p className="step-properties-empty">Reference preserved: {value.step_id} is not an eligible earlier Tool Action. Validate to check it.</p>
          )}
          <ResultPathEditor key={value.step_id} value={value} onChange={onChange}
            fields={fields} disabled={disabled} />
        </>
      )
    }
  }
}

function SourceOptions({ earlierSteps, earlierVariables }: ReferenceOptions) {
  const hasStepOutput = stepOutputCandidates(earlierSteps).length > 0
  return (
    <>
      <option value="literal">Fixed value</option>
      <option value="variable" disabled={earlierVariables.length === 0}>Variable</option>
      <option value="step-output" disabled={!hasStepOutput}>Previous step result</option>
    </>
  )
}

function defaultOperand(source: string, references: ReferenceOptions, literal = 0): ExpressionOperandWire {
  switch (source) {
    case 'variable': return { source, variable: references.earlierVariables[0] }
    case 'step-output': return stepOutputReference(stepOutputCandidates(references.earlierSteps)[0], references.instances)
    default: return { source: 'literal', value: literal }
  }
}

export function ExpressionOperandEditor({ value, onChange, side, ...references }: OperandEditorProps & { side: 'Left' | 'Right' }) {
  return (
    <div className="step-properties-fields" role="group" aria-label={`${side} operand`}>
      <label className="step-property-field">
        <span className="step-property-label">{side} Source</span>
        <select value={value.source} disabled={references.disabled}
          onChange={(event) => onChange(defaultOperand(event.target.value, references))}>
          <SourceOptions {...references} />
        </select>
      </label>
      <p className="value-source-help">{SOURCE_HELP[value.source]}</p>
      <OperandEditor {...references} value={value} onChange={onChange} />
    </div>
  )
}

type InputValueEditorProps = ReferenceOptions & {
  value: InputValueWire
  onChange: (value: InputValueWire) => void
  sourceLabel?: string
  literalLabel?: string
  literalDefault?: number
}

export default function InputValueEditor({ value, onChange, sourceLabel = 'Value Source', literalLabel,
  literalDefault = 0, ...references }: InputValueEditorProps) {
  const operandEditor = (side: 'left' | 'right') => value.source === 'expression' && (
    <ExpressionOperandEditor {...references} side={side === 'left' ? 'Left' : 'Right'} value={value[side]}
      onChange={(operand) => onChange({ ...value, [side]: operand })} />
  )

  return (
    <>
      <label className="step-property-field">
        <span className="step-property-label">{sourceLabel}</span>
        <select value={value.source} disabled={references.disabled}
          onChange={(event) => onChange(event.target.value === 'expression'
            ? { source: 'expression', left: { source: 'literal', value: 0 }, operator: 'add', right: { source: 'literal', value: 0 } }
            : event.target.value === 'elapsed-time' || event.target.value === 'timestamp'
              ? { source: event.target.value }
              : defaultOperand(event.target.value, references, literalDefault))}>
          <SourceOptions {...references} />
          <option value="expression">Calculation</option>
          <option value="elapsed-time">Elapsed time</option>
          <option value="timestamp">Timestamp</option>
        </select>
      </label>
      <p className="value-source-help">{SOURCE_HELP[value.source]}</p>
      {value.source === 'expression' ? (
        <div className="step-properties-fields" role="group" aria-label="Calculation">
          <span className="step-property-label">Calculation</span>
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
        value.source !== 'elapsed-time' && value.source !== 'timestamp' &&
        <OperandEditor {...references} value={value} literalLabel={literalLabel} onChange={onChange} />
      )}
    </>
  )
}
