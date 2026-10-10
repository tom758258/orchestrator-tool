import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { transformWithOxc } from 'vite'
import { scopesChannelNumbers, updateScopesAcquisition, updateScopesChannel } from '../src/scopesSetup.ts'
import { SCOPES_ACTIONS, scopesActionArguments } from '../src/scopesActions.ts'
import { curatedResultFields } from '../src/inputValue.ts'

function elements(root) {
  const result = []
  function visit(node) {
    if (Array.isArray(node)) node.forEach(visit)
    else if (React.isValidElement(node)) { result.push(node); visit(node.props.children) }
  }
  visit(root)
  return result
}

async function setupEditor(invoke) {
  const source = fs.readFileSync(new URL('../src/ToolSetupEditor.tsx', import.meta.url), 'utf8')
  const { code } = await transformWithOxc(source, 'ToolSetupEditor.tsx', { jsx: { runtime: 'classic' } })
  const modules = { '@tauri-apps/api/core': { invoke } }
  const state = [], effects = []
  let cursor = 0
  modules.react = {
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], next => { state[i] = next }] },
    useEffect(callback, deps) {
      const i = cursor++
      if (!state[i] || deps.some((value, j) => value !== state[i].deps[j])) {
        state[i]?.cleanup?.()
        effects.push(() => { state[i] = { deps, cleanup: callback() } })
      }
    },
  }
  for (const [, path] of code.matchAll(/import .+? from "([^"]+)";/g)) {
    if (path.startsWith('.')) modules[path] = await import(`../src/${path}.ts`)
  }
  const body = code.replace(/import (.+?) from "([^"]+)";/g, (_, names, path) => `const ${names} = modules[${JSON.stringify(path)}];`)
    .replace(/export default function /, 'function ')
  const render = new Function('React', 'modules', `${body}; return ScopesSetupFields`)(React, modules)
  return props => { cursor = 0; const view = elements(render(props)); effects.splice(0).forEach(effect => effect()); return view }
}

const caps = { model_id: 'tektronix-tds2024b', model_name: 'TDS2024B', analog_channels: 4,
  acquisition_modes: ['normal', 'average', 'peak'], average_counts: [4, 16, 64, 128], screenshot_formats: ['bmp'], measurement_items: null }
const settle = () => new Promise(resolve => setImmediate(resolve))
const control = (view, label) => view.find(node => node.props['aria-label'] === label)

test('Scopes unchanged omits settings and retains configured unsupported channels', () => {
  const original = { acquisition: { acquisition_type: 'average', average_count: 16 }, channels: [{ channel: 4, invert: true }] }
  const next = updateScopesChannel(original, 1, 'bandwidth_limit', false)
  assert.deepEqual(next.channels, [{ channel: 1, bandwidth_limit: false }, { channel: 4, invert: true }])
  assert.deepEqual(scopesChannelNumbers({ ...caps, analog_channels: 2 }, next), [1, 2, 4])
  assert.deepEqual(updateScopesChannel(updateScopesAcquisition({}, {}), 1, 'invert', undefined), {})
  assert.deepEqual(original.channels, [{ channel: 4, invert: true }])
})

test('Scopes Setup loads offline capabilities and preserves settings across model changes', async () => {
  const calls = [], changes = []
  const render = await setupEditor(async (command, args) => { calls.push([command, args]); return { ...caps, analog_channels: args.modelId === 'two-channel' ? 2 : 4 } })
  const value = { acquisition: { acquisition_type: 'high_resolution', average_count: 32 }, channels: [{ channel: 4, invert: true }] }
  const props = { value, onChange: value => changes.push(value), executionMode: 'live', modelId: 'four-channel', scopesExecutableKey: 'scopes.exe' }
  render(props); await settle()
  let view = render(props)
  assert.equal(calls[0][0], 'get_scopes_capabilities')
  assert.deepEqual(calls[0][1], { modelId: 'four-channel', executionMode: 'live' })
  assert.equal(view.filter(node => node.type === 'tr').length, 5)
  assert.equal(control(view, 'Average Count').props.disabled, true)
  assert.equal(elements(control(view, 'Acquisition Type')).find(node => node.type === 'option' && node.props.value === 'high_resolution').props.disabled, true)
  render({ ...props, modelId: 'two-channel' }); await settle()
  view = render({ ...props, modelId: 'two-channel' })
  assert.equal(control(view, 'Channel 4 Waveform Invert').props.disabled, true)
  assert.equal(control(view, 'Channel 4 Waveform Invert').props.value, 'true')
  assert.equal(control(view, 'Acquisition Type').props.value, 'high_resolution')
  assert.equal(control(view, 'Average Count').props.value, 32)
  assert.equal(changes.length, 0)
})

