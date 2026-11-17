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
  operation?: { kind: string }
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
  'serial/send': [{ label: "resultFields.tXHex", pointer: '/tx_hex' }, { label: "resultFields.tXBytes", pointer: '/tx_bytes' }],
  'serial/send-file': [{ label: "resultFields.fileBytes", pointer: '/file_bytes' }, { label: "resultFields.bytesWritten", pointer: '/bytes_written' }],
  'serial/receive': [{ label: "resultFields.rXHex", pointer: '/rx_hex' }, { label: "resultFields.rXBytes", pointer: '/rx_bytes' },
    { label: "resultFields.serialOutcome", pointer: '/outcome', hint: "resultFields.serialOutcomeHint" },
    { label: "resultFields.serialTimedOut", pointer: '/timed_out', hint: "resultFields.serialTimedOutHint" },
    { label: "resultFields.partialRXHex", pointer: '/partial_rx_hex', hint: "resultFields.partialRXHexHint" },
    { label: "resultFields.partialRXBytes", pointer: '/partial_rx_bytes', hint: "resultFields.partialRXBytesHint" }],
  'serial/query': [{ label: "resultFields.rXHex", pointer: '/rx_hex' }, { label: "resultFields.rXBytes", pointer: '/rx_bytes' },
    { label: "resultFields.tXHex", pointer: '/tx_hex' }, { label: "resultFields.tXBytes", pointer: '/tx_bytes' },
    { label: "resultFields.delimiterHex", pointer: '/delimiter_hex' },
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
  return steps.filter(step => step.type === 'tool-action' || (
    step.type === 'bg-interaction' && ['get-latest', 'wait-next', 'get-command-result'].includes(step.operation?.kind ?? '')
  ))
}

export function curatedResultFields(
  step: StepOutputCandidate | undefined,
  instances: readonly ToolIdentity[],
  t: Translate = english,
): readonly CuratedResultField[] {
  if (step?.type !== 'tool-action') return []
  const tool = instances.find(instance => instance.id === step.target)?.tool
  return (ACTION_RESULT_FIELDS[`${tool}/${step.action}`] ?? []).map(field => ({ ...field, label: t(field.label), ...(field.hint && { hint: t(field.hint) }) }))
}

export function resultSelection(pointer: string, fields: readonly CuratedResultField[]): string {
  return fields.some(field => field.pointer === pointer) ? pointer : CUSTOM_RESULT
}

export function stepOutputReference(
  step: StepOutputCandidate,
  instances: readonly ToolIdentity[],
): Extract<ExpressionOperandWire, { source: 'step-output' }> {
  return {
    source: 'step-output',
    step_id: step.id,
    pointer: curatedResultFields(step, instances)[0]?.pointer ?? '',
  }
}

export function expressionSummary(value: Omit<Extract<InputValueWire, { source: 'expression' }>, 'source'>): string {
  const operandSummary = (operand: ExpressionOperandWire): string => {
    switch (operand.source) {
      case 'literal': return JSON.stringify(operand.value) ?? 'No value'
      case 'variable': return operand.variable
      case 'step-output': return `${operand.step_id} → ${operand.pointer || '(root)'}`
    }
  }
  if (Object.hasOwn(UNARY_OPERATORS, value.operator)) {
    return `${EXPRESSION_OPERATORS[value.operator]}(${operandSummary(value.left)})`
  }
  return `${operandSummary(value.left)} ${EXPRESSION_OPERATORS[value.operator]} ${value.right ? operandSummary(value.right) : '?'}`
}
