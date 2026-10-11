import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { transformWithOxc } from 'vite'

// Exercise rendered controls and handlers with local hooks and mocked native I/O.
async function component(name, native = {}, source = fs.readFileSync(new URL(`../src/${name}.tsx`, import.meta.url), 'utf8')) {
  const { code } = await transformWithOxc(source, `${name}.tsx`, { jsx: { runtime: 'classic' } })
  const modules = {}
  for (const [, path] of code.matchAll(/import .+? from "([^"]+)";/g)) {
    if (path === 'react') continue
    if (path.startsWith('@tauri-apps/')) modules[path] = native
    else if (fs.existsSync(new URL(`../src/${path}.ts`, import.meta.url))) {
      modules[path] = await import(`../src/${path}.ts`)
    } else modules[path] = { default: path.slice(2), ExpressionOperandEditor: 'ExpressionOperandEditor' }
  }
  const body = code.replace(/import (.+?) from "([^"]+)";/g, (_, names, path) => {
    const named = names.match(/\{(.+)\}/)?.[1]
    const defaultName = names.split(',')[0].trim()
    return (named ? `const {${named}} = modules[${JSON.stringify(path)}];` : '')
      + (defaultName.startsWith('{') ? '' : `const ${defaultName} = modules[${JSON.stringify(path)}].default;`)
  }).replace(/export default (?:function )?/, match => match.includes('function') ? 'function ' : '')
  const state = []
  let cursor = 0
  modules.react = {
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next }]
    },
    useEffect() {},
    useCallback: callback => callback,
    useMemo: callback => callback(),
    useRef: current => ({ current }),
  }
  const render = new Function('React', 'modules', `${body}; return ${name}`)(React, modules)
  return props => elements(renderWithHooks(props))
  function renderWithHooks(props) {
    cursor = 0
    return render(props)
  }
}

function elements(root) {
  const result = []
  function visit(node) {
    if (Array.isArray(node)) node.forEach(visit)
    else if (React.isValidElement(node)) { result.push(node); visit(node.props.children) }
  }
  visit(root)
  return result
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (React.isValidElement(node)) return text(node.props.children)
  return node == null || typeof node === 'boolean' ? '' : String(node)
}
const button = (view, label) => view.find(node => node.type === 'button' && text(node) === label)
const candidates = select => elements(select).filter(node => node.type === 'option').map(node => node.props.value)
const settle = () => new Promise(resolve => setImmediate(resolve))
const status = (tool_id, executable_status = 'available', compatibility = 'compatible') => ({
  tool_id, path: ['not-configured', 'error'].includes(executable_status) ? null : `${tool_id}.exe`,
  source: executable_status === 'error' ? null : executable_status === 'not-configured' ? 'not-configured' : 'configured',
  executable_status, compatibility, tool_version: null, worker_schema_versions: [],
  reason: executable_status === 'error' ? 'Executable inspection failed: permission denied' : null,
})
const template = {
  tool_instances: [{ id: 'powers-1', tool: 'powers', setup: {} }, { id: 'scopes-1', tool: 'scopes', setup: {} }],
  workflow: { steps: [{ type: 'tool-action', id: 'power-off-1', target: 'powers-1', action: 'output-off', arguments: {} }] },
}

const scopesOutputPanel = app => app.render().find(node => node.props['aria-labelledby'] === 'scopes-output-title')
const scopesOutputHeader = app => elements(scopesOutputPanel(app)).find(node => node.type === 'button'
  && node.props.className === 'collapsible-header')

function assertScopesOutputLocked(app) {
  const panel = scopesOutputPanel(app)
  const header = scopesOutputHeader(app)
  assert.equal(header.props.disabled, true)
  assert.equal(header.props['aria-expanded'], false)
  assert.ok(text(header).includes('🔒'))
  assert.equal(text(elements(panel).find(node => node.props.id === header.props['aria-describedby'])),
    'No Scopes Tool Instance. Add one in Setup.')
  assert.equal(button(elements(panel), 'Select Folder'), undefined)
  assert.equal(button(elements(panel), 'Use Default'), undefined)
  assert.ok(!elements(panel).some(node => node.props.className === 'streaming-destination'))
}

