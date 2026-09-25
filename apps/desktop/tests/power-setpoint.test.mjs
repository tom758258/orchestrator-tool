import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasPowerSetpoint, powerSetpointLiteralDefault, togglePowerSetpoint } from '../src/powerSetpoint.ts'

test('optional power setpoints remove their argument and binding together', () => {
  const step = {
    type: 'tool-action', id: 'power-set-1', target: 'powers-1', action: 'set-output',
    arguments: { channel: 1, voltage: 5.0, current: 1.0 },
    bindings: { current: { source: 'variable', variable: 'limit' } },
  }
  const withoutCurrent = togglePowerSetpoint(step, 'current', false)
  assert.deepEqual(withoutCurrent.arguments, { channel: 1, voltage: 5.0 })
  assert.equal(withoutCurrent.bindings, undefined)
  assert.equal(hasPowerSetpoint(withoutCurrent, 'current'), false)
  assert.equal(togglePowerSetpoint(withoutCurrent, 'voltage', false), withoutCurrent)
  assert.deepEqual(togglePowerSetpoint(withoutCurrent, 'current', true).arguments,
    { channel: 1, voltage: 5.0, current: 1.0 })
})

test('power setpoint fixed values preserve zero and default only when missing', () => {
  const step = { type: 'tool-action', id: 'power-set-1', target: 'powers-1', action: 'set-output',
    arguments: { channel: 1, voltage: 0, current: 0 } }
  assert.equal(powerSetpointLiteralDefault(step, 'voltage'), 0)
  assert.equal(powerSetpointLiteralDefault(step, 'current'), 0)
  const withVariableSources = { ...step, bindings: {
    voltage: { source: 'variable', variable: 'target' },
    current: { source: 'variable', variable: 'limit' },
  } }
  assert.equal(powerSetpointLiteralDefault(withVariableSources, 'voltage'), 0)
  assert.equal(powerSetpointLiteralDefault(withVariableSources, 'current'), 0)
  assert.equal(powerSetpointLiteralDefault({ ...step, arguments: { channel: 1 } }, 'voltage'), 5.0)
  assert.equal(powerSetpointLiteralDefault({ ...step, arguments: { channel: 1 } }, 'current'), 1.0)
})
