import type { Translate } from './i18n/index.ts'
const sourceHelp = (t: Translate) => ({
  'elapsed-time': t("inputValueEditor.elapsedTimeSinceWorkflowExecutionStartedInSeconds"),
  timestamp: t("inputValueEditor.currentUTC0800TimestampWithMillisecondPrecision"),
  literal: t("inputValueEditor.enterAValueDirectly"),
  variable: t("inputValueEditor.useAnAvailableVariableOrTheEnclosingForLoop"),
  'step-output': t("inputValueEditor.useDataProducedByAnEarlierStep"),
  expression: t("inputValueEditor.calculateAValueFromFixedValuesVariablesOrPrevious"),
})
import { useI18n } from './i18n/I18nProvider'
import { ELAPSED_TIME_FORMATS, type ElapsedTimeFormat, type OutputTimeFormat } from './outputTime'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { bindProcessStringTransfers, decodeProcessString, encodeProcessString } from './processString'
import { bindProcessStringHistory, syncProcessStringHistory } from './processStringHistory'
import {
  CUSTOM_RESULT,
  EXPRESSION_OPERATORS,
  UNARY_OPERATORS,
  curatedResultFields,
  resultSelection,
  stepOutputCandidates,
  stepOutputReference,
} from './inputValue'
import type { CuratedResultField, ExpressionOperandWire, InputValueWire } from './inputValue'
import type { WorkflowStep } from './App'
import type { BackgroundConfig } from './workflow'
import type { ToolInstance } from './ToolSetupEditor'

type ReferenceOptions = {
  earlierSteps: readonly WorkflowStep[]
  instances: readonly ToolInstance[]
  backgrounds?: readonly BackgroundConfig[]
  stepLabel: (step: WorkflowStep) => string
  earlierVariables: readonly string[]
  disabled: boolean
  numericSetpoint?: boolean
  numericCalculation?: boolean
  allowStringLiteral?: boolean
  allowNullLiteral?: boolean
  noLiteral?: boolean
}



type OperandEditorProps = ReferenceOptions & {
  value: ExpressionOperandWire
  onChange: (value: ExpressionOperandWire) => void
  literalLabel?: string
  allowBooleanLiteral?: boolean
  fixedStringLiteral?: boolean
}

function ResultPathEditor({ value, onChange, fields, disabled }: {
  value: Extract<ExpressionOperandWire, { source: 'step-output' }>
  onChange: (value: ExpressionOperandWire) => void
  fields: readonly CuratedResultField[]
  disabled: boolean
}) {
  const { t } = useI18n()
  const [customPointer, setCustomPointer] = useState(() => resultSelection(value.pointer, fields) === CUSTOM_RESULT)
  const result = customPointer ? CUSTOM_RESULT : resultSelection(value.pointer, fields)
  const hint = fields.find(field => field.pointer === result)?.hint

  return (
    <>
      <label className="step-property-field">
        <span className="step-property-label">{t("inputValueEditor.result")}</span>
        <select value={result} disabled={disabled} onChange={(event) => {
          const pointer = event.target.value
          setCustomPointer(pointer === CUSTOM_RESULT)
          if (pointer !== CUSTOM_RESULT) onChange({ ...value, pointer })
        }}>
          {fields.map(field => <option key={field.pointer} value={field.pointer}>{field.label}</option>)}
          <option value={CUSTOM_RESULT}>{t("inputValueEditor.customPointer")}</option>
        </select>
      </label>
      {hint && <p className="value-source-help">{hint}</p>}
      {result === CUSTOM_RESULT && (
        <>
          <label className="step-property-field">
            <span className="step-property-label">{t("inputValueEditor.jSONPointer")}</span>
            <input type="text" value={value.pointer} disabled={disabled}
              onChange={(event) => onChange({ ...value, pointer: event.target.value })} />
          </label>
          <p className="value-source-help">{t("inputValueEditor.useAJSONPointerSuchAsValueLeaveEmpty")}</p>
        </>
      )}
    </>
  )
}

