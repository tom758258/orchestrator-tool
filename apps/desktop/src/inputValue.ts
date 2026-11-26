import { english, type Translate } from './i18n/index.ts'
// Mirrors the Core Template wire representation; operands cannot contain expressions.
export type ExpressionOperandWire =
  | { source: 'literal'; value: unknown }
  | { source: 'variable'; variable: string }
  | { source: 'step-output'; step_id: string; pointer: string }

export const COMPARISON_OPERATORS = {
  equal: '==',
  'not-equal': '!=',
  'greater-than': '>',
  'greater-than-or-equal': '>=',
  'less-than': '<',
  'less-than-or-equal': '<=',
} as const

export type ComparisonOperator = keyof typeof COMPARISON_OPERATORS

export const UNARY_OPERATORS = {
  round: 'Round',
  floor: 'Floor',
  ceil: 'Ceil',
  trunc: 'Trunc',
} as const

export const EXPRESSION_OPERATORS = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
  ...UNARY_OPERATORS,
  ...COMPARISON_OPERATORS,
} as const

export type InputValueWire = ExpressionOperandWire | { source: 'elapsed-time' } | { source: 'timestamp' } | {
  source: 'expression'
  left: ExpressionOperandWire
  operator: keyof typeof EXPRESSION_OPERATORS
  right?: ExpressionOperandWire
}

type StepOutputCandidate = {
  id: string
  type: string
  target?: string
  action?: string
  arguments?: Record<string, unknown>
  background_id?: string
  operation?: string | { kind: string; command?: string; source_step?: string }
}

type BackgroundIdentity = {
  id: string
  tool_instance_id: string
  scopes_measurements?: readonly { id: string }[]
}

type ToolIdentity = {
  id: string
  tool: string
}

export type CuratedResultField = {
  label: string
  pointer: string
  hint?: string
}

export const CUSTOM_RESULT = 'custom'

const ACTION_RESULT_FIELDS: Readonly<Record<string, readonly CuratedResultField[]>> = {
  'serial/send': [{ label: "resultFields.tXHex", pointer: '/tx_hex', hint: "resultFields.tXHexHint" }, { label: "resultFields.tXBytes", pointer: '/tx_bytes', hint: "resultFields.tXBytesHint" }],
  'serial/send-file': [{ label: "resultFields.fileBytes", pointer: '/file_bytes', hint: "resultFields.fileBytesHint" }, { label: "resultFields.bytesWritten", pointer: '/bytes_written' }],
  'serial/receive': [{ label: "resultFields.rXHex", pointer: '/rx_hex', hint: "resultFields.rXHexHint" }, { label: "resultFields.rXBytes", pointer: '/rx_bytes', hint: "resultFields.rXBytesHint" },
    { label: "resultFields.serialOutcome", pointer: '/outcome', hint: "resultFields.serialOutcomeHint" },
    { label: "resultFields.serialTimedOut", pointer: '/timed_out', hint: "resultFields.serialTimedOutHint" },
    { label: "resultFields.partialRXHex", pointer: '/partial_rx_hex', hint: "resultFields.partialRXHexHint" },
    { label: "resultFields.partialRXBytes", pointer: '/partial_rx_bytes', hint: "resultFields.partialRXBytesHint" }],
  'serial/query': [{ label: "resultFields.rXHex", pointer: '/rx_hex', hint: "resultFields.rXHexHint" }, { label: "resultFields.rXBytes", pointer: '/rx_bytes', hint: "resultFields.rXBytesHint" },
    { label: "resultFields.tXHex", pointer: '/tx_hex', hint: "resultFields.tXHexHint" }, { label: "resultFields.tXBytes", pointer: '/tx_bytes', hint: "resultFields.tXBytesHint" },
    { label: "resultFields.delimiterHex", pointer: '/delimiter_hex', hint: "resultFields.delimiterHexHint" },
    { label: "resultFields.serialOutcome", pointer: '/outcome', hint: "resultFields.serialOutcomeHint" },
    { label: "resultFields.serialTimedOut", pointer: '/timed_out', hint: "resultFields.serialTimedOutHint" },
    { label: "resultFields.partialRXHex", pointer: '/partial_rx_hex', hint: "resultFields.partialRXHexHint" },
    { label: "resultFields.partialRXBytes", pointer: '/partial_rx_bytes', hint: "resultFields.partialRXBytesHint" }],
  'scopes/single-wait': [
    { label: "resultFields.outcome", pointer: '/outcome', hint: "resultFields.outcomeHint" },
    { label: "resultFields.timedOut", pointer: '/timed_out', hint: "resultFields.timedOutHint" },
    { label: "resultFields.captureAllowed", pointer: '/capture_allowed', hint: "resultFields.captureAllowedHint" },
  ],
  'scopes/measure': [
    { label: "resultFields.value", pointer: '/value' },
    { label: "resultFields.valid", pointer: '/valid', hint: "resultFields.validHint" },
    { label: "resultFields.unit", pointer: '/unit' },
    { label: "resultFields.channel", pointer: '/channel' },
    { label: "resultFields.item", pointer: '/item' },
  ],
  'meters/measure': [
    { label: "resultFields.value", pointer: '/value' },
    { label: "resultFields.unit", pointer: '/unit' },
  ],
  'powers/measure': [
    { label: "resultFields.voltage", pointer: '/data/measurements/voltage' },
    { label: "resultFields.current", pointer: '/data/measurements/current' },
    { label: "resultFields.channel", pointer: '/data/channel' },
  ],
  'powers/set-output': [
    { label: "resultFields.channel", pointer: '/request/arguments/channel' },
    { label: "resultFields.voltage", pointer: '/request/arguments/voltage' },
    { label: "resultFields.currentLimit", pointer: '/request/arguments/current' },
  ],
  'powers/protection-status': [
    { label: "resultFields.protectionTripped", pointer: '/protection_tripped', hint: "resultFields.protectionTrippedHint" },
    { label: "resultFields.overVoltageTripped", pointer: '/over_voltage_tripped', hint: "resultFields.overVoltageTrippedHint" },
    { label: "resultFields.overCurrentTripped", pointer: '/over_current_tripped', hint: "resultFields.overCurrentTrippedHint" },
  ],
}