test('Scopes File Output locks by instances and preserves folder selection and reset without editing Template', async () => {
  const app = await toolsView([status('scopes'), status('powers')], { tool_instances: [], workflow: { steps: [] } })
  const renderSetup = await component('ToolSetupEditor')
  const setup = () => app.render().find(node => node.type === 'ToolSetupEditor').props
  const add = () => {
    renderSetup(setup()).find(node => node.props['aria-label'] === 'Tool type').props.onChange({ target: { value: 'scopes' } })
    button(renderSetup(setup()), 'Add Tool Instance').props.onClick()
  }
  const remove = id => {
    const instance = renderSetup(setup()).find(node => node.type === 'fieldset' && node.key === id)
    const control = button(elements(instance), 'Remove Tool Instance')
    assert.equal(control.props.disabled, false)
    control.props.onClick()
  }
  button(app.render(), 'Workflow').props.onClick()
  assertCategories(app, [])
  assertScopesOutputLocked(app)

  add()
  assertCategories(app, ['Scopes'])
  assert.equal(scopesOutputHeader(app).props.disabled, false)
  assert.equal(scopesOutputHeader(app).props['aria-expanded'], false)
  assert.deepEqual(setup().resourceIdentities, {})
  const before = structuredClone(setup().value)
  for (const mode of ['simulate', 'live']) {
    button(app.render(), mode === 'simulate' ? 'Simulation' : 'Live').props.onClick()
    assert.equal(scopesOutputHeader(app).props.disabled, false)
    assert.equal(categoryHeader(assertCategories(app, ['Scopes'])[3]).props['aria-expanded'], true)
  }
  scopesOutputHeader(app).props.onClick()
  let panel = scopesOutputPanel(app)
  assert.ok(text(panel).includes('Default: Orchestrator application folder / data'))
  app.pick('C:\\Scopes Output')
  await button(elements(panel), 'Select Folder').props.onClick()
  await settle()
  panel = scopesOutputPanel(app)
  assert.ok(text(panel).includes('C:\\Scopes Output'))
  assert.deepEqual(setup().value, before)
  assert.deepEqual(setup().steps, [])

  categoryHeader(categorySections(app)[3]).props.onClick()
  assert.equal(categoryHeader(categorySections(app)[3]).props['aria-expanded'], false)
  assert.equal(scopesOutputHeader(app).props['aria-expanded'], true)
  scopesOutputHeader(app).props.onClick()
  categoryHeader(categorySections(app)[3]).props.onClick()
  assert.equal(categoryHeader(categorySections(app)[3]).props['aria-expanded'], true)
  assert.equal(scopesOutputHeader(app).props['aria-expanded'], false)
  scopesOutputHeader(app).props.onClick()

  add()
  remove('scopes-1')
  assertCategories(app, ['Scopes'])
  assert.equal(scopesOutputHeader(app).props.disabled, false)
  assert.ok(text(scopesOutputPanel(app)).includes('C:\\Scopes Output'))
  remove('scopes-2')
  assertCategories(app, [])
  assertScopesOutputLocked(app)
  add()
  assertCategories(app, ['Scopes'])
  assert.equal(scopesOutputHeader(app).props['aria-expanded'], true)
  assert.ok(text(scopesOutputPanel(app)).includes('C:\\Scopes Output'))

  app.pick('empty-template.json')
  button(app.render(), 'Open Template').props.onClick()
  await settle()
  assertCategories(app, [])
  assertScopesOutputLocked(app)
  assert.deepEqual(setup().steps, [])
  add()
  panel = scopesOutputPanel(app)
  assert.ok(text(panel).includes('C:\\Scopes Output'))
  const beforeReset = structuredClone(setup().value)
  button(elements(panel), 'Use Default').props.onClick()
  panel = scopesOutputPanel(app)
  assert.ok(text(panel).includes('Default: Orchestrator application folder / data'))
  assert.deepEqual(setup().value, beforeReset)
  assert.deepEqual(setup().steps, [])
  assert.equal(button(elements(panel), 'Use Default').props.disabled, true)
})