function ProcessStringField({ value, disabled, onChange }: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const [mount, setMount] = useState(() => ({ key: 0, display: encodeProcessString(value) }))
  const lastPublished = useRef(value)
  const publish = useRef<(next: string) => void>(() => {})
  useLayoutEffect(() => {
    publish.current = next => {
      const raw = decodeProcessString(next)
      lastPublished.current = raw
      onChange(raw)
    }
    const field = fieldRef.current
    // Keep native editing history in the DOM. Only an external value change
    // may replace the display; React must not rewrite another field mid-Undo.
    if (field && lastPublished.current !== value) {
      if (decodeProcessString(field.value) !== value) field.value = encodeProcessString(value)
      lastPublished.current = value
      syncProcessStringHistory(field)
    }
  })
  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    const unbindHistory = bindProcessStringHistory(field, next => publish.current(next),
      display => setMount(current => ({ key: current.key + 1, display })), flushSync)
    const unbindTransfers = bindProcessStringTransfers(field)
    return () => {
      unbindTransfers()
      unbindHistory()
    }
  }, [mount.key])

  return <textarea key={mount.key} ref={fieldRef} rows={3} defaultValue={mount.display} disabled={disabled}
    onInput={event => publish.current(event.currentTarget.value)} />
}

function OperandEditor({ value, onChange, earlierSteps, instances, backgrounds = [], stepLabel, earlierVariables, disabled, literalLabel, allowBooleanLiteral = false, allowStringLiteral = false, allowNullLiteral = false, fixedStringLiteral = false }: OperandEditorProps) {
  const { t } = useI18n()
  switch (value.source) {
    case 'literal':
      if (fixedStringLiteral) {
        const literal = value.value
        return typeof literal === 'string' ? (
          <>
            <label className="step-property-field">
              <span className="step-property-label">{literalLabel ?? t("inputValueEditor.value")}</span>
              <ProcessStringField value={literal} disabled={disabled}
                onChange={value => onChange({ source: 'literal', value })} />
            </label>
            <p className="value-source-help">{t("process.fixedStringHelp")}</p>
          </>
        ) : (
          <>
            <p className="step-properties-empty">{t("inputValueEditor.valuePreservedFixedValueTypeIsNotEditableHere")}{JSON.stringify(value.value)}</p>
            <button className="action-button" type="button" disabled={disabled}
              onClick={() => onChange({ source: 'literal', value: '' })}>{t("inputValueEditor.replaceWithStringFixedValue")}</button>
          </>
        )
      }
      return typeof value.value === 'number' || (allowBooleanLiteral && typeof value.value === 'boolean') || (allowStringLiteral && typeof value.value === 'string') || (allowNullLiteral && value.value === null) ? (
        <>
          {(allowBooleanLiteral || allowStringLiteral || allowNullLiteral) && <label className="step-property-field">
            <span className="step-property-label">{t("inputValueEditor.valueType")}</span>
            <select value={value.value === null ? 'null' : typeof value.value === 'boolean' ? 'boolean' : typeof value.value === 'string' ? 'string' : 'number'} disabled={disabled}
              onChange={(event) => onChange({ source: 'literal', value: event.target.value === 'null' ? null : event.target.value === 'boolean' ? false : event.target.value === 'string' ? '' : 0 })}>
              <option value="number">{t("inputValueEditor.number")}</option>
              {allowBooleanLiteral && <option value="boolean">{t("inputValueEditor.boolean")}</option>}
              {allowStringLiteral && <option value="string">{t("inputValueEditor.string")}</option>}
              {allowNullLiteral && <option value="null">{t("inputValueEditor.null")}</option>}
            </select>
          </label>}
          {(allowBooleanLiteral || allowStringLiteral || allowNullLiteral) &&
            <p className="value-source-help">{t(value.value === null ? 'inputValueEditor.typeHelp.null'
              : typeof value.value === 'boolean' ? 'inputValueEditor.typeHelp.boolean'
              : typeof value.value === 'string' ? 'inputValueEditor.typeHelp.string' : 'inputValueEditor.typeHelp.number')}</p>}
          {value.value !== null && <label className="step-property-field">
            <span className="step-property-label">{literalLabel ?? t("inputValueEditor.value")}</span>
            {typeof value.value === 'boolean' ? (
              <select value={String(value.value)} disabled={disabled}
                onChange={(event) => onChange({ source: 'literal', value: event.target.value === 'true' })}>
                <option value="true">{t("inputValueEditor.true")}</option>
                <option value="false">{t("inputValueEditor.false")}</option>
              </select>
            ) : typeof value.value === 'string' ? (
              <input type="text" value={value.value} disabled={disabled}
                onChange={(event) => onChange({ source: 'literal', value: event.target.value })} />
            ) : (
              <input type="number" step="any" value={value.value} disabled={disabled}
                onChange={(event) => {
                  const number = event.currentTarget.valueAsNumber
                  if (Number.isFinite(number)) onChange({ source: 'literal', value: number })
                }} />
            )}
          </label>}
        </>
      ) : (
        <>
          <p className="step-properties-empty">
            {t("inputValueEditor.valuePreservedFixedValueTypeIsNotEditableHere")}{JSON.stringify(value.value)}
          </p>
          <button className="action-button" type="button" disabled={disabled}
            onClick={() => onChange({ source: 'literal', value: 0 })}>
            {t("inputValueEditor.replaceWithNumericFixedValue")}</button>
        </>
      )
    case 'variable':
      return (
        <>
          <label className="step-property-field">
            <span className="step-property-label">{t("inputValueEditor.referencedVariable")}</span>
            <select value={earlierVariables.includes(value.variable) ? value.variable : ''}
              disabled={disabled || earlierVariables.length === 0}
              onChange={(event) => onChange({ source: 'variable', variable: event.target.value })}>
              <option value="" disabled>{t("inputValueEditor.selectAnAvailableVariable")}</option>
              {earlierVariables.map((variable) => <option key={variable} value={variable}>{variable}</option>)}
            </select>
          </label>
          {!earlierVariables.includes(value.variable) && (
            <p className="step-properties-empty">{t("inputValueEditor.referencePreserved")}{value.variable} {t("inputValueEditor.isNotAmongTheVariableSuggestionsForThisScope")}</p>
          )}
        </>
      )
    case 'step-output': {
      const candidates = stepOutputCandidates(earlierSteps)
      const previousStep = earlierSteps.find((step) => step.id === value.step_id)
      const fields = curatedResultFields(previousStep, instances, t, backgrounds, earlierSteps)
      return (
        <>
          <label className="step-property-field">
            <span className="step-property-label">{t("inputValueEditor.step")}</span>
            <select value={candidates.some((step) => step.id === value.step_id) ? value.step_id : ''}
              disabled={disabled || candidates.length === 0}
              onChange={(event) => {
                const step = candidates.find(candidate => candidate.id === event.target.value)
                if (step) onChange(stepOutputReference(step, instances, backgrounds, earlierSteps))
              }}>
              <option value="" disabled>{t("inputValueEditor.selectAnEarlierStep")}</option>
              {candidates.map((step) => <option key={step.id} value={step.id}>{stepLabel(step)} ({step.id})</option>)}
            </select>
          </label>
          {value.step_id ? <>
            {!candidates.some((step) => step.id === value.step_id) && (
              <p className="step-properties-empty">{t("inputValueEditor.referencePreserved")}{value.step_id} {t("inputValueEditor.isNotAnEligibleEarlierResultProducingStepValidate")}</p>
            )}
            <ResultPathEditor key={value.step_id} value={value} onChange={onChange}
              fields={fields} disabled={disabled} />
          </> : <>
            <label className="step-property-field">
              <span className="step-property-label">{t("inputValueEditor.result")}</span>
              <select value="" disabled>
                <option value="">{t("inputValueEditor.selectStepFirst")}</option>
              </select>
            </label>
            {candidates.length === 0 && <p className="value-source-help">{t("inputValueEditor.noEarlierResults")}</p>}
          </>}
        </>
      )
    }
  }
}

