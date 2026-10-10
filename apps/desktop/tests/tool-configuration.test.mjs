import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { transformWithOxc } from 'vite'

// Exercise rendered controls and handlers with local hooks and mocked native I/O.
async function component(name, native = {}) {
  const source = fs.readFileSync(new URL(`../src/${name}.tsx`, import.meta.url), 'utf8')
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

test('Scopes File Output selects and resets a runtime folder without editing Template', async () => {
  const app = await toolsView([status('scopes'), status('powers')], { tool_instances: [], workflow: { steps: [] } })
  const before = structuredClone(app.render().find(node => node.type === 'ToolSetupEditor').props.value)
  button(app.render(), 'Workflow').props.onClick()
  button(app.render(), 'Scopes File Output+').props.onClick()
  let panel = app.render().find(node => node.props['aria-labelledby'] === 'scopes-output-title')
  assert.ok(text(panel).includes('Default: Orchestrator application folder / data'))
  app.pick('C:\\Scopes Output')
  await button(elements(panel), 'Select Folder').props.onClick()
  await settle()
  panel = app.render().find(node => node.props['aria-labelledby'] === 'scopes-output-title')
  assert.ok(text(panel).includes('C:\\Scopes Output'))
  button(elements(panel), 'Use Default').props.onClick()
  panel = app.render().find(node => node.props['aria-labelledby'] === 'scopes-output-title')
  assert.ok(text(panel).includes('Default: Orchestrator application folder / data'))
  assert.deepEqual(app.render().find(node => node.type === 'ToolSetupEditor').props.value, before)
})

async function toolsView(initial, draft = template) {
  let statuses = initial
  let picked = null
  let reject = false
  const calls = []
  const render = await component('App', {
    open: async () => picked,
    async invoke(command, args) {
      calls.push([command, args])
      if (command === 'get_tool_status') return statuses
      if (command === 'create_workflow_draft' || command === 'load_workflow_template') return JSON.stringify(draft)
      if (command === 'get_live_resources' || command === 'get_live_resource_identities') return {}
      if (command === 'set_tool_executable') {
        if (reject) throw new Error('Incompatible executable')
        statuses = statuses.map(tool => tool.tool_id === args.toolId ? status(tool.tool_id) : tool)
      } else if (command === 'reset_tool_executable') {
        statuses = statuses.map(tool => tool.tool_id === args.toolId ? status(tool.tool_id, 'not-configured') : tool)
      } else throw new Error(`Unexpected command: ${command}`)
    },
  })
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
