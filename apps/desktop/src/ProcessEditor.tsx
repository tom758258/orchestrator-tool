import { ProcessOperandEditor } from './InputValueEditor'
import { useI18n } from './i18n/I18nProvider'
import type { ExpressionOperandWire } from './inputValue'
import type { BackgroundConfig, ByteProcessOperation, ProcessStep, StringProcessOperation, WorkflowStep } from './workflow'
import type { ToolInstance } from './ToolSetupEditor'

const STRING_PARAMETERS: Record<StringProcessOperation, readonly string[]> = {
  length: ['input'],
  substring: ['input', 'start_index', 'length'],
  concat: ['input', 'append'],
  contains: ['input', 'search'],
  'index-of': ['input', 'search'],
  replace: ['input', 'search', 'replacement'],
  trim: ['input'],
  'to-upper-case': ['input'],
  'to-lower-case': ['input'],
  'to-number': ['input'],
}

const BYTE_PARAMETERS: Record<ByteProcessOperation['kind'], readonly string[]> = {
  'byte-length': ['input'],
  'get-byte': ['input', 'byte_index'],
  'get-bytes': ['input', 'start_index', 'byte_count'],
  concat: ['input', 'append'],
  contains: ['input', 'search'],
  'hex-to-number': ['input', 'start_index', 'byte_count'],
  'number-to-hex': ['input', 'byte_count'],
  'hex-to-text': ['input'],
  'text-to-hex': ['input'],
}

function parameters(step: ProcessStep): readonly string[] {
  return step.type === 'string-process' ? STRING_PARAMETERS[step.operation] : BYTE_PARAMETERS[step.operation.kind]
}

function literalDefault(step: ProcessStep, name: string): string | number {
  if (name === 'byte_count') return 1
  if (name === 'length' || name === 'byte_index' || name === 'start_index') return 0
  if (name === 'input' && step.type === 'byte-process' && step.operation.kind === 'number-to-hex') return 0
  return ''
}

function withOperation(step: ProcessStep, kind: string): ProcessStep {
  let next: ProcessStep
  if (step.type === 'string-process') {
    next = { ...step, operation: kind as StringProcessOperation }
  } else {
    const selected = kind as ByteProcessOperation['kind']
    const operation: ByteProcessOperation = selected === 'hex-to-number' || selected === 'number-to-hex'
      ? { kind: selected, byte_order: 'byte_order' in step.operation ? step.operation.byte_order : 'msb-first',
          number_format: 'number_format' in step.operation ? step.operation.number_format : 'unsigned' }
      : { kind: selected }
    next = { ...step, operation }
  }
  return { ...next, arguments: Object.fromEntries(parameters(next).map(name => {
    const value = step.arguments[name]
    const fallback = literalDefault(next, name)
    const operand: ExpressionOperandWire = value && (value.source !== 'literal' || typeof value.value === typeof fallback)
      ? value : { source: 'literal', value: fallback }
    return [name, operand]
  })) }
}

type Props = {
  step: ProcessStep
  earlierSteps: readonly WorkflowStep[]
  earlierVariables: readonly string[]
  instances: readonly ToolInstance[]
  backgrounds: readonly BackgroundConfig[]
  stepLabel: (step: WorkflowStep) => string
  disabled: boolean
  onChange: (update: (step: ProcessStep) => ProcessStep) => void
}

export default function ProcessEditor({ step, onChange, ...references }: Props) {
  const { t } = useI18n()
  const kind = step.type === 'string-process' ? step.operation : step.operation.kind
  const operations = Object.keys(step.type === 'string-process' ? STRING_PARAMETERS : BYTE_PARAMETERS)
  const label = (name: string) => {
    if (name !== 'input') return t(`process.parameter.${name}`)
    if (step.type === 'string-process' || kind === 'text-to-hex') return t("process.inputString")
    if (kind === 'number-to-hex') return t("process.inputNumber")
    return t("process.inputHex")
  }
  return (
    <div className="step-properties-fields" data-process-string-editor>
      <label className="step-property-field">
        <span className="step-property-label">{t("process.operation")}</span>
        <select value={kind} disabled={references.disabled}
          onChange={event => {
            const selected = event.target.value
            onChange(current => withOperation(current, selected))
          }}>
          {operations.map(operation => <option key={operation} value={operation}>{t(`process.operation.${operation}`)}</option>)}
        </select>
      </label>
      {parameters(step).map(name => (
        <ProcessOperandEditor key={kind + ':' + name} {...references}
          label={label(name)} literalDefault={literalDefault(step, name)}
          value={step.arguments[name] ?? { source: 'literal', value: literalDefault(step, name) }}
          onChange={value => onChange(current => ({ ...current, arguments: { ...current.arguments, [name]: value } }))} />
      ))}
      {step.type === 'byte-process' && 'byte_order' in step.operation && (() => {
        const operation = step.operation
        return <>
          <label className="step-property-field">
            <span className="step-property-label">{t("process.byteOrder")}</span>
            <select value={operation.byte_order} disabled={references.disabled}
              onChange={event => {
                const byte_order = event.target.value as typeof operation.byte_order
                onChange(current => current.type === 'byte-process' && 'byte_order' in current.operation
                  ? { ...current, operation: { ...current.operation, byte_order } } : current)
              }}>
              <option value="msb-first">{t("process.msbFirst")}</option>
              <option value="lsb-first">{t("process.lsbFirst")}</option>
            </select>
          </label>
          <label className="step-property-field">
            <span className="step-property-label">{t("process.numberFormat")}</span>
            <select value={operation.number_format} disabled={references.disabled}
              onChange={event => {
                const number_format = event.target.value as typeof operation.number_format
                onChange(current => current.type === 'byte-process' && 'number_format' in current.operation
                  ? { ...current, operation: { ...current.operation, number_format } } : current)
              }}>
              <option value="unsigned">{t("process.unsigned")}</option>
              <option value="signed">{t("process.signed")}</option>
            </select>
          </label>
          <p className="value-source-help">{t("process.numericByteCountHelp")}</p>
        </>
      })()}
      <p className="value-source-help">{t("process.limitHelp")}</p>
      {step.type === 'byte-process' && <p className="value-source-help">{t("process.hexHelp")}</p>}
      <p className="value-source-help">{t("process.resultHelp")}</p>
    </div>
  )
}