function SourceOptions({ earlierSteps, earlierVariables, numericSetpoint = false, noLiteral = false }: ReferenceOptions) {
  const { t } = useI18n()
  const hasStepOutput = stepOutputCandidates(earlierSteps).length > 0
  return (
    <>
      {!noLiteral && <option value="literal">{t("inputValueEditor.fixedValue")}</option>}
      <option value="variable" disabled={earlierVariables.length === 0}>{t("inputValueEditor.variable")}</option>
      {!numericSetpoint && <option value="step-output" disabled={!hasStepOutput}>{t("inputValueEditor.previousStepResult")}</option>}
    </>
  )
}

function defaultOperand(source: string, references: ReferenceOptions, literal: number | string = 0): ExpressionOperandWire {
  switch (source) {
    case 'variable': return { source, variable: references.earlierVariables[0] }
    case 'step-output': return stepOutputReference(stepOutputCandidates(references.earlierSteps)[0], references.instances, references.backgrounds, references.earlierSteps)
    default: return { source: 'literal', value: literal }
  }
}

export function ExpressionOperandEditor({ value, onChange, side, allowBooleanLiteral = false, ...references }: OperandEditorProps & { side: 'Left' | 'Right' }) {
  const { t } = useI18n()
  return (
    <div className="step-properties-fields" role="group" aria-label={t("inputValueEditor.operand", { value1: side === 'Left' ? t("inputValueEditor.left") : t("inputValueEditor.right") })}>
      <label className="step-property-field">
        <span className="step-property-label">{t("inputValueEditor.namedSource", { label: side === 'Left' ? t("inputValueEditor.left") : t("inputValueEditor.right") })}</span>
        <select value={value.source} disabled={references.disabled}
          onChange={(event) => onChange(defaultOperand(event.target.value, references))}>
          <SourceOptions {...references} />
        </select>
      </label>
      <p className="value-source-help">{sourceHelp(t)[value.source]}</p>
      <OperandEditor {...references} value={value} onChange={onChange} allowBooleanLiteral={allowBooleanLiteral} />
    </div>
  )
}

