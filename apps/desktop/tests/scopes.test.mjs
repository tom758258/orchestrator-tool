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

async function componentEditor(file, component, invoke) {
  const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
  const { code } = await transformWithOxc(source, file, { jsx: { runtime: 'classic' } })
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
    if (path === './InputValueEditor') modules[path] = 'InputValueEditor'
    else if (path.startsWith('.')) modules[path] = await import(`../src/${path}.ts`)
  }
  const body = code.replace(/import (.+?) from "([^"]+)";/g, (_, names, path) => `const ${names} = modules[${JSON.stringify(path)}];`)
    .replace(/export default function /, 'function ')
  const render = new Function('React', 'modules', `${body}; return ${component}`)(React, modules)
  return props => { cursor = 0; const view = elements(render(props)); effects.splice(0).forEach(effect => effect()); return view }
}

const setupEditor = invoke => componentEditor('ToolSetupEditor.tsx', 'ScopesSetupFields', invoke)
const actionEditor = invoke => componentEditor('ScopesActionEditor.tsx', 'ScopesActionEditor', invoke)

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
  assert.equal(control(view, 'Acquisition Type').props.disabled, true)
  assert.equal(control(view, 'Average Count').props.disabled, true)
  assert.ok(JSON.stringify(view).includes('Select or refresh a supported Live Resource'))
  assert.equal(control(view, 'Channel 1 Channel Units').props.disabled, true)
  render({ ...props, modelId: 'known' }); await settle()
  view = render({ ...props, modelId: 'known' })
  assert.equal(control(view, 'Acquisition Type').props.disabled, true)
  assert.equal(control(view, 'Average Count').props.disabled, true)
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

test('Scopes Acquisition groups each control with its own hints in exactly two fields', async () => {
  const render = await setupEditor(async () => ({ ...caps, average_counts: Array.from({ length: 65535 }, (_, i) => i + 2) }))
  const props = { value: {}, onChange: () => assert.fail('render must not write setup'), executionMode: 'simulate', scopesExecutableKey: 'scopes.exe' }
  render(props); await settle()
  const view = render(props)
  const grid = view.find(node => node.props.className === 'scopes-acquisition-fields')
  const fields = React.Children.toArray(grid.props.children)
  assert.equal(fields.length, 2)
  assert.ok(control(elements(fields[0]), 'Acquisition Type'))
  assert.ok(control(elements(fields[1]), 'Average Count'))
  const hints = elements(fields[1]).filter(node => node.type === 'p')
  assert.equal(hints[0].props.children, 'Requires Acquisition Type = Average.')
  assert.equal(hints[1].props.children.join(''), 'Supported counts: 2–65536 (65535 supported integers).')
  assert.ok(hints.every(node => node.props.className === 'tool-setup-hint'))
  assert.equal(control(view, 'Acquisition Type').props.value, '')
  assert.equal(control(view, 'Average Count').props.value, '')
})

test('Scopes Average Count retains gating, unchanged, validation and type-change clearing', async () => {
  const render = await setupEditor(async () => ({ ...caps, acquisition_modes: ['normal', 'average', 'peak', 'high_resolution'] }))
  let value = {}
  const props = () => ({ value, onChange: next => { value = next }, executionMode: 'simulate', scopesExecutableKey: 'scopes.exe' })
  render(props()); await settle()
  assert.equal(control(render(props()), 'Average Count').props.disabled, true)
  for (const mode of ['normal', 'peak', 'high_resolution']) {
    control(render(props()), 'Acquisition Type').props.onChange({ target: { value: mode } })
    assert.equal(control(render(props()), 'Average Count').props.disabled, true)
  }
  control(render(props()), 'Acquisition Type').props.onChange({ target: { value: 'average' } })
  assert.equal(control(render(props()), 'Average Count').props.disabled, false)
  control(render(props()), 'Average Count').props.onChange({ target: { value: '16' } })
  assert.equal(value.acquisition.average_count, 16)
  control(render(props()), 'Average Count').props.onChange({ target: { value: '17' } })
  assert.equal(value.acquisition.average_count, 16)
  control(render(props()), 'Average Count').props.onBlur()
  assert.equal(control(render(props()), 'Average Count').props.value, 16)
  control(render(props()), 'Average Count').props.onChange({ target: { value: '' } })
  assert.deepEqual(value, { acquisition: { acquisition_type: 'average' } })
  assert.equal(control(render(props()), 'Average Count').props.value, '')
  for (const mode of ['normal', 'peak', 'high_resolution', '']) {
    value = { acquisition: { acquisition_type: 'average', average_count: 16 } }
    control(render(props()), 'Acquisition Type').props.onChange({ target: { value: mode } })
    assert.deepEqual(value, mode ? { acquisition: { acquisition_type: mode } } : {})
  }
})

