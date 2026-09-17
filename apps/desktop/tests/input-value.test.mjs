import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stepOutputReference } from '../src/inputValue.ts'

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

test('step output defaults follow the selected earlier step', () => {
  assert.deepEqual(stepOutputReference(meterMeasure, instances), {
    source: 'step-output', step_id: 'measure-1', pointer: '/value',
  })
  assert.deepEqual(stepOutputReference(powerSetVoltage, instances), {
    source: 'step-output', step_id: 'set-voltage-1', pointer: '',
  })

  const previous = stepOutputReference(meterMeasure, instances)
  const switched = stepOutputReference(powerSetVoltage, instances)
  assert.equal(previous.pointer, '/value')
  assert.equal(switched.pointer, '')
})