export function ProcessOperandEditor({ value, onChange, label, literalDefault, help, ...references }:
  Omit<OperandEditorProps, 'literalLabel'> & { label: string; literalDefault: number | string; help?: string }) {
  const { t } = useI18n()
  const helpId = useId()
  return (
    <div className="step-properties-fields" role="group" aria-label={label} aria-describedby={help ? helpId : undefined}>
      <label className="step-property-field">
        <span className="step-property-label">{t("inputValueEditor.namedSource", { label })}</span>
        <select value={value.source} disabled={references.disabled}
          onChange={event => onChange(defaultOperand(event.target.value, references, literalDefault))}>
          <SourceOptions {...references} />
        </select>
      </label>
      <p className="value-source-help">{sourceHelp(t)[value.source]}</p>
      <OperandEditor {...references} value={value} onChange={onChange}
        fixedStringLiteral={typeof literalDefault === 'string'} literalLabel={label} />
      {help && <p id={helpId} className="value-source-help">{help}</p>}
    </div>
  )
}

type InputValueEditorProps = ReferenceOptions & {
  allowBooleanLiteral?: boolean
  timeFormat?: OutputTimeFormat
  onTimeFormatChange?: (format: OutputTimeFormat) => void
  value: InputValueWire
  onChange: (value: InputValueWire) => void
  sourceLabel?: string
  literalLabel?: string
  literalDefault?: number | string
}

