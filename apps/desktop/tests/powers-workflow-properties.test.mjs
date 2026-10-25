import { templateDraftJson, workflowOnlyDraft } from '../src/templateDraft.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { transformWithOxc } from 'vite'
import { hasPowerSetpoint, powerSetpointLiteralDefault, togglePowerSetpoint } from '../src/powerSetpoint.ts'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const context = app.slice(app.indexOf('  const selectedPowersAction ='), app.indexOf('\n  return (', app.indexOf('  const selectedPowersAction =')))
const fields = app.slice(app.indexOf('                      {selectedToolAction && selectedPowersAction && ('),
  app.indexOf("                      {selectedAction === 'meters/measure' && ("))
const handlers = app.slice(app.indexOf('  const updateToolArgument ='), app.indexOf('  const moveStep ='))
const roundTrip = draft => workflowOnlyDraft(JSON.parse(templateDraftJson(draft, [], false)))
const { code } = await transformWithOxc(`function properties(params) {
  const { selectedToolAction, selectedAction, workflowDraft, executionMode, resourceIdentityDrafts,
    powersCapabilityChannels, powersCapabilityKey, workflowBusy, updateStep } = params
  const selectedStep = selectedToolAction
  const earlierSteps = [], earlierVariables = []
  const useCallback = fn => fn
  ${handlers}
  ${context}
  return <>${fields}</>
}`, 'properties.tsx', { jsx: { runtime: 'classic' } })
const render = new Function('React', 'InputValueEditor', 'hasPowerSetpoint', 'powerSetpointLiteralDefault',
  'togglePowerSetpoint', 'numericArgument', 'isPositiveInteger', 'stepLabel', `${code}; return properties`)(
  React, () => null, hasPowerSetpoint, powerSetpointLiteralDefault, togglePowerSetpoint,
  (step, name) => typeof step.arguments[name] === 'number' ? step.arguments[name] : '',
  value => Number.isSafeInteger(value) && value >= 1, () => '')

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements)
  return React.isValidElement(node) ? [node, ...elements(node.props.children)] : []
}

function editor(action = 'set-output', arguments_ = { channel: 1, voltage: 0, current: 0 }, bindings) {
  let value = { type: 'tool-action', id: 'power-step', target: 'power-1', action, arguments: arguments_,
    ...(bindings ? { bindings } : {}) }
  let changes = 0
  const params = {
    selectedAction: `powers/${action}`, workflowBusy: false, executionMode: 'simulate',
    workflowDraft: { tool_instances: [{ id: 'power-1', tool: 'powers' }, { id: 'power-2', tool: 'powers' }] },
    resourceIdentityDrafts: { 'power-1': { model_id: 'one' }, 'power-2': { model_id: 'other' } },
    powersCapabilityKey: 'simulation',
    powersCapabilityChannels: { key: 'simulation', models: { simulator: { status: 'ready', channels: [2, 5] } } },
    updateStep: (id, update) => { assert.equal(id, value.id); value = update(value); changes++ },
  }
  return {
    params,
    get value() { return value },
    get changes() { return changes },
    target(target) { value = { ...value, target } },
    view() {
      const tree = render({ ...params, selectedToolAction: value })
      const nodes = elements(tree)
      return {
        nodes,
        channel: nodes.find(node => node.type === 'select' && node.props['aria-label'] === 'Channel'),
        selection: nodes.find(node => node.type === 'select' && elements(node).some(child => child.props.value === 'specific')),
        text: nodes.filter(node => node.type === 'p').map(node => node.props.children).flat().join(' '),
        checkboxes: nodes.filter(node => node.props.type === 'checkbox'),
        inputs: nodes.filter(node => typeof node.type === 'function'),
      }
    },
  }
}

function options(select) {
  assert.ok(select, 'Channel must render a select')
  return elements(select).filter(node => node.type === 'option' && !node.props.disabled).map(node => node.props.value)
}

test('all five Powers actions select only confirmed capability channels and write numbers', () => {
  for (const action of ['set-output', 'set-voltage', 'output-on', 'output-off', 'protection-status']) {
    const state = editor(action)
    const view = state.view()
    assert.deepEqual(options(view.channel), [2, 5], action)
    assert.equal(view.channel.props.value, '1')
    assert.match(view.text, /not supported/)
    assert.equal(state.changes, 0)
    view.channel.props.onChange({ target: { value: '5' } })
    assert.equal(state.value.arguments.channel, 5)
  }
})