test('Scopes Simulation capabilities need no resource and average count permits multi-digit input', async () => {
  const calls = []
  const render = await setupEditor(async (_, args) => { calls.push(args); return caps })
  let value = { acquisition: { acquisition_type: 'average' } }
  const props = () => ({ value, onChange: next => { value = next }, executionMode: 'simulate', modelId: undefined, scopesExecutableKey: 'scopes.exe' })
  render(props()); await settle()
  control(render(props()), 'Average Count').props.onChange({ target: { value: '1' } })
  assert.equal(value.acquisition.average_count, undefined)
  assert.equal(control(render(props()), 'Average Count').props.value, '1')
  control(render(props()), 'Average Count').props.onChange({ target: { value: '16' } })
  assert.equal(value.acquisition.average_count, 16)
  assert.deepEqual(calls, [{ modelId: undefined, executionMode: 'simulate' }])
})

test('Scopes missing Live model and failed capabilities disable controls with a visible explanation', async () => {
  let calls = 0
  const render = await setupEditor(async () => { calls++; throw 'offline capability failure' })
  const props = { value: { channels: [{ channel: 1, units: 'amp' }] }, onChange: () => assert.fail('must preserve setup'), executionMode: 'live', modelId: null, scopesExecutableKey: 'scopes.exe' }
  let view = render(props)
  assert.equal(calls, 0)
  assert.equal(control(view, 'Channel 1 Channel Units').props.disabled, true)
  render({ ...props, modelId: 'known' }); await settle()
  view = render({ ...props, modelId: 'known' })
  assert.equal(control(view, 'Acquisition Type').props.disabled, true)
  assert.ok(JSON.stringify(view).includes('offline capability failure'))
})

test('Scopes exposes exactly the agreed actions and structured Measure output references', () => {
  assert.deepEqual(SCOPES_ACTIONS.map(([action]) => action), ['channel-display', 'channel-scale', 'channel-offset', 'timebase-scale', 'timebase-position', 'trigger-edge', 'measure', 'capture', 'screenshot'])
  assert.deepEqual(scopesActionArguments('capture'), { channel: [1], points: 1000 })
  for (const [action] of SCOPES_ACTIONS) {
    assert.ok(!['csv', 'meta', 'output', 'query_hardcopy', 'model', 'resource'].some(key => key in scopesActionArguments(action)))
  }
  assert.deepEqual(curatedResultFields({ type: 'tool-action', target: 'scope', action: 'measure' }, [{ id: 'scope', tool: 'scopes' }]).map(field => field.pointer), ['/value', '/unit', '/channel', '/item'])
})

test('Scopes action editor uses existing bindings and retains invalid Capture input for worker validation', async () => {
  const source = fs.readFileSync(new URL('../src/ScopesActionEditor.tsx', import.meta.url), 'utf8')
  const { code } = await transformWithOxc(source, 'ScopesActionEditor.tsx', { jsx: { runtime: 'classic' } })
  const body = code.replace(/import InputValueEditor from "[^"]+";/, 'const InputValueEditor = "InputValueEditor";')
    .replace(/export default function /, 'function ')
  const render = new Function('React', `${body}; return ScopesActionEditor`)(React)
  let step = { type: 'tool-action', id: 'scale', target: 'scope', action: 'channel-scale', arguments: { channel: 1, volts_per_division: 1 } }
  const props = () => ({ step, instances: [], earlierSteps: [], earlierVariables: ['scale'], disabled: false, stepLabel: value => value.id, onChange: next => { step = next } })
  let field = elements(render(props())).find(node => node.props.literalLabel === 'Volts per Division')
  field.props.onChange({ source: 'variable', variable: 'scale' })
  assert.deepEqual(step.bindings.volts_per_division, { source: 'variable', variable: 'scale' })
  field = elements(render(props())).find(node => node.props.literalLabel === 'Volts per Division')
  field.props.onChange({ source: 'literal', value: 2 })
  assert.equal(step.arguments.volts_per_division, 2)
  assert.equal(step.bindings, undefined)
  step = { ...step, action: 'capture', arguments: { channel: [1], points: 1000 } }
  let input = elements(render(props())).find(node => node.type === 'input')
  const originalKey = input.key
  input.props.onBlur({ target: { value: '1, 2' } })
  assert.deepEqual(step.arguments.channel, [1, 2])
  input = elements(render(props())).find(node => node.type === 'input')
  assert.equal(input.props.defaultValue, '1, 2')
  assert.notEqual(input.key, originalKey)
  input.props.onBlur({ target: { value: 'invalid' } })
  assert.equal(step.arguments.channel, 'invalid')
})