export default function InputValueEditor({ value, onChange, sourceLabel, literalLabel,
  timeFormat, onTimeFormatChange, literalDefault = 0, numericSetpoint = false, numericCalculation = false, allowStringLiteral = false, allowBooleanLiteral = false, allowNullLiteral = false, ...references }: InputValueEditorProps) {
  const { t } = useI18n()


  const operandEditor = (side: 'left' | 'right') => value.source === 'expression' &&
    (side === 'left' || !Object.hasOwn(UNARY_OPERATORS, value.operator)) && (
    <ExpressionOperandEditor {...references} numericSetpoint={numericSetpoint} side={side === 'left' ? 'Left' : 'Right'} value={value[side] ?? { source: 'literal', value: 0 }}
      onChange={(operand) => onChange({ ...value, [side]: operand })} />
  )

  return (
    <>
      <label className="step-property-field">
        <span className="step-property-label">{sourceLabel ?? t("inputValueEditor.valueSource")}</span>
        <select value={value.source} disabled={references.disabled}
          onChange={(event) => onChange(event.target.value === 'expression'
            ? { source: 'expression', left: { source: 'literal', value: 0 }, operator: 'add', right: { source: 'literal', value: 0 } }
            : event.target.value === 'elapsed-time' || event.target.value === 'timestamp'
              ? { source: event.target.value }
              : defaultOperand(event.target.value, references, literalDefault))}>
          <SourceOptions {...references} numericSetpoint={numericSetpoint} />
          <option value="expression">{t("inputValueEditor.calculation")}</option>
          {!numericSetpoint && <>
            <option value="elapsed-time">{t("inputValueEditor.elapsedTime")}</option>
            <option value="timestamp">{t("inputValueEditor.timestamp")}</option>
          </>}
        </select>
      </label>
      <p className="value-source-help">{numericSetpoint && value.source === 'expression'
        ? t("inputValueEditor.calculateANumericValueFromFixedNumbersOrVariables") : sourceHelp(t)[value.source]}</p>
      {numericSetpoint && <p className="value-source-help">{t("inputValueEditor.numberDecimalsAllowedTheInstrumentStillValidatesItsSupported")}</p>}
      {value.source === 'elapsed-time' && timeFormat?.kind === 'elapsed-time' && onTimeFormatChange && <>
        <label className="step-property-field">
          <span className="step-property-label">{t("inputValueEditor.timeFormat")}</span>
          <select value={timeFormat.format} disabled={references.disabled}
            onChange={event => onTimeFormatChange({ kind: 'elapsed-time', format: event.target.value as ElapsedTimeFormat })}>
            {Object.keys(ELAPSED_TIME_FORMATS).map(format => <option key={format} value={format}>{t(`timeFormat.${format}`)}</option>)}
          </select>
        </label>
        <p className="value-source-help">{t("inputValueEditor.xLSXTimeCellsAreNumericSecondsUsesSecondsOther")}</p>
      </>}
      {value.source === 'timestamp' && timeFormat?.kind === 'timestamp' && onTimeFormatChange && <>
        <label className="step-property-field step-property-checkbox">
          <input type="checkbox" checked={timeFormat.include_date} disabled={references.disabled}
            onChange={event => onTimeFormatChange({ ...timeFormat, include_date: event.target.checked })} />
          <span className="step-property-label">{t("inputValueEditor.includeDate")}</span>
        </label>
        <label className="step-property-field step-property-checkbox">
          <input type="checkbox" checked={timeFormat.include_utc_offset} disabled={references.disabled}
            onChange={event => onTimeFormatChange({ ...timeFormat, include_utc_offset: event.target.checked })} />
          <span className="step-property-label">{t("inputValueEditor.includeUTCOffset")}</span>
        </label>
        <p className="value-source-help">{t("inputValueEditor.hidingDateOrUTCOffsetAffectsDisplayOnlyXLSX")}</p>
      </>}
      {value.source === 'expression' ? (
        <div className="step-properties-fields" role="group" aria-label={t("inputValueEditor.calculation")}>
          <span className="step-property-label">{t("inputValueEditor.calculation")}</span>
          {operandEditor('left')}
          <label className="step-property-field">
            <span className="step-property-label">{t("inputValueEditor.operator")}</span>
            <select value={value.operator} disabled={references.disabled}
              onChange={(event) => {
                const operator = event.target.value as typeof value.operator
                onChange(Object.hasOwn(UNARY_OPERATORS, operator)
                  ? { source: 'expression', left: value.left, operator }
                  : { ...value, operator, right: value.right ?? { source: 'literal', value: 0 } })
              }}>
              {Object.entries(EXPRESSION_OPERATORS)
                .filter(([operator]) => !(numericSetpoint || numericCalculation) ||
                  ['add', 'subtract', 'multiply', 'divide', 'round', 'floor', 'ceil', 'trunc'].includes(operator)).map(([operator, symbol]) => (
                <option key={operator} value={operator}>{symbol}</option>
              ))}
            </select>
          </label>
          {operandEditor('right')}
        </div>
      ) : (
        value.source !== 'elapsed-time' && value.source !== 'timestamp' &&
        <OperandEditor {...references} allowStringLiteral={allowStringLiteral} allowBooleanLiteral={allowBooleanLiteral} allowNullLiteral={allowNullLiteral} value={value} literalLabel={literalLabel} onChange={onChange} />
      )}
    </>
  )
}