test('Scopes Average Count requires both Average mode and count capability support', async () => {
  for (const overrides of [{ acquisition_modes: ['normal'] }, { average_counts: [] }, { average_counts: null }]) {
    const render = await setupEditor(async () => ({ ...caps, ...overrides }))
    const props = { value: { acquisition: { acquisition_type: 'average', average_count: 16 } },
      onChange: () => assert.fail('unsupported saved setup must be preserved'), executionMode: 'simulate', scopesExecutableKey: 'scopes.exe' }
    render(props); await settle()
    assert.equal(control(render(props), 'Average Count').props.disabled, true)
    assert.equal(control(render(props), 'Average Count').props.value, 16)
  }
})

const screenshotProps = (overrides = {}) => ({
  step: { type: 'tool-action', id: 'image', target: 'scope', action: 'screenshot', arguments: { format: 'png' } },
  instances: [{ id: 'scope', tool: 'scopes', setup: {} }], earlierSteps: [], earlierVariables: [],
  disabled: false, onChange: () => assert.fail('capability loading must not change a step'), stepLabel: step => step.id,
  executionMode: 'simulate', scopesExecutableKey: 'scopes.exe', ...overrides,
})

for (const formats of [['png', 'bmp', 'bmp8bit'], ['bmp'], []]) {
  test(`Scopes Screenshot gates every visible format from capabilities ${JSON.stringify(formats)}`, async () => {
    const calls = [], changes = []
    const render = await actionEditor(async (command, args) => { calls.push([command, args]); return { ...caps, screenshot_formats: formats } })
    const props = screenshotProps({ modelId: 'saved-live-model', onChange: step => changes.push(step) })
    assert.equal(control(render(props), 'Image Format').props.disabled, true)
    await settle()
    const view = render(props)
    const select = control(view, 'Image Format')
    assert.equal(select.props.disabled, formats.length === 0)
    const options = elements(select).filter(node => node.type === 'option')
    assert.deepEqual(options.map(node => node.props.value), ['png', 'bmp', 'bmp8bit'])
    for (const option of options) {
      assert.equal(option.props.disabled, !formats.includes(option.props.value))
      select.props.onChange({ target: { value: option.props.value } })
    }
    assert.deepEqual(changes.map(step => step.arguments.format), formats)
    assert.deepEqual(calls, [['get_scopes_capabilities', { modelId: undefined, executionMode: 'simulate' }]])
    assert.equal(select.props.value, 'png')
    if (!formats.includes('png')) assert.ok(JSON.stringify(view).includes('existing Image Format preserved'))
    if (!formats.length) assert.ok(JSON.stringify(view).includes('Screenshot formats are unavailable'))
    assert.equal(props.step.arguments.format, 'png')
    changes.length = 0
    control(render({ ...props, disabled: true }), 'Image Format').props.onChange({ target: { value: 'bmp' } })
    assert.equal(changes.length, 0)
  })
}

