// Mirrors the Core Template wire representation; operands cannot contain expressions.
export type ExpressionOperandWire =
  | { source: 'literal'; value: unknown }
  | { source: 'variable'; variable: string }
  | { source: 'step-output'; step_id: string; pointer: string }

export const EXPRESSION_OPERATORS = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
  'greater-than': '>',
  'greater-than-or-equal': '≥',
  'less-than': '<',
  'less-than-or-equal': '≤',
} as const

export type InputValueWire = ExpressionOperandWire | {
  source: 'expression'
  left: ExpressionOperandWire
  operator: keyof typeof EXPRESSION_OPERATORS
  right: ExpressionOperandWire
}

export function expressionSummary(value: Extract<InputValueWire, { source: 'expression' }>): string {
  const operandSummary = (operand: ExpressionOperandWire): string => {
    switch (operand.source) {
      case 'literal': return JSON.stringify(operand.value) ?? 'No value'
      case 'variable': return operand.variable
      case 'step-output': return `${operand.step_id} → ${operand.pointer || '(root)'}`
    }
  }
  return `${operandSummary(value.left)} ${EXPRESSION_OPERATORS[value.operator]} ${operandSummary(value.right)}`
}