test('Steps categories keep tool mapping independent of the first preset tool', async () => {
  const source = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const alteredPresets = source.replace("category: 'Scopes', tool: 'scopes' as const",
    "category: 'Scopes', tool: 'powers' as const")
  assert.notEqual(alteredPresets, source)
  const app = await toolsView([status('powers'), status('scopes')],
    { tool_instances: [{ id: 'scopes-1', tool: 'scopes', setup: {} }], workflow: { steps: [] } }, alteredPresets)
  button(app.render(), 'Workflow').props.onClick()
  assertCategories(app, ['Scopes'])
  const header = categoryHeader(categorySections(app)[3])
  assert.equal(header.props.disabled, false)
  assert.equal(header.props['aria-expanded'], true)
})

async function toolsView(initial, draft = template, source, local = {}) {
  let statuses = initial
  let picked = null
  let reject = false
  const calls = []
  const render = await component('App', {
    open: async () => picked,
    save: async () => picked,
    async invoke(command, args) {
      calls.push([command, args])
      if (command === 'get_tool_status') return statuses
      if (command === 'create_workflow_draft' || command === 'load_workflow_template') return JSON.stringify(draft)
      if (command === 'get_live_resources') return local.resources ?? {}
      if (command === 'get_live_resource_identities') return local.identities ?? {}
      if (command === 'save_workflow_template' || command === 'validate_workflow_template') return args.templateJson
      if (command === 'set_tool_executable') {
        if (reject) throw new Error('Incompatible executable')
        statuses = statuses.map(tool => tool.tool_id === args.toolId ? status(tool.tool_id) : tool)
      } else if (command === 'reset_tool_executable') {
        statuses = statuses.map(tool => tool.tool_id === args.toolId ? status(tool.tool_id, 'not-configured') : tool)
      } else throw new Error(`Unexpected command: ${command}`)
    },
  }, source)
  button(render(), 'Refresh').props.onClick()
  button(render(), 'New Template').props.onClick()
  await settle()
  return { render, calls, pick(value, invalid = false) { picked = value; reject = invalid } }
}

const categoryNames = ['Workflow', 'Meters', 'Powers', 'Scopes']
const categorySections = app => app.render().filter(node => node.type === 'section' && categoryNames.includes(node.key)
  && elements(node).some(child => child.props.className === 'step-category-header'))
const categoryHeader = section => elements(section).find(node => node.props.className === 'step-category-header')
const categorySteps = section => elements(section).filter(node => node.props.className === 'action-button step-palette-button')

function assertCategories(app, unlocked) {
  const sections = categorySections(app)
  assert.deepEqual(sections.map(section => section.key), categoryNames)
  for (const section of sections) {
    const header = categoryHeader(section)
    const locked = section.key !== 'Workflow' && !unlocked.includes(section.key)
    assert.equal(header.props.disabled, locked, section.key)
    if (locked) {
      assert.equal(header.props['aria-expanded'], false, section.key)
      assert.equal(categorySteps(section).length, 0, section.key)
      const hint = elements(section).find(node => node.props.id === header.props['aria-describedby'])
      assert.equal(text(hint), `No ${section.key} Tool Instance. Add one in Setup.`)
      assert.ok(text(header).includes('🔒'))
    }
  }
  return sections
}

test('Steps categories keep fixed order and lock only by Template instances in either mode', async () => {
  const empty = { tool_instances: [], workflow: { steps: [] } }
  const app = await toolsView([status('meters'), status('powers'), status('scopes')], empty)
  button(app.render(), 'Workflow').props.onClick()
  assertScopesOutputLocked(app)
  const sections = assertCategories(app, [])
  assert.equal(categoryHeader(sections[0]).props['aria-expanded'], true)
  assert.deepEqual(categorySteps(sections[0]).map(text),
    ['While', 'For', 'Set Variable', 'Output', 'Wait', 'Assert', 'Show Message'])

  const meters = { id: 'meters-1', tool: 'meters', setup: {} }
  app.render().find(node => node.type === 'ToolSetupEditor').props.onChange([meters])
  for (const mode of ['simulate', 'live']) {
    button(app.render(), mode === 'simulate' ? 'Simulation' : 'Live').props.onClick()
    const meterSection = assertCategories(app, ['Meters'])[1]
    assert.equal(categoryHeader(meterSection).props['aria-expanded'], true)
    assert.deepEqual(categorySteps(meterSection).map(text), ['Meter Measure'])
    assert.equal(categorySteps(meterSection)[0].props.disabled, false)
  }
  const setup = app.render().find(node => node.type === 'ToolSetupEditor').props
  assert.deepEqual(setup.resourceIdentities, {})
  assert.deepEqual(setup.steps, [])
})