test('legacy channels and bindings survive rendering and JSON reload until explicitly replaced', () => {
  for (const action of ['set-output', 'set-voltage', 'output-on', 'output-off', 'protection-status']) {
    for (const binding of [undefined, { source: 'variable', variable: 'selected-channel' }]) {
      const state = editor(action, { channel: 99, voltage: 7 }, binding ? {
        channel: binding, voltage: { source: 'variable', variable: 'volts' },
      } : undefined)
      const original = structuredClone(state.value)
      const view = state.view()
      assert.equal(state.changes, 0)
      assert.deepEqual(roundTrip({ workflow: { steps: [state.value] } }).workflow.steps[0], original)
      if (binding) {
        assert.equal(view.channel.props.value, '')
        assert.match(view.text, /binding preserved/i)
        if (action === 'protection-status') assert.equal(view.selection.props.value, 'specific')
      }
      view.channel.props.onChange({ target: { value: '99' } })
      assert.deepEqual(state.value, original)
      view.channel.props.onChange({ target: { value: '2' } })
      assert.equal(state.value.arguments.channel, 2)
      assert.equal(state.value.bindings?.channel, undefined)
      if (binding) assert.deepEqual(state.value.bindings.voltage, original.bindings.voltage)
    }
  }
  const boundAll = editor('protection-status', { channel: 'all' }, { channel: { source: 'variable', variable: 'ch' } })
  assert.equal(boundAll.view().selection.props.value, 'specific')
  assert.equal(boundAll.view().channel.props.value, '')
})

test('Target, mode, canonical model and executable keys select the matching channels', () => {
  const state = editor()
  state.params.executionMode = 'live'
  state.params.powersCapabilityKey = 'live-executable'
  state.params.powersCapabilityChannels = { key: 'live-executable', models: {
    one: { status: 'ready', channels: [1] }, other: { status: 'ready', channels: [4, 7] },
  } }
  assert.deepEqual(options(state.view().channel), [1])
  state.target('power-2')
  assert.deepEqual(options(state.view().channel), [4, 7])
  assert.equal(state.value.arguments.channel, 1)
  state.params.powersCapabilityKey = 'new-executable'
  assert.deepEqual(options(state.view().channel), [])
  assert.match(state.view().text, /Loading/)
  state.params.executionMode = 'simulate'
  state.params.powersCapabilityKey = 'simulation'
  assert.deepEqual(options(state.view().channel), [])
  state.params.powersCapabilityChannels = { key: 'simulation', models: { simulator: { status: 'ready', channels: [2, 5] } } }
  assert.deepEqual(options(state.view().channel), [2, 5])
  assert.equal(state.changes, 0)
})

test('loading, missing Live model, failed queries and empty channels show distinct hints', () => {
  const state = editor()
  state.params.powersCapabilityChannels = null
  assert.equal(state.view().channel.props.disabled, true)
  assert.match(state.view().text, /Loading/)
  state.params.executionMode = 'live'
  state.params.resourceIdentityDrafts = {}
  assert.match(state.view().text, /supported Live Resource/)
  assert.deepEqual(options(state.view().channel), [])
  state.params.executionMode = 'simulate'
  state.params.powersCapabilityChannels = { key: 'simulation', models: { simulator: { status: 'error' } } }
  assert.match(state.view().text, /failed/i)
  state.params.powersCapabilityChannels.models.simulator = { status: 'ready', channels: [] }
  assert.match(state.view().text, /No supported channels/)
  assert.match(state.view().text, /not supported/)
  assert.equal(state.value.arguments.channel, 1)
  assert.equal(state.changes, 0)
})

test('missing channel data stays unset, observed channels are not options, and busy controls are disabled', () => {
  const state = editor('output-on', {})
  state.params.powersStatuses = { 'power-1': { status: { channels: [{ channel: 99 }] } } }
  state.params.workflowDraft.tool_instances[0].setup = { protection: { channels: [{ channel: 99 }] } }
  assert.deepEqual(options(state.view().channel), [2, 5])
  assert.equal(state.view().channel.props.value, '')
  assert.deepEqual(state.value.arguments, {})
  assert.equal(state.changes, 0)
  state.params.workflowBusy = true
  assert.equal(state.view().channel.props.disabled, true)
  const setpoints = editor()
  setpoints.params.workflowBusy = true
  assert.ok(setpoints.view().checkboxes.every(checkbox => checkbox.props.disabled))
  assert.ok(setpoints.view().inputs.every(input => input.props.disabled))
})