test('Scopes Screenshot reloads canonical Live model, instance and EXE without overwriting parameters', async () => {
  const calls = []
  const render = await actionEditor(async (command, args) => { calls.push([command, args]); return { ...caps, screenshot_formats: args.modelId === 'all-formats' ? ['png', 'bmp', 'bmp8bit'] : ['bmp'] } })
  const props = screenshotProps({ executionMode: 'live', modelId: 'all-formats' })
  const original = structuredClone(props.step)
  render(props); await settle()
  assert.equal(control(render(props), 'Image Format').props.disabled, false)
  const next = { ...props, modelId: caps.model_id }
  assert.equal(control(render(next), 'Image Format').props.disabled, true)
  await settle()
  let view = render(next)
  assert.equal(control(view, 'Image Format').props.value, 'png')
  assert.ok(JSON.stringify(view).includes('existing Image Format preserved'))
  const otherInstance = { ...next, step: { ...next.step, target: 'scope-2' } }
  render(otherInstance); await settle(); render(otherInstance)
  const otherExe = { ...otherInstance, scopesExecutableKey: 'new-scopes.exe' }
  render(otherExe); await settle(); render(otherExe)
  assert.deepEqual(calls.map(([, args]) => args), [
    { modelId: 'all-formats', executionMode: 'live' },
    ...Array.from({ length: 3 }, () => ({ modelId: caps.model_id, executionMode: 'live' })),
  ])
  assert.deepEqual(props.step, original)
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const editorProps = app.slice(app.indexOf('<ScopesActionEditor'), app.indexOf('onChange={next => updateStep(selectedToolAction.id'))
  assert.match(editorProps, /resourceIdentities\[selectedToolAction\.target\]\?\.model_id/)
  assert.match(editorProps, /executionMode=\{executionMode\} scopesExecutableKey=\{scopesExecutableKey\}/)
})

test('Scopes Screenshot preserves unsupported saved values on missing models and capability errors', async () => {
  const calls = []
  const render = await actionEditor(async (command, args) => { calls.push([command, args]); throw 'offline capability failure' })
  const props = screenshotProps({ executionMode: 'live', modelId: null,
    step: { ...screenshotProps().step, arguments: { format: 'legacy-format', extra: 'preserved' } } })
  const original = structuredClone(props.step)
  let view = render(props)
  assert.equal(calls.length, 0)
  assert.equal(control(view, 'Image Format').props.disabled, true)
  assert.ok(JSON.stringify(view).includes('Select or refresh a supported Live Resource'))
  const option = elements(control(view, 'Image Format')).find(node => node.type === 'option' && node.props.value === 'legacy-format')
  assert.equal(option.props.disabled, true)
  assert.equal(option.props.children, 'legacy-format')
  const next = { ...props, modelId: caps.model_id }
  render(next); await settle()
  view = render(next)
  assert.equal(control(view, 'Image Format').props.disabled, true)
  assert.equal(control(view, 'Image Format').props.value, 'legacy-format')
  assert.ok(JSON.stringify(view).includes('offline capability failure'))
  control(view, 'Image Format').props.onChange({ target: { value: 'bmp' } })
  assert.deepEqual(props.step, original)
})

test('Scopes Screenshot ignores stale capabilities after model changes and action changes', async () => {
  const pending = []
  const render = await actionEditor((command, args) => new Promise(resolve => pending.push({ args, resolve })))
  const props = screenshotProps({ executionMode: 'live', modelId: 'old-model' })
  render(props)
  const next = { ...props, modelId: 'new-model' }
  render(next)
  pending[1].resolve({ ...caps, screenshot_formats: ['bmp'] }); await settle()
  pending[0].resolve({ ...caps, screenshot_formats: ['png'] }); await settle()
  let view = render(next)
  assert.equal(elements(control(view, 'Image Format')).find(node => node.type === 'option' && node.props.value === 'png').props.disabled, true)
  const third = { ...next, modelId: 'third-model' }
  render(third)
  render({ ...third, step: { ...third.step, action: 'measure' } })
  pending[2].resolve({ ...caps, screenshot_formats: ['png'] }); await settle()
  view = render(third)
  assert.equal(control(view, 'Image Format').props.disabled, true)
})

