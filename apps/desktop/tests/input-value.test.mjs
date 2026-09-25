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