test('Protection All is preserved; Specific needs capabilities and uses their first channel', () => {
  const state = editor('protection-status', { channel: 'all' })
  let view = state.view()
  assert.equal(view.selection.props.value, 'all')
  assert.equal(view.channel, undefined)
  assert.equal(state.changes, 0)
  view.selection.props.onChange({ target: { value: 'specific' } })
  assert.equal(state.value.arguments.channel, 2)
  state.view().selection.props.onChange({ target: { value: 'all' } })
  assert.equal(state.value.arguments.channel, 'all')
  for (const capability of [null, { status: 'error' }, { status: 'ready', channels: [] }]) {
    state.params.powersCapabilityChannels = capability ? { key: 'simulation', models: { simulator: capability } } : null
    view = state.view()
    const specific = elements(view.selection).find(node => node.props.value === 'specific')
    assert.equal(specific.props.disabled, true)
    assert.match(view.text, /Specific channel is unavailable/)
    view.selection.props.onChange({ target: { value: 'specific' } })
    assert.equal(state.value.arguments.channel, 'all')
    assert.equal(state.view().channel, undefined)
  }
})

test('setpoint labels, help and units accompany horizontal clickable checkbox labels', () => {
  const state = editor()
  const view = state.view()
  assert.equal(view.checkboxes.length, 2)
  for (const checkbox of view.checkboxes) {
    const label = view.nodes.find(node => node.type === 'label' && elements(node).includes(checkbox))
    assert.match(label.props.className, /step-property-checkbox/)
    assert.equal(label.props.children[0], checkbox)
  }
  assert.match(view.text, /Set the channel's output voltage\. Uncheck to leave the existing voltage setting unchanged\./)
  assert.match(view.text, /Set the maximum allowed output current, not a forced output current\. Uncheck to leave the existing limit unchanged\./)
  assert.deepEqual(view.inputs.map(node => node.props.literalLabel), ['Voltage (V)', 'Current Limit (A)'])
  assert.deepEqual(view.inputs.map(node => node.props.value.value), [0, 0])
  assert.match(app, /This step only configures the setpoints\. Use Power Output ON separately to enable the output\./)
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.powers-protection-toggle,\s*\.step-property-checkbox\s*\{[^}]*display: flex;[^}]*align-items: center;[^}]*gap: 8px;/)
})

test('checkbox handlers hide removed fields, keep one setpoint and preserve other bindings and values', () => {
  const state = editor('set-output', { channel: 2, voltage: 0, current: 0.25 }, {
    current: { source: 'expression', left: { source: 'literal', value: 1 }, operator: 'add', right: { source: 'literal', value: 2 } },
    channel: { source: 'variable', variable: 'ch' },
  })
  assert.equal(state.view().inputs[1].props.value.source, 'expression')
  state.view().checkboxes[1].props.onChange({ target: { checked: false } })
  assert.deepEqual(state.value.arguments, { channel: 2, voltage: 0 })
  assert.deepEqual(state.value.bindings, { channel: { source: 'variable', variable: 'ch' } })
  assert.equal(state.view().inputs.length, 1)
  assert.equal(state.view().checkboxes[0].props.disabled, true)
  state.view().checkboxes[0].props.onChange({ target: { checked: false } })
  assert.equal(state.value.arguments.voltage, 0)
  state.view().checkboxes[1].props.onChange({ target: { checked: true } })
  assert.equal(state.value.arguments.current, 1)
  assert.equal(state.value.arguments.voltage, 0)
  for (const value of [{ source: 'variable', variable: 'limit' }, { source: 'expression', left: { source: 'variable', variable: 'limit' }, operator: 'multiply', right: { source: 'literal', value: 2 } },
    { source: 'expression', left: { source: 'literal', value: 1 }, operator: 'add', right: { source: 'literal', value: 2 } }]) {
    state.view().inputs[1].props.onChange(value)
    assert.deepEqual(state.value.bindings.current, value)
    assert.deepEqual(state.view().inputs[1].props.value, value)
  }
  state.view().inputs[1].props.onChange({ source: 'literal', value: 0 })
  assert.equal(state.value.arguments.current, 0)
  assert.equal(state.value.bindings.current, undefined)
  assert.deepEqual(state.value.bindings.channel, { source: 'variable', variable: 'ch' })
  const legacy = editor('set-voltage', { channel: 2, voltage: 8 })
  assert.equal(legacy.view().checkboxes.length, 0)
  assert.equal(legacy.view().inputs[0].props.value.value, 8)
})

