import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scopesChannelNumbers, updateScopesAcquisition, updateScopesChannel } from '../src/scopesSetup.ts'
import { SCOPES_ACTIONS, scopesActionArguments } from '../src/scopesActions.ts'
import { curatedResultFields } from '../src/inputValue.ts'

const caps = { model_id: 'tektronix-tds2024b', model_name: 'TDS2024B', analog_channels: 4,
  acquisition_modes: ['normal', 'average', 'peak'], average_counts: [4, 16, 64, 128], screenshot_formats: ['bmp'], measurement_items: ['pair-only'],
  direct_measurement_items: ['vpp', 'frequency'], trigger_edge_slopes: ['positive', 'negative'],
  capture_point_options: [1000, 5000], autoscale_supported: false }

test('Scopes unchanged omits settings and retains configured unsupported channels', () => {
  const original = { acquisition: { acquisition_type: 'average', average_count: 16 }, channels: [{ channel: 4, invert: true }] }
  const next = updateScopesChannel(original, 1, 'bandwidth_limit', false)
  assert.deepEqual(next.channels, [{ channel: 1, bandwidth_limit: false }, { channel: 4, invert: true }])
  assert.deepEqual(scopesChannelNumbers({ ...caps, analog_channels: 2 }, next), [1, 2, 4])
  assert.deepEqual(updateScopesChannel(updateScopesAcquisition({}, {}), 1, 'invert', undefined), {})
  assert.deepEqual(original.channels, [{ channel: 4, invert: true }])
})

test('Scopes exposes exactly the agreed actions and structured Measure output references', () => {
  assert.deepEqual(SCOPES_ACTIONS.map(([action]) => action), ['channel-display', 'channel-scale', 'channel-offset', 'timebase-scale', 'timebase-position', 'trigger-edge', 'single-wait', 'measure', 'capture', 'screenshot', 'autoscale'])
  assert.deepEqual(scopesActionArguments('capture'), { channel: [1], points: 1000 })
  assert.deepEqual(scopesActionArguments('autoscale'), {})
  assert.deepEqual(scopesActionArguments('single-wait'), { trigger_timeout_ms: 5000, trigger_poll_interval_ms: 100 })
  for (const [action] of SCOPES_ACTIONS) {
    assert.ok(!['csv', 'meta', 'output', 'query_hardcopy', 'model', 'resource'].some(key => key in scopesActionArguments(action)))
  }
  assert.deepEqual(curatedResultFields({ type: 'tool-action', target: 'scope', action: 'measure' }, [{ id: 'scope', tool: 'scopes' }]).map(field => field.pointer), ['/value', '/valid', '/unit', '/channel', '/item'])
  const measureValid = curatedResultFields({ type: 'tool-action', target: 'scope', action: 'measure' }, [{ id: 'scope', tool: 'scopes' }]).find(field => field.pointer === '/valid')
  assert.equal(measureValid.label, 'Valid')
  assert.match(measureValid.hint, /Boolean.*false.*invalid measurement sentinel/)
  assert.deepEqual(curatedResultFields({ type: 'tool-action', target: 'scope', action: 'single-wait' }, [{ id: 'scope', tool: 'scopes' }]).map(field => field.pointer), ['/outcome', '/timed_out', '/capture_allowed'])
})