test('Steps categories update immediately through Setup add/remove and preserve manual collapse', async () => {
  const app = await toolsView([status('meters'), status('powers'), status('scopes')],
    { tool_instances: [], workflow: { steps: [] } })
  const renderSetup = await component('ToolSetupEditor')
  const setup = () => app.render().find(node => node.type === 'ToolSetupEditor').props
  const add = tool => {
    renderSetup(setup()).find(node => node.props['aria-label'] === 'Tool type').props.onChange({ target: { value: tool } })
    button(renderSetup(setup()), 'Add Tool Instance').props.onClick()
  }
  const remove = id => {
    const instance = renderSetup(setup()).find(node => node.type === 'fieldset' && node.key === id)
    const control = button(elements(instance), 'Remove Tool Instance')
    assert.equal(control.props.disabled, false)
    control.props.onClick()
  }
  button(app.render(), 'Workflow').props.onClick()
  for (const tool of ['meters', 'powers', 'scopes']) {
    add(tool)
    assertCategories(app, categoryNames.slice(1, categoryNames.indexOf(tool[0].toUpperCase() + tool.slice(1)) + 1))
  }
  let sections = assertCategories(app, categoryNames.slice(1))
  assert.deepEqual(categorySteps(sections[2]).map(text),
    ['Power Set Output', 'Power Protection Status', 'Power Output ON', 'Power Output OFF'])
  const scopeLabels = (await import('../src/scopesActions.ts')).SCOPES_ACTIONS.map(([, label]) => label)
  assert.deepEqual(categorySteps(sections[3]).map(text), scopeLabels)
  for (const name of categoryNames) {
    const section = categorySections(app).find(item => item.key === name)
    categoryHeader(section).props.onClick()
    const collapsed = categorySections(app).find(item => item.key === name)
    assert.equal(categoryHeader(collapsed).props['aria-expanded'], false)
    assert.equal(categorySteps(collapsed).length, 0)
    categoryHeader(collapsed).props.onClick()
    assert.equal(categoryHeader(categorySections(app).find(item => item.key === name)).props['aria-expanded'], true)
  }
  add('powers')
  remove('powers-1')
  assertCategories(app, ['Meters', 'Powers', 'Scopes'])
  remove('powers-2')
  assertCategories(app, ['Meters', 'Scopes'])
  remove('scopes-1')
  assertCategories(app, ['Meters'])
  add('scopes')
  sections = assertCategories(app, ['Meters', 'Scopes'])
  assert.equal(categoryHeader(sections[3]).props['aria-expanded'], true)
  categorySteps(sections[1])[0].props.onClick()
  assert.equal(setup().steps[0].target, 'meters-1')
  const referenced = renderSetup(setup()).find(node => node.type === 'fieldset' && node.key === 'meters-1')
  assert.equal(button(elements(referenced), 'Remove Tool Instance').props.disabled, true)
  add('powers')
  sections = assertCategories(app, ['Meters', 'Powers', 'Scopes'])
  button(elements(sections[2]), 'Power Output OFF').props.onClick()
  button(elements(categorySections(app)[0]), 'Wait').props.onClick()
  assert.equal(setup().steps[1].target, setup().value.find(instance => instance.tool === 'powers').id)
  assert.equal(setup().steps[1].action, 'output-off')
  assert.equal(setup().steps[2].type, 'wait')
})