export function stepOutputCandidates<T extends StepOutputCandidate>(steps: readonly T[]): T[] {
  return steps.filter(step => step.type === 'tool-action' || step.type === 'string-process' || step.type === 'byte-process' || step.type === 'array-process' || (
    step.type === 'bg-interaction' && typeof step.operation === 'object' &&
    ['get-latest', 'wait-next', 'get-command-result', 'get-buffer-data', 'get-buffer-status'].includes(step.operation.kind)
  ))
}

const BACKGROUND_SAMPLE_FIELDS = {
  meters: ACTION_RESULT_FIELDS['meters/measure'],
  serial: ACTION_RESULT_FIELDS['serial/receive'].slice(0, 2).map(({ label, pointer }) => ({ label, pointer })),
} as const

export function curatedResultFields(
  step: StepOutputCandidate | undefined,
  instances: readonly ToolIdentity[],
  t: Translate = english,
  backgrounds: readonly BackgroundIdentity[] = [],
  earlierSteps: readonly StepOutputCandidate[] = [],
): readonly CuratedResultField[] {
  let fields: readonly CuratedResultField[] = []
  if (step?.type === 'string-process' || step?.type === 'byte-process' || step?.type === 'array-process') {
    fields = [{ label: "resultFields.processValue", pointer: '/value' }]
  } else if (step?.type === 'tool-action') {
    const tool = instances.find(instance => instance.id === step.target)?.tool
    fields = ACTION_RESULT_FIELDS[`${tool}/${step.action}`] ?? []
    if (tool === 'serial' && (step.action === 'receive' || step.action === 'query') &&
      step.arguments?.enable_rx_text === true) {
      fields = [
        ...fields,
        { label: "resultFields.rXText", pointer: '/rx_text', hint: "resultFields.rXTextHint" },
        { label: "resultFields.partialRXText", pointer: '/partial_rx_text', hint: "resultFields.partialRXTextHint" },
      ]
    }
  } else if (step?.type === 'bg-interaction') {
    const background = backgrounds.find(item => item.id === step.background_id)
    const tool = instances.find(instance => instance.id === background?.tool_instance_id)?.tool
    const operation = typeof step.operation === 'object' ? step.operation : undefined
    const kind = operation?.kind
    if (kind === 'get-buffer-data' || kind === 'get-buffer-status') {
      const status = ['capacity', 'count', 'byte_capacity', 'buffered_bytes', 'full', 'overflowed', 'dropped_count'].map(key => ({
        label: 'resultFields.buffer.' + key, pointer: (kind === 'get-buffer-data' ? '/status/' : '/') + key,
      }))
      fields = kind === 'get-buffer-data'
        ? [{ label: 'resultFields.buffer.data', pointer: '/data' }, { label: 'resultFields.buffer.readCount', pointer: '/count' }, ...status]
        : status
    } else if (kind === 'get-latest' || kind === 'wait-next') {
      if (tool === 'meters' || tool === 'serial') {
        fields = BACKGROUND_SAMPLE_FIELDS[tool]
      } else if (tool === 'scopes') {
        return (background?.scopes_measurements ?? []).flatMap(measurement => [
          { label: `${measurement.id} · ${t('resultFields.value')}`, pointer: `/values/${measurement.id}/value` },
          { label: `${measurement.id} · ${t('resultFields.valid')}`, pointer: `/values/${measurement.id}/valid` },
          { label: `${measurement.id} · ${t('resultFields.unit')}`, pointer: `/values/${measurement.id}/unit` },
        ])
      }
    } else if (kind === 'get-command-result') {
      const source = earlierSteps.find(item => item.id === operation?.source_step)
      if (source?.type === 'bg-interaction' && source.background_id === step.background_id &&
        typeof source.operation === 'object' && source.operation.kind === 'command') {
        if (tool === 'meters' && source.operation.command === 'software-trigger') {
          fields = BACKGROUND_SAMPLE_FIELDS.meters
        } else if (tool === 'serial') {
          const action = source.operation.command === 'serial-send' ? 'serial/send'
            : source.operation.command === 'serial-send-file' ? 'serial/send-file' : null
          fields = action ? (ACTION_RESULT_FIELDS[action] ?? []).map(field => ({
            ...field, pointer: `/result${field.pointer}`,
          })) : []
        }
      }
    }
  }
  return fields.map(field => ({ ...field, label: t(field.label), ...(field.hint && { hint: t(field.hint) }) }))
}