test('Scopes Channel actions request capabilities while Timebase actions do not', async () => {
  const calls = []
  const render = await actionEditor(async (_, args) => { calls.push(args); return caps })
  for (const [action] of SCOPES_ACTIONS.filter(([action]) => action !== 'screenshot')) {
    const props = screenshotProps({ step: { ...screenshotProps().step, action, arguments: scopesActionArguments(action) } })
    const before = calls.length
    assert.equal(control(render(props), 'Image Format'), undefined)
    assert.equal(calls.length - before, action.startsWith('timebase-') ? 0 : 1)
    await settle()
  }
})

test('Scopes Channel editor retains numeric bindings and replaces invalid saved Capture only on selection', async () => {
  const render = await actionEditor(async () => caps)
  let step = { type: 'tool-action', id: 'scale', target: 'scope', action: 'channel-scale', arguments: { channel: 1, volts_per_division: 1 } }
  const props = () => ({ step, instances: [], earlierSteps: [], earlierVariables: ['scale'], disabled: false, stepLabel: value => value.id, onChange: next => { step = next }, executionMode: 'simulate', scopesExecutableKey: 'scopes.exe' })
  render(props()); await settle()
  let field = elements(render(props())).find(node => node.props.literalLabel === 'Volts per Division')
  field.props.onChange({ source: 'variable', variable: 'scale' })
  assert.deepEqual(step.bindings.volts_per_division, { source: 'variable', variable: 'scale' })
  field = elements(render(props())).find(node => node.props.literalLabel === 'Volts per Division')
  field.props.onChange({ source: 'literal', value: 2 })
  assert.equal(step.arguments.volts_per_division, 2)
  assert.equal(step.bindings, undefined)
  step = { ...step, action: 'capture', arguments: { channel: 'invalid', points: 1000 } }
  let view = render(props()); await settle()
  assert.equal(step.arguments.channel, 'invalid')
  assert.ok(JSON.stringify(view).includes('Saved Capture channels'))
  control(view, 'Capture CH1').props.onChange({ target: { checked: true } })
  assert.deepEqual(step.arguments.channel, [1])
  view = render(props())
  control(view, 'Capture CH2').props.onChange({ target: { checked: true } })
  assert.deepEqual(step.arguments.channel, [1, 2])
  assert.equal(control(render(props()), 'Capture CH2').props.checked, true)
  const points = render(props()).find(node => node.props.literalLabel === 'Points')
  points.props.onChange({ source: 'variable', variable: 'scale' })
  assert.deepEqual(step.bindings.points, { source: 'variable', variable: 'scale' })
  assert.deepEqual(step.arguments.channel, [1, 2])
})

for (const action of ['channel-display', 'channel-scale', 'channel-offset', 'trigger-edge', 'measure']) {
  test(`Scopes Channel fixed selector uses capability options and numeric writes for ${action}`, async () => {
    const render = await actionEditor(async () => ({ ...caps, analog_channels: 2 }))
    const key = action === 'trigger-edge' ? 'source_channel' : 'channel'
    const label = action === 'trigger-edge' ? 'Source Channel' : 'Channel'
    let step = { ...screenshotProps().step, action, arguments: { ...scopesActionArguments(action), [key]: 1 } }
    const props = () => screenshotProps({ step, onChange: next => { step = next } })
    render(props()); await settle()
    let view = render(props())
    const select = control(view, label)
    assert.deepEqual(elements(select).filter(node => node.type === 'option' && !node.props.disabled)
      .map(node => [node.props.value, node.props.children.join('')]), [[1, 'CH1'], [2, 'CH2']])
    assert.ok(!view.some(node => node.props.sourceLabel === `${label} Source`))
    const original = structuredClone(step)
    select.props.onChange({ target: { value: '4' } })
    assert.deepEqual(step, original)
    select.props.onChange({ target: { value: '2' } })
    assert.deepEqual(step.arguments, { ...original.arguments, [key]: 2 })
    const roundTrip = JSON.parse(JSON.stringify(step))
    assert.equal(control(render({ ...props(), step: roundTrip }), label).props.value, '2')
    control(render({ ...props(), disabled: true }), label).props.onChange({ target: { value: '1' } })
    assert.deepEqual(step, roundTrip)
    if (action === 'channel-display') {
      view = render(props())
      const display = view.find(node => node.type === 'select' && node.props.value === 'on')
      display.props.onChange({ target: { value: 'off' } })
      assert.equal(step.arguments.off, true)
      assert.equal(step.arguments.on, undefined)
      assert.equal(step.arguments.query, undefined)
      assert.equal(step.arguments.channel, 2)
      render(props()).find(node => node.type === 'select' && node.props.value === 'off')
        .props.onChange({ target: { value: 'on' } })
      assert.equal(step.arguments.on, true)
      assert.equal(step.arguments.off, undefined)
    }
  })
}