test('Steps categories use loaded Template instances despite unavailable executables without editing data', async () => {
  const original = structuredClone(template)
  const app = await toolsView([status('powers', 'error', 'error'), status('scopes', 'not-configured')])
  app.render().find(node => node.type === 'ToolSetupEditor').props.onChange([])
  app.pick('existing-template.json')
  button(app.render(), 'Open Template').props.onClick()
  await settle()
  assert.ok(app.calls.some(([command]) => command === 'load_workflow_template'))
  button(app.render(), 'Workflow').props.onClick()
  assertCategories(app, ['Powers', 'Scopes'])
  assert.equal(scopesOutputHeader(app).props.disabled, false)
  scopesOutputHeader(app).props.onClick()
  assert.equal(scopesOutputHeader(app).props['aria-expanded'], true)
  assert.ok(button(elements(scopesOutputPanel(app)), 'Select Folder'))
  for (const section of categorySections(app).slice(2)) {
    assert.equal(categoryHeader(section).props['aria-expanded'], true)
    assert.ok(categorySteps(section).every(step => step.props.disabled === false))
  }
  const setup = app.render().find(node => node.type === 'ToolSetupEditor').props
  assert.deepEqual(setup.value, original.tool_instances)
  assert.deepEqual(setup.steps, original.workflow.steps)
  assert.deepEqual(template, original)
  assert.equal(button(app.render(), 'Simulation').props['aria-pressed'], true)
})

test('Tools cards and Add candidates use configuration status, including broken executables', async () => {
  for (const state of ['available', 'missing', 'not-file', 'error']) {
    const app = await toolsView([status('meters'), status('powers', state, 'error'),
      status('scopes', 'not-configured'), status('wavegen', 'not-configured')])
    const view = app.render()
    assert.deepEqual(view.filter(node => node.props.className === 'tool-id').map(text), ['meters', 'powers'])
    assert.deepEqual(candidates(view.find(node => node.props.id === 'tool-to-add')), ['scopes', 'wavegen'])
    assert.deepEqual(view.find(node => node.type === 'ToolSetupEditor').props.configuredToolTypes, ['meters', 'powers'])
  }
})

test('Inspection errors keep Setup instances configured and allow Change Path and Remove', async () => {
  const initial = [status('powers', 'error', 'not-probed'), status('scopes', 'not-configured')]
  const app = await toolsView(initial)
  const setup = () => app.render().find(node => node.type === 'ToolSetupEditor').props
  const beforeInstances = structuredClone(setup().value)
  const beforeSteps = structuredClone(setup().steps)
  const renderSetup = await component('ToolSetupEditor')
  const view = renderSetup(setup())
  assert.deepEqual(candidates(view.find(node => node.props['aria-label'] === 'Tool type')), ['powers'])
  assert.ok(!view.some(node => node.props.role === 'status' && text(node).includes('Powers is not configured in Tools.')))
  assert.ok(view.some(node => node.type === 'legend' && text(node).includes('powers-1')))

  const card = app.render().find(node => node.props.className === 'tool-card' && node.key === 'powers')
  assert.ok(card)
  assert.equal(button(elements(card), 'Change Path...').props.disabled, false)
  const remove = button(elements(card), 'Remove Tool')
  assert.equal(remove.props.disabled, false)
  const callOffset = app.calls.length
  remove.props.onClick()
  assert.deepEqual(app.calls.slice(callOffset), [['reset_tool_executable', { toolId: 'powers' }]])
  assert.deepEqual(app.render().filter(node => node.props.className === 'tool-id').map(text), ['powers'])
  assert.deepEqual(candidates(app.render().find(node => node.props.id === 'tool-to-add')), ['scopes'])
  await settle()
  assert.deepEqual(app.calls.slice(callOffset, callOffset + 2), [
    ['reset_tool_executable', { toolId: 'powers' }], ['get_tool_status', undefined],
  ])
  assert.equal(app.render().filter(node => node.props.className === 'tool-card').length, 0)
  assert.deepEqual(candidates(app.render().find(node => node.props.id === 'tool-to-add')), ['powers', 'scopes'])
  assert.deepEqual(setup().configuredToolTypes, [])
  assert.deepEqual(setup().value, beforeInstances)
  assert.deepEqual(setup().steps, beforeSteps)

  const repair = await toolsView(initial)
  repair.pick('replacement-powers.exe')
  assert.equal(button(repair.render(), 'Change Path...').props.disabled, false)
  button(repair.render(), 'Change Path...').props.onClick()
  await settle()
  assert.ok(repair.calls.some(([command, args]) => command === 'set_tool_executable'
    && args.toolId === 'powers' && args.path === 'replacement-powers.exe'))
  assert.deepEqual(repair.render().filter(node => node.props.className === 'tool-id').map(text), ['powers'])
  const repairedSetup = repair.render().find(node => node.type === 'ToolSetupEditor').props
  assert.deepEqual(repairedSetup.value, beforeInstances)
  assert.deepEqual(repairedSetup.steps, beforeSteps)
})

