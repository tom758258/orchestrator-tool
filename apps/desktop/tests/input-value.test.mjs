import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMPARISON_OPERATORS,
  CUSTOM_RESULT,
  curatedResultFields,
  resultSelection,
  stepOutputCandidates,
  stepOutputReference,
} from '../src/inputValue.ts'

test('comparison operators include equality and ordering symbols', () => {
  assert.deepEqual(COMPARISON_OPERATORS, {
    equal: '==',
    'not-equal': '!=',
    'greater-than': '>',
    'greater-than-or-equal': '>=',
    'less-than': '<',
    'less-than-or-equal': '<=',
  })
})

const instances = [
  { id: 'meter-1', tool: 'meters' },
  { id: 'power-1', tool: 'powers' },
]
const meterMeasure = {
  type: 'tool-action', id: 'measure-1', target: 'meter-1', action: 'measure', arguments: {},
}
const powerSetVoltage = {
  type: 'tool-action', id: 'set-voltage-1', target: 'power-1', action: 'set-voltage', arguments: {},
}
const powerSetOutput = {
  type: 'tool-action', id: 'set-output-1', target: 'power-1', action: 'set-output', arguments: { channel: 1, current: 0.2 },
}
const powerProtectionStatus = {
  type: 'tool-action', id: 'protection-1', target: 'power-1', action: 'protection-status', arguments: { channel: 'all' },
}
const powerOutputOn = {
  type: 'tool-action', id: 'output-on-1', target: 'power-1', action: 'output-on', arguments: {},
}
const powerOutputOff = {
  type: 'tool-action', id: 'output-off-1', target: 'power-1', action: 'output-off', arguments: {},
}

test('curated results map Meter Measure Value and Unit pointers', () => {
  const fields = curatedResultFields(meterMeasure, instances)
  assert.deepEqual(fields, [
    { label: 'Value', pointer: '/value' },
    { label: 'Unit', pointer: '/unit' },
  ])
  assert.deepEqual(stepOutputReference(meterMeasure, instances), {
    source: 'step-output', step_id: 'measure-1', pointer: '/value',
  })
})

test('curated results map Powers Set Voltage pointers', () => {
  const fields = curatedResultFields(powerSetVoltage, instances)
  assert.deepEqual(fields, [
    { label: 'Voltage', pointer: '/request/arguments/voltage' },
    { label: 'Channel', pointer: '/request/arguments/channel' },
  ])
  assert.deepEqual(stepOutputReference(powerSetVoltage, instances), {
    source: 'step-output', step_id: 'set-voltage-1', pointer: '/request/arguments/voltage',
  })
})

test('Powers Set Output defaults to its required Channel result', () => {
  assert.deepEqual(curatedResultFields(powerSetOutput, instances), [
    { label: 'Channel', pointer: '/request/arguments/channel' },
    { label: 'Voltage', pointer: '/request/arguments/voltage' },
    { label: 'Current Limit', pointer: '/request/arguments/current' },
  ])
  assert.deepEqual(stepOutputReference(powerSetOutput, instances), {
    source: 'step-output', step_id: 'set-output-1', pointer: '/request/arguments/channel',
  })
})

test('Power Protection Status defaults to Protection Tripped', () => {
  assert.deepEqual(curatedResultFields(powerProtectionStatus, instances), [
    { label: 'Protection Tripped', pointer: '/protection_tripped' },
    { label: 'Over Voltage Tripped', pointer: '/over_voltage_tripped' },
    { label: 'Over Current Tripped', pointer: '/over_current_tripped' },
  ])
  assert.deepEqual(stepOutputReference(powerProtectionStatus, instances), {
    source: 'step-output', step_id: 'protection-1', pointer: '/protection_tripped',
  })
})

test('known and custom pointers select without rewriting the pointer', () => {
  const fields = curatedResultFields(powerSetVoltage, instances)
  assert.equal(resultSelection('/request/arguments/channel', fields), '/request/arguments/channel')

  const existing = { source: 'step-output', step_id: 'set-voltage-1', pointer: '/data/custom' }
  assert.equal(resultSelection(existing.pointer, fields), CUSTOM_RESULT)
  assert.equal(existing.pointer, '/data/custom')
})

test('switching incompatible actions replaces the previous curated pointer', () => {
  const previous = stepOutputReference(meterMeasure, instances)
  const switched = stepOutputReference(powerSetVoltage, instances)
  assert.equal(previous.pointer, '/value')
  assert.equal(switched.pointer, '/request/arguments/voltage')
})

test('Powers Output On and Output Off have no curated results', () => {
  assert.deepEqual(curatedResultFields(powerOutputOn, instances), [])
  assert.deepEqual(curatedResultFields(powerOutputOff, instances), [])
})

test('only Tool Actions are offered as Step Output candidates', () => {
  const structuralSteps = [
    { type: 'set-variable', id: 'set-1' },
    { type: 'wait', id: 'wait-1' },
    { type: 'output', id: 'output-1' },
    { type: 'for', id: 'for-1' },
    { type: 'while', id: 'while-1' },
  ]
  assert.deepEqual(stepOutputCandidates([...structuralSteps, meterMeasure]), [meterMeasure])
})