test('Scopes Channel preserves unsupported values and bindings through reload until explicit replacement', async () => {
  for (const action of ['channel-scale', 'trigger-edge']) {
    const render = await actionEditor(async () => ({ ...caps, analog_channels: 2 }))
    const key = action === 'trigger-edge' ? 'source_channel' : 'channel'
    const label = action === 'trigger-edge' ? 'Source Channel' : 'Channel'
    const numericKey = action === 'trigger-edge' ? 'level' : 'volts_per_division'
    let step = { ...screenshotProps().step, action, arguments: { ...scopesActionArguments(action), [key]: 4, extra: 'preserved' } }
    const props = () => screenshotProps({ step, onChange: next => { step = next } })
    render(props()); await settle()
    let view = render(props())
    assert.equal(control(view, label).props.value, '4')
    assert.equal(elements(control(view, label)).find(node => node.type === 'option' && node.props.value === '4').props.disabled, true)
    assert.ok(JSON.stringify(view).includes('not supported by the current model'))
    const binding = { source: 'variable', variable: 'legacy-channel' }
    step = { ...step, bindings: { [key]: binding, [numericKey]: { source: 'elapsed-time' } } }
    const original = structuredClone(step)
    step = JSON.parse(JSON.stringify(step))
    view = render(props())
    assert.equal(control(view, label).props.value, '')
    assert.ok(JSON.stringify(view).includes('Bound channel (preserved)'))
    assert.ok(JSON.stringify(view).includes('Channel binding preserved'))
    assert.deepEqual(step, original)
    const field = view.find(node => node.props.literalLabel === (action === 'trigger-edge' ? 'Level (V)' : 'Volts per Division'))
    assert.deepEqual(field.props.value, { source: 'elapsed-time' })
    field.props.onChange({ source: 'variable', variable: 'value' })
    assert.deepEqual(step.bindings[key], binding)
    assert.equal(step.arguments[key], 4)
    control(render(props()), label).props.onChange({ target: { value: '2' } })
    assert.equal(step.arguments[key], 2)
    assert.equal(step.bindings[key], undefined)
    assert.deepEqual(step.bindings[numericKey], { source: 'variable', variable: 'value' })
    assert.equal(step.arguments.extra, 'preserved')
    delete step.bindings[numericKey]
    step.bindings[key] = binding
    control(render(props()), label).props.onChange({ target: { value: '1' } })
    assert.equal(step.bindings, undefined)
  }
})