test('Add, cancel, rejection, and Remove preserve Template instances and workflow', async () => {
  const app = await toolsView([status('powers'), status('scopes', 'not-configured')])
  const instanceData = () => app.render().find(node => node.type === 'ToolSetupEditor').props.value
  const sequenceData = () => app.render().find(node => node.type === 'ToolSetupEditor').props.steps
  const beforeSequence = structuredClone(sequenceData())
  assert.deepEqual(beforeSequence, template.workflow.steps)
  const before = structuredClone(instanceData())
  button(app.render(), 'Add...').props.onClick()
  await settle()
  assert.equal(app.calls.filter(([command]) => command === 'set_tool_executable').length, 0)
  app.pick('wrong.exe', true)
  button(app.render(), 'Add...').props.onClick()
  await settle()
  assert.ok(app.render().some(node => node.props.role === 'alert' && text(node).includes('Incompatible executable')))
  assert.deepEqual(app.render().filter(node => node.props.className === 'tool-id').map(text), ['powers'])
  app.pick('scopes.exe')
  button(app.render(), 'Add...').props.onClick()
  await settle()
  assert.deepEqual(app.render().filter(node => node.props.className === 'tool-id').map(text), ['powers', 'scopes'])
  assert.equal(button(app.render(), 'Add...').props.disabled, true)
  button(app.render(), 'Remove Tool').props.onClick()
  await settle()
  assert.deepEqual(app.render().filter(node => node.props.className === 'tool-id').map(text), ['scopes'])
  assert.deepEqual(candidates(app.render().find(node => node.props.id === 'tool-to-add')), ['powers'])
  assert.deepEqual(instanceData(), before)
  assert.deepEqual(sequenceData(), beforeSequence)
})

test('Tools empty state keeps Add available', async () => {
  const app = await toolsView([status('powers', 'not-configured'), status('scopes', 'not-configured')])
  assert.equal(app.render().filter(node => node.props.className === 'tool-card').length, 0)
  assert.ok(app.render().some(node => node.type === 'p' && text(node) === 'No external tools configured.'))
  assert.equal(button(app.render(), 'Add...').props.disabled, false)
})

test('Setup candidates change safely while existing instances remain visible with warnings', async () => {
  const render = await component('ToolSetupEditor')
  const value = structuredClone(template.tool_instances)
  const original = structuredClone(value)
  const changes = []
  const props = { value, steps: [], disabled: false, executionMode: 'simulate', resourceIdentities: {},
    renderResource: () => null, onChange: next => changes.push(next) }
  let view = render({ ...props, configuredToolTypes: ['meters', 'powers'] })
  let select = view.find(node => node.props['aria-label'] === 'Tool type')
  assert.deepEqual(candidates(select), ['meters', 'powers'])
  select.props.onChange({ target: { value: 'meters' } })
  view = render({ ...props, configuredToolTypes: ['powers'] })
  select = view.find(node => node.props['aria-label'] === 'Tool type')
  assert.equal(select.props.value, 'powers')
  assert.deepEqual(candidates(select), ['powers'])
  assert.ok(view.some(node => node.props.role === 'status' && text(node).includes('Scopes is not configured in Tools.')))
  assert.ok(view.some(node => node.type === 'legend' && text(node).includes('scopes-1')))
  button(view, 'Add Tool Instance').props.onClick()
  assert.equal(changes[0].at(-1).tool, 'powers')
  assert.deepEqual(changes[0].slice(0, -1), original)
  changes.length = 0
  view = render({ ...props, configuredToolTypes: [] })
  assert.equal(view.find(node => node.type === 'fieldset').props.disabled, true)
  assert.equal(view.find(node => node.props['aria-label'] === 'Tool type').props.value, '')
  button(view, 'Add Tool Instance').props.onClick()
  assert.equal(changes.length, 0)
  assert.deepEqual(value, original)
  view = render({ ...props, configuredToolTypes: ['powers', 'scopes'] })
  assert.equal(view.filter(node => node.props.role === 'status').length, 0)
  assert.deepEqual(value, original)
})


