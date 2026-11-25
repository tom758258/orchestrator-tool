import { english } from './presentation-fixture.mjs'
import { translate } from '../src/i18n/index.ts'
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
const powerMeasure = {
  type: 'tool-action', id: 'power-measure-1', target: 'power-1', action: 'measure', arguments: { channel: 1 },
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

test('Power Measure exposes actual voltage and current from Worker data', () => {
  assert.deepEqual(curatedResultFields(powerMeasure, instances), [
    { label: 'Voltage', pointer: '/data/measurements/voltage' },
    { label: 'Current', pointer: '/data/measurements/current' },
    { label: 'Channel', pointer: '/data/channel' },
  ])
  assert.deepEqual(stepOutputReference(powerMeasure, instances), {
    source: 'step-output', step_id: 'power-measure-1', pointer: '/data/measurements/voltage',
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
  const fields = curatedResultFields(powerProtectionStatus, instances)
  assert.deepEqual(fields.map(({ label, pointer }) => ({ label, pointer })), [
    { label: 'Protection Tripped', pointer: '/protection_tripped' },
    { label: 'Over Voltage Tripped', pointer: '/over_voltage_tripped' },
    { label: 'Over Current Tripped', pointer: '/over_current_tripped' },
  ])
  assert.ok(fields.every(field => field.hint?.includes('Boolean')))
  assert.deepEqual(stepOutputReference(powerProtectionStatus, instances), {
    source: 'step-output', step_id: 'protection-1', pointer: '/protection_tripped',
  })
})

test('Serial read results expose timeout and partial RX pointers', () => {
  const serialInstances = [{ id: 'serial-1', tool: 'serial' }]
  for (const action of ['receive', 'query']) {
    const step = { type: 'tool-action', id: 'rx-1', target: 'serial-1', action }
    const fields = curatedResultFields(step, serialInstances)
    assert.deepEqual(fields.filter(field =>
      ['/outcome', '/timed_out', '/partial_rx_hex', '/partial_rx_bytes'].includes(field.pointer)
    ).map(field => field.pointer),
    ['/outcome', '/timed_out', '/partial_rx_hex', '/partial_rx_bytes'])
    assert.ok(fields.filter(field => field.pointer.startsWith('/partial_')).every(field => field.hint))
    assert.match(fields.find(field => field.pointer === '/rx_hex')?.hint ?? '', /String/)
    assert.match(fields.find(field => field.pointer === '/rx_bytes')?.hint ?? '', /Number/)
    assert.equal(stepOutputReference(step, serialInstances).pointer, '/rx_hex')
  }
})


test('Serial UTF-8 fields appear only for explicitly enabled foreground RX', () => {
  const devices = [{ id: 'serial-1', tool: 'serial' }]
  for (const action of ['receive', 'query']) {
    const base = { type: 'tool-action', id: 'rx-1', target: 'serial-1', action }
    const defaultFields = curatedResultFields(base, devices)
    assert.equal(defaultFields.some(field => field.pointer === '/rx_text'), false)
    const enabledFields = curatedResultFields({
      ...base, arguments: { enable_rx_text: true },
    }, devices)
    assert.ok(enabledFields.find(field => field.pointer === '/rx_text')?.hint)
    assert.ok(enabledFields.find(field => field.pointer === '/partial_rx_text')?.hint)
    assert.ok(enabledFields.some(field => field.pointer === '/rx_bytes'))
    assert.ok(enabledFields.some(field => field.pointer === '/partial_rx_bytes'))
  }
})

test('Background Get Latest and Wait Next offer actual tool result fields', () => {
  const devices = [...instances, { id: 'serial-1', tool: 'serial' }, { id: 'scope-1', tool: 'scopes' }]
  const backgrounds = [
    { id: 'meter-bg', tool_instance_id: 'meter-1' },
    { id: 'serial-bg', tool_instance_id: 'serial-1' },
    { id: 'scope-bg', tool_instance_id: 'scope-1', scopes_measurements: [{ id: 'ch1_frequency' }, { id: 'ch2_vpp' }] },
  ]
  const get = (id, background_id, kind = 'get-latest') => ({
    type: 'bg-interaction', id, background_id, operation: { kind },
  })
  const meter = get('latest-meter', 'meter-bg')
  assert.deepEqual(curatedResultFields(meter, devices, english, backgrounds).map(field => field.label),
    ['Value', 'Unit'])
  assert.equal(stepOutputReference(meter, devices, backgrounds).pointer, '/value')
  const serial = get('next-serial', 'serial-bg', 'wait-next')
  assert.deepEqual(curatedResultFields(serial, devices, english, backgrounds).map(field => field.pointer),
    ['/rx_hex', '/rx_bytes'])
  assert.equal(stepOutputReference(serial, devices, backgrounds).pointer, '/rx_hex')
  const scope = get('latest-scope', 'scope-bg')
  assert.deepEqual(curatedResultFields(scope, devices, english, backgrounds).map(field => field.pointer), [
    '/values/ch1_frequency/value', '/values/ch1_frequency/valid', '/values/ch1_frequency/unit',
    '/values/ch2_vpp/value', '/values/ch2_vpp/valid', '/values/ch2_vpp/unit',
  ])
  assert.equal(stepOutputReference(scope, devices, backgrounds).pointer, '/values/ch1_frequency/value')
  assert.deepEqual(curatedResultFields(get('unknown', 'missing'), devices, english, backgrounds), [])
})

test('Background Get Command Result respects source command and nested native payload', () => {
  const devices = [...instances, { id: 'serial-1', tool: 'serial' }]
  const backgrounds = [{ id: 'serial-bg', tool_instance_id: 'serial-1' }, { id: 'meter-bg', tool_instance_id: 'meter-1' }]
  const source = (id, background_id, command) => ({
    type: 'bg-interaction', id, background_id, operation: { kind: 'command', command },
  })
  const get = (background_id, source_step) => ({
    type: 'bg-interaction', id: 'get-result', background_id,
    operation: { kind: 'get-command-result', source_step },
  })
  const send = source('send', 'serial-bg', 'serial-send')
  const file = source('file', 'serial-bg', 'serial-send-file')
  const trigger = source('trigger', 'meter-bg', 'software-trigger')
  assert.deepEqual(curatedResultFields(get('serial-bg', 'send'), devices, english, backgrounds, [send])
    .map(field => field.pointer), ['/result/tx_hex', '/result/tx_bytes'])
  assert.deepEqual(curatedResultFields(get('serial-bg', 'file'), devices, english, backgrounds, [file])
    .map(field => field.pointer), ['/result/file_bytes', '/result/bytes_written'])
  assert.deepEqual(curatedResultFields(get('meter-bg', 'trigger'), devices, english, backgrounds, [trigger])
    .map(field => field.pointer), ['/value', '/unit'])
  assert.equal(stepOutputReference(get('serial-bg', 'file'), devices, backgrounds, [file]).pointer, '/result/file_bytes')
  assert.deepEqual(curatedResultFields(get('serial-bg', 'trigger'), devices, english, backgrounds, [trigger]), [])
  assert.deepEqual(curatedResultFields(get('serial-bg', 'absent'), devices, english, backgrounds, [send]), [])
  assert.equal(resultSelection('/result/private',
    curatedResultFields(get('serial-bg', 'send'), devices, english, backgrounds, [send])), CUSTOM_RESULT)
})

test('known and custom pointers select without rewriting the pointer', () => {
  const fields = curatedResultFields(powerSetOutput, instances)
  assert.equal(resultSelection('/request/arguments/channel', fields), '/request/arguments/channel')

  const existing = { source: 'step-output', step_id: 'set-output-1', pointer: '/data/custom' }
  assert.equal(resultSelection(existing.pointer, fields), CUSTOM_RESULT)
  assert.equal(existing.pointer, '/data/custom')
})

test('switching incompatible actions replaces the previous curated pointer', () => {
  const previous = stepOutputReference(meterMeasure, instances)
  const switched = stepOutputReference(powerSetOutput, instances)
  assert.equal(previous.pointer, '/value')
  assert.equal(switched.pointer, '/request/arguments/channel')
})

test('Powers Output On and Output Off have no curated results', () => {
  assert.deepEqual(curatedResultFields(powerOutputOn, instances), [])
  assert.deepEqual(curatedResultFields(powerOutputOff, instances), [])
})

test('structural steps are excluded from Step Output candidates', () => {
  const structuralSteps = [
    { type: 'set-variable', id: 'set-1' },
    { type: 'wait', id: 'wait-1' },
    { type: 'output', id: 'output-1' },
    { type: 'for', id: 'for-1' },
    { type: 'while', id: 'while-1' },
  ]
  assert.deepEqual(stepOutputCandidates([...structuralSteps, meterMeasure]), [meterMeasure])
})


test('both Process steps expose their value through the existing result picker', () => {
  const stringStep = { type: 'string-process', id: 'text', operation: 'length' }
  const byteStep = { type: 'byte-process', id: 'bytes', operation: { kind: 'get-byte' } }
  assert.deepEqual(stepOutputCandidates([stringStep, byteStep]), [stringStep, byteStep])
  for (const step of [stringStep, byteStep]) {
    assert.deepEqual(curatedResultFields(step, []), [{ label: 'Value', pointer: '/value' }])
    assert.deepEqual(stepOutputReference(step, []), {
      source: 'step-output', step_id: step.id, pointer: '/value',
    })
  }
})

test('Buffer and Array results expose the exact current contract pointers', () => {
  const batch = { type: 'bg-interaction', id: 'batch', operation: { kind: 'get-buffer-data' } }
  const status = { type: 'bg-interaction', id: 'status', operation: { kind: 'get-buffer-status' } }
  const item = { type: 'array-process', id: 'item', operation: 'get-item' }
  const fields = ['capacity', 'count', 'byte_capacity', 'buffered_bytes', 'full', 'overflowed', 'dropped_count']
  assert.deepEqual(stepOutputCandidates([batch, status, item]), [batch, status, item])
  assert.deepEqual(curatedResultFields(batch, []).map(field => field.pointer),
    ['/data', '/count', ...fields.map(name => '/status/' + name)])
  assert.deepEqual(curatedResultFields(status, []).map(field => field.pointer), fields.map(name => '/' + name))
  assert.equal(stepOutputReference(batch, []).pointer, '/data')
  assert.equal(stepOutputReference(item, []).pointer, '/value')
})

test('Process result labels describe general values without changing the pointer', () => {
  const zh = (key, params) => translate('zh-TW', key, params)
  for (const type of ['string-process', 'byte-process', 'array-process']) {
    const step = { type, id: 'process' }
    assert.deepEqual(curatedResultFields(step, instances, zh), [{ label: '處理結果', pointer: '/value' }])
    assert.equal(stepOutputReference(step, instances).pointer, '/value')
  }
  assert.equal(curatedResultFields(meterMeasure, instances, zh)[0].label, '數值')
})
