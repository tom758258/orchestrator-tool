// Mirrors the Core Template wire representation; operands cannot contain expressions.
export type ExpressionOperandWire =
  | { source: 'literal'; value: unknown }
  | { source: 'variable'; variable: string }
  | { source: 'step-output'; step_id: string; pointer: string }

export const COMPARISON_OPERATORS = {
  'greater-than': '>',
  'greater-than-or-equal': '≥',
  'less-than': '<',
  'less-than-or-equal': '≤',
} as const

export type ComparisonOperator = keyof typeof COMPARISON_OPERATORS

export const EXPRESSION_OPERATORS = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
  ...COMPARISON_OPERATORS,
} as const

export type InputValueWire = ExpressionOperandWire | { source: 'elapsed-time' } | { source: 'timestamp' } | {
  source: 'expression'
  left: ExpressionOperandWire
  operator: keyof typeof EXPRESSION_OPERATORS
  right: ExpressionOperandWire
}

type StepOutputCandidate = {
  id: string
  type: string
  target?: string
  action?: string
}

type ToolIdentity = {
  id: string
  tool: string
}

export type CuratedResultField = {
  label: string
  pointer: string
}

export const CUSTOM_RESULT = 'custom'

const ACTION_RESULT_FIELDS: Readonly<Record<string, readonly CuratedResultField[]>> = {
  'meters/measure': [
    { label: 'Value', pointer: '/value' },
    { label: 'Unit', pointer: '/unit' },
  ],
  'powers/set-voltage': [
    { label: 'Voltage', pointer: '/request/arguments/voltage' },
    { label: 'Channel', pointer: '/request/arguments/channel' },
  ],
  'powers/set-output': [
    { label: 'Channel', pointer: '/request/arguments/channel' },
    { label: 'Voltage', pointer: '/request/arguments/voltage' },
    { label: 'Current Limit', pointer: '/request/arguments/current' },
  ],
}

export function stepOutputCandidates<T extends StepOutputCandidate>(steps: readonly T[]): T[] {
  return steps.filter(step => step.type === 'tool-action')
}

export function curatedResultFields(
  step: StepOutputCandidate | undefined,
  instances: readonly ToolIdentity[],
): readonly CuratedResultField[] {
  if (step?.type !== 'tool-action') return []
  const tool = instances.find(instance => instance.id === step.target)?.tool
  return ACTION_RESULT_FIELDS[`${tool}/${step.action}`] ?? []
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
  return `${operandSummary(value.left)} ${EXPRESSION_OPERATORS[value.operator]} ${operandSummary(value.right)}`
}