test('display_name: all four Setup types add, edit, clear, collapse and keep IDs and controls', async () => {
  const render = await component('ToolSetupEditor')
  const props = { value: [], steps: [], disabled: false, executionMode: 'simulate', resourceIdentities: {},
    configuredToolTypes: ['powers', 'meters', 'scopes', 'wavegen'], renderResource: instance => instance.id,
    onChange: next => { props.value = next } }
  const field = id => render(props).find(node => node.type === 'fieldset' && node.key === id)
  const input = id => elements(field(id)).find(node => node.type === 'input' && node.props.type === 'text')
  for (const tool of props.configuredToolTypes) {
    render(props).find(node => node.props['aria-label'] === 'Tool type').props.onChange({ target: { value: tool } })
    button(render(props), 'Add Tool Instance').props.onClick()
    const id = `${tool}-1`
    const original = structuredClone(props.value.find(item => item.id === id))
    assert.equal(original.display_name, undefined)
    assert.ok(text(field(id)).includes(id))
    assert.equal(input(id).props.value, '')
    input(id).props.onChange({ target: { value: '  儀器 Name 123  ' } })
    assert.equal(input(id).props.value, '  儀器 Name 123  ', 'typing preserves spaces and cursor position')
    assert.ok(text(elements(field(id)).find(node => node.type === 'legend')).includes('儀器 Name 123'))
    assert.ok(text(field(id)).includes(`Instance ID: ${id}`))
    input(id).props.onBlur({ target: { value: input(id).props.value } })
    assert.equal(input(id).props.value, '儀器 Name 123')
    elements(field(id)).find(node => node.props.className?.includes('tool-setup-toggle')).props.onClick()
    assert.equal(input(id), undefined)
    assert.ok(text(field(id)).includes(`Instance ID: ${id}`))
    elements(field(id)).find(node => node.props.className?.includes('tool-setup-toggle')).props.onClick()
    assert.equal(input(id).props.value, '儀器 Name 123')
    assert.ok(button(elements(field(id)), 'Remove Tool Instance'))
    assert.ok(text(field(id)).includes('SIMULATION'))
    props.disabled = true
    assert.equal(field(id).props.disabled, true)
    assert.equal(input(id).props.disabled, true)
    const locked = structuredClone(props.value)
    input(id).props.onChange({ target: { value: 'blocked' } })
    input(id).props.onBlur({ target: { value: 'blocked' } })
    assert.deepEqual(props.value, locked)
    props.disabled = false
    for (const blank of ['', '   ']) {
      input(id).props.onChange({ target: { value: blank } })
      assert.equal(text(elements(field(id)).find(node => node.type === 'legend')).includes('儀器 Name 123'), false)
      input(id).props.onBlur({ target: { value: blank } })
      assert.equal(props.value.find(item => item.id === id).display_name, undefined)
      assert.deepEqual(JSON.parse(JSON.stringify(props.value.find(item => item.id === id))), original)
    }
    input(id).props.onChange({ target: { value: 'Shared name' } })
    const { display_name, ...unchanged } = props.value.find(item => item.id === id)
    assert.equal(display_name, 'Shared name')
    assert.deepEqual(unchanged, original)
  }
  assert.equal(props.value.filter(item => item.display_name === 'Shared name').length, 4)
  button(elements(field('wavegen-1')), 'Remove Tool Instance').props.onClick()
  assert.equal(props.value.some(item => item.id === 'wavegen-1'), false)
})