test('Scopes Channel Capture selects nonempty number arrays and preserves unsupported or invalid templates', async () => {
  const render = await actionEditor(async () => ({ ...caps, analog_channels: 2 }))
  let step = { ...screenshotProps().step, action: 'capture', arguments: { channel: [1], points: 1000, extra: 'preserved' } }
  const props = () => screenshotProps({ step, onChange: next => { step = next } })
  render(props()); await settle()
  let view = render(props())
  assert.deepEqual(view.filter(node => node.type === 'input').map(node => node.props['aria-label']), ['Capture CH1', 'Capture CH2'])
  assert.equal(control(view, 'Capture CH1').props.disabled, true)
  control(view, 'Capture CH1').props.onChange({ target: { checked: false } })
  assert.deepEqual(step.arguments.channel, [1])
  control(view, 'Capture CH2').props.onChange({ target: { checked: true } })
  assert.deepEqual(step.arguments.channel, [1, 2])
  assert.equal(control(render(props()), 'Capture CH1').props.disabled, false)
  control(render(props()), 'Capture CH1').props.onChange({ target: { checked: false } })
  assert.deepEqual(step.arguments.channel, [2])
  control(render({ ...props(), disabled: true }), 'Capture CH1').props.onChange({ target: { checked: true } })
  assert.deepEqual(step.arguments.channel, [2])
  for (const saved of [[1, 4], [], 'invalid', [0], [1, '2'], 2, null, undefined]) {
    step = { ...step, arguments: { ...step.arguments, channel: saved } }
    const original = structuredClone(step)
    view = render(props())
    assert.deepEqual(step, original)
    assert.ok(JSON.stringify(view).includes('invalid or not supported'))
    assert.equal(control(view, 'Capture CH1').props.checked, false)
    assert.equal(control(view, 'Capture CH2').props.checked, false)
    const reloaded = JSON.parse(JSON.stringify(step))
    render({ ...props(), step: reloaded })
    assert.deepEqual(JSON.parse(JSON.stringify(step)), reloaded)
    control(view, 'Capture CH2').props.onChange({ target: { checked: true } })
    assert.deepEqual(step.arguments, { channel: [2], points: 1000, extra: 'preserved' })
  }
  step = { ...step, bindings: { channel: { source: 'variable', variable: 'channels' }, points: { source: 'variable', variable: 'points' } } }
  const original = structuredClone(step)
  view = render(props())
  assert.ok(JSON.stringify(view).includes('Channel binding preserved'))
  assert.deepEqual(step, original)
  assert.equal(control(view, 'Capture CH2').props.checked, false)
  control(view, 'Capture CH1').props.onChange({ target: { checked: true } })
  assert.deepEqual(step.arguments.channel, [1])
  assert.deepEqual(step.bindings, { points: original.bindings.points })
})

test('Scopes Channel capabilities gate missing loading error and empty channel lists without writes', async () => {
  for (const action of ['measure', 'capture']) {
    let calls = 0
    const render = await actionEditor(async () => { calls++; throw 'offline capability failure' })
    const props = screenshotProps({ executionMode: 'live', modelId: null,
      step: { ...screenshotProps().step, action, arguments: scopesActionArguments(action) } })
    let view = render(props)
    assert.equal(calls, 0)
    assert.ok(JSON.stringify(view).includes('Select or refresh a supported Live Resource'))
    if (action === 'measure') assert.equal(control(view, 'Channel').props.disabled, true)
    else assert.equal(view.filter(node => node.type === 'input' && node.props.type === 'checkbox').length, 0)
    const next = { ...props, modelId: caps.model_id }
    view = render(next)
    assert.ok(JSON.stringify(view).includes('Loading offline Scopes capabilities'))
    await settle()
    view = render(next)
    assert.ok(JSON.stringify(view).includes('offline capability failure'))
    if (action === 'measure') {
      assert.equal(control(view, 'Channel').props.disabled, true)
      control(view, 'Channel').props.onChange({ target: { value: '1' } })
    }
    const empty = await actionEditor(async () => ({ ...caps, analog_channels: 0 }))
    empty(props); empty(next); await settle()
    view = empty(next)
    assert.ok(JSON.stringify(view).includes('No supported channels were returned'))
  }
})