export function resultSelection(pointer: string, fields: readonly CuratedResultField[]): string {
  return fields.some(field => field.pointer === pointer) ? pointer : CUSTOM_RESULT
}

export function stepOutputReference(
  step: StepOutputCandidate,
  instances: readonly ToolIdentity[],
  backgrounds: readonly BackgroundIdentity[] = [],
  earlierSteps: readonly StepOutputCandidate[] = [],
): Extract<ExpressionOperandWire, { source: 'step-output' }> {
  return {
    source: 'step-output',
    step_id: step.id,
    pointer: curatedResultFields(step, instances, english, backgrounds, earlierSteps)[0]?.pointer ?? '',
  }
}

export function expressionSummary(value: Omit<Extract<InputValueWire, { source: 'expression' }>, 'source'>,
  referenceSummary: (reference: Extract<ExpressionOperandWire, { source: 'step-output' }>) => string): string {
  const operandSummary = (operand: ExpressionOperandWire): string => {
    switch (operand.source) {
      case 'literal': return JSON.stringify(operand.value) ?? 'No value'
      case 'variable': return operand.variable
      case 'step-output': return referenceSummary(operand)
    }
  }
  if (Object.hasOwn(UNARY_OPERATORS, value.operator)) {
    return `${EXPRESSION_OPERATORS[value.operator]}(${operandSummary(value.left)})`
  }
  return `${operandSummary(value.left)} ${EXPRESSION_OPERATORS[value.operator]} ${value.right ? operandSummary(value.right) : '?'}`
}