test('display_name: App synchronizes targets and sequence, preserves identities, references and saving', async () => {
  const draft = structuredClone(template)
  draft.schema_version = 1
  draft.name = 'Display names'
  draft.tool_instances.push({ id: 'powers-2', tool: 'powers', setup: {} },
    { id: 'meters-1', tool: 'meters', setup: {} }, { id: 'wavegen-1', tool: 'wavegen', setup: {} })
  draft.workflow.steps.push({ ...draft.workflow.steps[0], id: 'power-off-2' },
    { type: 'tool-action', id: 'meter-read-1', target: 'meters-1', action: 'measure', arguments: {} },
    { type: 'tool-action', id: 'scope-query-1', target: 'scopes-1', action: 'query', arguments: {} })
  const originalSteps = structuredClone(draft.workflow.steps)
  const local = { resources: { 'powers-1': 'USB0::Power::INSTR' }, identities: {
    'powers-1': { model: 'E36312A', model_id: 'e36312a', serial: 'SN001' } } }
  const app = await toolsView(['powers', 'meters', 'scopes', 'wavegen'].map(tool => status(tool)), draft, undefined, local)
  const renderSetup = await component('ToolSetupEditor')
  const renderSequence = await component('SequenceEditor')
  const setup = () => app.render().find(node => node.type === 'ToolSetupEditor').props
  const sequence = () => app.render().find(node => node.type === 'SequenceEditor').props
  const rename = (id, name) => {
    const field = renderSetup(setup()).find(node => node.type === 'fieldset' && node.key === id)
    elements(field).find(node => node.type === 'input' && node.props.type === 'text').props.onChange({ target: { value: name } })
  }
  const selectTarget = () => app.render().find(node => node.type === 'select' && elements(node).some(child => child.type === 'option' && child.props.value === 'powers-1'))
  button(app.render(), 'Workflow').props.onClick()
  sequence().onSelectStep('power-off-1')
  assert.deepEqual(elements(selectTarget()).filter(node => node.type === 'option').map(text),
    ['powers-1 — E36312A [SN001]', 'powers-2'])
  const callsBefore = app.calls.length
  for (const id of ['powers-1', 'powers-2', 'meters-1', 'scopes-1', 'wavegen-1']) rename(id, id === 'powers-2' ? 'Other power' : 'Shared name')
  assert.deepEqual(app.calls.slice(callsBefore), [], 'name events perform no native I/O')
  assert.deepEqual(elements(selectTarget()).filter(node => node.type === 'option').map(node => [node.props.value, text(node)]),
    [['powers-1', 'Shared name (powers-1) — E36312A [SN001]'], ['powers-2', 'Other power (powers-2)']])
  assert.deepEqual(setup().steps, originalSteps)
  assert.deepEqual(setup().resourceIdentities, local.identities)
  const summaries = renderSequence(sequence()).filter(node => node.props.className === 'sequence-step-summary').map(text)
  assert.deepEqual(summaries, ['CH?', 'CH?', 'Shared name (meters-1)', 'Shared name (scopes-1)'])
  rename('meters-1', '')
  assert.ok(renderSequence(sequence()).some(node => node.props.className === 'sequence-step-summary' && text(node) === 'meters-1'))
  rename('powers-1', 'Latest power')
  sequence().onSelectStep('power-off-2')
  assert.equal(selectTarget().props.value, 'powers-1')
  assert.ok(text(selectTarget()).includes('Latest power (powers-1)'))
  selectTarget().props.onChange({ target: { value: 'powers-2' } })
  assert.equal(setup().steps[1].target, 'powers-2')
  assert.deepEqual(setup().steps[0], originalSteps[0])
  assert.deepEqual({ ...setup().steps[1], target: 'powers-1' }, originalSteps[1])
  rename('powers-1', '   ')
  assert.ok(text(selectTarget()).includes('powers-1 — E36312A [SN001]'))
  for (const mode of ['Live', 'Simulation']) {
    button(app.render(), mode).props.onClick()
    assert.equal(setup().value.find(item => item.id === 'wavegen-1').display_name, 'Shared name')
    assert.deepEqual(setup().resourceIdentities, local.identities)
  }
  app.pick('names.json')
  button(app.render(), 'Save Template').props.onClick()
  assert.equal(setup().disabled, true, 'saving uses the existing busy lock')
  await settle()
  const saved = JSON.parse(app.calls.find(([command]) => command === 'save_workflow_template')[1].templateJson)
  assert.equal(saved.tool_instances.find(item => item.id === 'wavegen-1').display_name, 'Shared name')
  assert.deepEqual(saved.workflow.steps, setup().steps)
  assert.ok(!JSON.stringify(saved.tool_instances.find(item => item.id === 'meters-1')).includes('display_name'))
  assert.ok(!app.calls.slice(callsBefore).some(([command]) => /resource/.test(command)))
})