test('Scopes Channel reloads Simulation Live model instance and EXE and ignores stale success or errors', async () => {
  const pending = []
  const render = await actionEditor((command, args) => new Promise((resolve, reject) => pending.push({ command, args, resolve, reject })))
  const step = { ...screenshotProps().step, action: 'measure', arguments: { channel: 4, item: 'vpp' }, bindings: { channel: { source: 'variable', variable: 'legacy' } } }
  const saved = structuredClone(step)
  let props = screenshotProps({ step, modelId: 'saved-live-model' })
  render(props)
  assert.deepEqual(pending[0].args, { modelId: undefined, executionMode: 'simulate' })
  props = { ...props, executionMode: 'live', modelId: 'old-model' }
  render(props)
  props = { ...props, modelId: 'new-model' }
  render(props)
  pending[2].resolve({ ...caps, analog_channels: 2 }); await settle()
  pending[1].reject('stale failure'); pending[0].resolve(caps); await settle()
  let view = render(props)
  assert.deepEqual(elements(control(view, 'Channel')).filter(node => node.type === 'option' && !node.props.disabled).map(node => node.props.value), [1, 2])
  assert.ok(!JSON.stringify(view).includes('stale failure'))
  for (const next of [{ ...props, step: { ...step, target: 'scope-2' } },
    { ...props, step: { ...step, target: 'scope-2' }, scopesExecutableKey: 'new-scopes.exe' },
    { ...props, executionMode: 'simulate', step: { ...step, target: 'scope-2' }, scopesExecutableKey: 'new-scopes.exe' }]) {
    props = next
    view = render(props)
    assert.equal(control(view, 'Channel').props.disabled, true)
    assert.ok(JSON.stringify(view).includes('Loading offline Scopes capabilities'))
  }
  pending[5].resolve(caps); await settle()
  pending[4].resolve({ ...caps, analog_channels: 1 }); pending[3].reject('stale instance failure'); await settle()
  view = render(props)
  assert.deepEqual(elements(control(view, 'Channel')).filter(node => node.type === 'option' && !node.props.disabled).map(node => node.props.value), [1, 2, 3, 4])
  assert.equal(pending.length, 6)
  assert.ok(pending.every(call => call.command === 'get_scopes_capabilities'))
  assert.deepEqual(pending.slice(3).map(call => call.args), [
    { modelId: 'new-model', executionMode: 'live' }, { modelId: 'new-model', executionMode: 'live' },
    { modelId: undefined, executionMode: 'simulate' },
  ])
  assert.deepEqual(step, saved)
  const original = structuredClone(props.step)
  render({ ...props, executionMode: 'live', modelId: null })
  assert.equal(pending.length, 6)
  assert.deepEqual(props.step, original)
})

test('Scopes Channel change leaves Offset Trigger and Measure fields unchanged', async () => {
  for (const action of ['channel-offset', 'trigger-edge', 'measure']) {
    const render = await actionEditor(async () => caps)
    const key = action === 'trigger-edge' ? 'source_channel' : 'channel'
    const numericKey = action === 'trigger-edge' ? 'level' : 'volts'
    let step = { ...screenshotProps().step, action, arguments: scopesActionArguments(action),
      ...(action === 'measure' ? {} : { bindings: { [numericKey]: { source: 'timestamp' } } }) }
    const props = () => screenshotProps({ step, onChange: next => { step = next } })
    render(props()); await settle()
    const original = structuredClone(step)
    control(render(props()), action === 'trigger-edge' ? 'Source Channel' : 'Channel').props.onChange({ target: { value: '2' } })
    assert.deepEqual(step, { ...original, arguments: { ...original.arguments, [key]: 2 } })
    const view = render(props())
    if (action !== 'measure') {
      const field = view.find(node => node.props.literalLabel === (action === 'trigger-edge' ? 'Level (V)' : 'Offset (V)'))
      assert.deepEqual(field.props.value, { source: 'timestamp' })
      field.props.onChange({ source: 'variable', variable: 'value' })
      assert.deepEqual(step.bindings[numericKey], { source: 'variable', variable: 'value' })
    }
    if (action === 'trigger-edge') {
      view.find(node => node.type === 'select' && node.props.value === 'positive').props.onChange({ target: { value: 'negative' } })
      assert.equal(step.arguments.slope, 'negative')
      assert.equal(step.arguments.source_channel, 2)
    } else if (action === 'measure') {
      view.find(node => node.type === 'input' && node.props.type === 'text').props.onChange({ target: { value: 'frequency' } })
      assert.equal(step.arguments.item, 'frequency')
      assert.equal(step.arguments.channel, 2)
    }
  }
})