// Execute the actual editor and its child components using the existing JSX test pattern.
async function valueEditor(component = 'InputValueEditor') {
  const React = (await import('react')).default
  const { readFileSync } = await import('node:fs')
  const { transformWithOxc } = await import('vite')
  const inputValue = await import('../src/inputValue.ts')
  const source = readFileSync(new URL('../src/InputValueEditor.tsx', import.meta.url), 'utf8')
  const { code } = await transformWithOxc(source, 'InputValueEditor.tsx', { jsx: { runtime: 'classic' } })
  const modules = { react: { useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] },
    './inputValue': inputValue }
  const body = code.replace(/import (.+?) from "([^"]+)";/g,
    (_, names, path) => `const ${names} = modules[${JSON.stringify(path)}];`).replace(/export default /g, '').replace(/export /g, '')
  const render = new Function('React', 'modules', `${body}; return { InputValueEditor, ExpressionOperandEditor }`)(React, modules)[component]
  return props => {
    const nodes = []
    function visit(node) {
      if (Array.isArray(node)) node.forEach(visit)
      else if (React.isValidElement(node)) {
        if (node.type === React.Fragment) visit(node.props.children)
        else if (typeof node.type === 'function') visit(node.type(node.props))
        else { nodes.push(node); visit(node.props.children) }
      }
    }
    visit(render({ earlierSteps: [meterMeasure], instances, earlierVariables: ['x'], disabled: false,
      stepLabel: step => step.id, onChange: () => {}, ...props }))
    return nodes
  }
}

function fieldOptions(nodes, label) {
  const field = nodes.find(node => node.type === 'label' && [node.props.children[0]?.props.children].flat().join('') === label)
  assert.ok(field, label)
  const select = field.props.children.find(node => node?.type === 'select')
  // Options are expanded separately from their JSX component wrappers.
  const start = nodes.indexOf(select)
  const next = nodes.findIndex((node, i) => i > start && node.type !== 'option')
  return nodes.slice(start + 1, next < 0 ? undefined : next).filter(node => node.type === 'option')
    .map(node => node.props.value)
}

test('actual Numeric Setpoint editor offers only numeric sources, operands and arithmetic', async () => {
  const render = await valueEditor()
  const expression = { source: 'expression', left: { source: 'literal', value: 2 }, operator: 'add',
    right: { source: 'variable', variable: 'x' } }
  const nodes = render({ value: expression, numericSetpoint: true })
  assert.deepEqual(fieldOptions(nodes, 'Value Source'), ['literal', 'variable', 'expression'])
  assert.deepEqual(fieldOptions(nodes, 'Left Source'), ['literal', 'variable'])
  assert.deepEqual(fieldOptions(nodes, 'Right Source'), ['literal', 'variable'])
  assert.deepEqual(fieldOptions(nodes, 'Operator'), ['add', 'subtract', 'multiply', 'divide'])
  let changed
  const literalNodes = render({ value: { source: 'literal', value: 3 }, numericSetpoint: true,
    onChange: value => { changed = value } })
  literalNodes.find(node => node.type === 'input').props.onChange({ currentTarget: { valueAsNumber: 4.5 } })
  assert.deepEqual(changed, { source: 'literal', value: 4.5 })
})

test('actual general editor retains result/time sources and comparison calculations', async () => {
  const render = await valueEditor()
  const nodes = render({ value: { source: 'expression', left: { source: 'literal', value: 2 },
    operator: 'equal', right: { source: 'variable', variable: 'x' } } })
  assert.deepEqual(fieldOptions(nodes, 'Value Source'),
    ['literal', 'variable', 'step-output', 'expression', 'elapsed-time', 'timestamp'])
  assert.deepEqual(fieldOptions(nodes, 'Left Source'), ['literal', 'variable', 'step-output'])
  assert.deepEqual(fieldOptions(nodes, 'Right Source'), ['literal', 'variable', 'step-output'])
  assert.deepEqual(fieldOptions(nodes, 'Operator'),
    ['add', 'subtract', 'multiply', 'divide', ...Object.keys(COMPARISON_OPERATORS)])
  const result = render({ value: { source: 'step-output', step_id: 'measure-1', pointer: '/value' } })
  assert.ok(result.some(node => node.type === 'select' && node.props.value === 'measure-1'))
})

test('actual Assert and While operand editor retains boolean literals and step results', async () => {
  const render = await valueEditor('ExpressionOperandEditor')
  let changed
  const nodes = render({ side: 'Left', allowBooleanLiteral: true,
    value: { source: 'literal', value: true }, onChange: value => { changed = value } })
  assert.deepEqual(fieldOptions(nodes, 'Left Source'), ['literal', 'variable', 'step-output'])
  assert.deepEqual(fieldOptions(nodes, 'Value type'), ['number', 'boolean'])
  const boolean = nodes.find(node => node.type === 'select' && node.props.value === 'true')
  assert.ok(boolean)
  boolean.props.onChange({ target: { value: 'false' } })
  assert.deepEqual(changed, { source: 'literal', value: false })
})
