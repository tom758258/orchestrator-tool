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
  tool_id, path: executable_status === 'not-configured' ? null : `${tool_id}.exe`,
  source: executable_status === 'not-configured' ? 'not-configured' : 'configured',
  executable_status, compatibility, tool_version: null, worker_schema_versions: [], reason: null,
})
const template = {
  tool_instances: [{ id: 'powers-1', tool: 'powers', setup: {} }, { id: 'scopes-1', tool: 'scopes', setup: {} }],
  workflow: { steps: [{ type: 'tool-action', id: 'power-off-1', target: 'powers-1', action: 'output-off', arguments: {} }] },
}

async function toolsView(initial) {
  let statuses = initial
  let picked = null
  let reject = false
  const calls = []
  const render = await component('App', {
    open: async () => picked,
    async invoke(command, args) {
      calls.push([command, args])
      if (command === 'get_tool_status') return statuses
      if (command === 'create_workflow_draft') return JSON.stringify(template)
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

test('Tools cards and Add candidates use configured paths, including broken executables', async () => {
  for (const state of ['available', 'missing', 'not-file', 'error']) {
    const app = await toolsView([status('meters'), status('powers', state, 'error'),
      status('scopes', 'not-configured'), status('wavegen', 'not-configured')])
    const view = app.render()
    assert.deepEqual(view.filter(node => node.props.className === 'tool-id').map(text), ['meters', 'powers'])
    assert.deepEqual(candidates(view.find(node => node.props.id === 'tool-to-add')), ['scopes', 'wavegen'])
    assert.deepEqual(view.find(node => node.type === 'ToolSetupEditor').props.configuredToolTypes, ['meters', 'powers'])
  }
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