const modelContext = app.slice(app.indexOf('  const powersModels ='), app.indexOf('  const [draftLoading,'))
const queryStart = app.lastIndexOf('  useEffect(() => {', app.indexOf('void Promise.all(powersModels.map'))
const query = app.slice(queryStart, app.indexOf('  const outputSteps =', queryStart))
const { code: queryCode } = await transformWithOxc(`function queryChannels(params, invoke, setPowersCapabilityChannels) {
  const { workflowDraft, executionMode, powersExecutableKey, resourceIdentityDrafts } = params
  ${modelContext}
  let cleanup
  const useEffect = effect => { cleanup = effect() }
  ${query}
  return { cleanup, key: powersCapabilityKey }
}`, 'query.ts', {})
const queryChannels = new Function(`${queryCode}; return queryChannels`)()
const settled = () => new Promise(resolve => setImmediate(resolve))

test('existing cache queries simulator or distinct canonical Live models and separates errors from empty success', async () => {
  const params = {
    executionMode: 'live', powersExecutableKey: 'exe-a',
    workflowDraft: { tool_instances: [{ id: 'a', tool: 'powers' }, { id: 'b', tool: 'powers' },
      { id: 'c', tool: 'powers' }, { id: 'missing', tool: 'powers' }, { id: 'meter', tool: 'meters' }] },
    resourceIdentityDrafts: { a: { model_id: 'canonical-a', model: 'Display A' },
      b: { model_id: 'canonical-b' }, c: { model_id: 'canonical-a' }, meter: { model_id: 'meter-model' } },
  }
  const calls = []
  let loaded = null
  const first = queryChannels(params, async (command, args) => {
    calls.push([command, args])
    if (args.modelId === 'canonical-b') throw new Error('Offline query failed')
    return { channels: [] }
  }, next => { loaded = next })
  assert.equal(loaded, null)
  await settled()
  assert.deepEqual(calls, ['canonical-a', 'canonical-b'].map(modelId => [
    'get_powers_capabilities', { modelId, executionMode: 'live' },
  ]))
  assert.deepEqual(loaded, { key: first.key, models: {
    'canonical-a': { status: 'ready', channels: [] }, 'canonical-b': { status: 'error' },
  } })
  const keys = new Set([first.key])
  for (const next of [{ ...params, executionMode: 'simulate' }, { ...params, powersExecutableKey: 'exe-b' },
    { ...params, resourceIdentityDrafts: { a: { model_id: 'new-model' } } }]) {
    const request = queryChannels(next, async (_, args) => {
      if (next.executionMode === 'simulate') assert.equal(args.modelId, null)
      return { channels: [8] }
    }, result => { loaded = result })
    keys.add(request.key)
    await settled()
    if (next.executionMode === 'simulate') assert.deepEqual(loaded.models.simulator, { status: 'ready', channels: [8] })
  }
  assert.equal(keys.size, 4)
  assert.equal((app.match(/'get_powers_capabilities'/g) ?? []).length, 1, 'Workflow reuses the existing App query')
})

test('cancelled capability requests cannot overwrite the current mode or executable cache', async () => {
  const params = { executionMode: 'simulate', powersExecutableKey: 'old-exe', resourceIdentityDrafts: {}, workflowDraft: null }
  let resolveOld
  let loaded
  const old = queryChannels(params, () => new Promise(resolve => { resolveOld = resolve }), next => { loaded = next })
  old.cleanup()
  const current = queryChannels({ ...params, powersExecutableKey: 'new-exe' }, async () => ({ channels: [6] }), next => { loaded = next })
  await settled()
  resolveOld({ channels: [1, 2, 3] })
  await settled()
  assert.deepEqual(loaded, { key: current.key, models: { simulator: { status: 'ready', channels: [6] } } })
})

test('Powers Set Voltage and both Set Output fields use the shared Numeric Setpoint mode', () => {
  for (const action of ['set-voltage', 'set-output']) {
    const fields = editor(action).view().inputs
    assert.equal(fields.length, action === 'set-voltage' ? 1 : 2)
    assert.ok(fields.every(field => field.props.numericSetpoint === true))
    assert.deepEqual(fields.map(field => field.props.sourceLabel),
      action === 'set-voltage' ? ['Voltage Source'] : ['Voltage Source', 'Current Limit Source'])
  }
})
