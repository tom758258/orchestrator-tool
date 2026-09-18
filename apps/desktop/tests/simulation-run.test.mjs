import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

// Exercise the actual component callback without a WebView or instrument runtime.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const start = source.indexOf('  const runSimulation = useCallback(')
const end = source.indexOf('\n  const workflowBusy =', start)
assert.ok(start >= 0 && end > start, 'Simulation callback boundaries exist')
const declaration = source.slice(start, end)
const callback = declaration.slice(declaration.indexOf('async () =>'), declaration.lastIndexOf('}, [') + 1)
const code = stripTypeScriptTypes('(' + callback + ')')

test('Invalid Streaming config preserves the previous Last Run and does not execute', async () => {
  const previous = {
    runStatus: 'idle',
    runWorkflowSnapshot: { name: 'Previous snapshot', tool_instances: [], workflow: { steps: [] } },
    runResult: {
      step_executions: [{ step_id: 'previous' }],
      result_rows: [{
        page: 'Results',
        outputs: [{ name: 'value', value: 42 }],
        for_iteration: null,
        while_iteration: null,
      }],
    },
    runProgress: { step_executions: [{ step_id: 'partial' }], result_rows: [] },
    csvStreamStatus: { path: 'previous.csv', rows: 1, finished: true },
    stopRequest: { loopId: 'previous-loop' },
  }
  const state = { ...previous }
  const calls = []
  let channels = 0
  const context = {
    workflowDraft: { tool_instances: [], workflow: { steps: [] } },
    streamCsv: true, hasWorkflowOutputs: true, outputFolder: null,
    streamingPage: 'Results', streamAllPages: false, streamDestination: null,
    receiveRunProgress() {},
    streamingOptions() { throw new Error('Select a destination CSV before running.') },
    Channel: class { constructor() { channels++ } },
    async invoke(command, args) { calls.push({ command, args }); return {} },
    setRunError(value) { state.runError = value },
  }
  for (const name of Object.keys(previous)) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = value => { state[name] = value }
  }

  const run = runInNewContext(code, context)
  await run()

  for (const [key, value] of Object.entries(previous)) assert.equal(state[key], value)
  assert.equal(channels, 0)
  assert.equal(calls.some(call => call.command === 'run_workflow_simulation'), false)
})

test('Simulation captures the Workflow snapshot only after pre-run validation succeeds', async () => {
  const workflowDraft = {
    name: 'Simulation snapshot',
    tool_instances: [],
    workflow: {
      steps: [{ type: 'output', id: 'voltage', name: 'Voltage', page: 'Results', value: { source: 'literal', value: 5 } }],
    },
  }
  const result = { step_executions: [], result_rows: [] }
  const state = {
    runWorkflowSnapshot: { name: 'Previous snapshot' },
    runResult: { step_executions: [{ step_id: 'previous' }], result_rows: [] },
    runProgress: { step_executions: [{ step_id: 'partial' }], result_rows: [] },
    csvStreamStatus: { path: 'previous.csv' },
    stopRequest: { loopId: 'previous-loop' },
    runError: 'previous error',
    runStatus: 'idle',
    selectedRunPage: 'Missing',
  }
  const calls = []
  const context = {
    workflowDraft,
    streamCsv: false,
    hasWorkflowOutputs: true,
    outputFolder: null,
    streamingPage: 'Results',
    streamAllPages: false,
    streamDestination: null,
    receiveRunProgress() {},
    streamingOptions() { return null },
    outputPages() { return [{ name: 'Results' }] },
    Channel: class {},
    async invoke(command, args) {
      calls.push({ command, args })
      return result
    },
    setSelectedRunPage(value) {
      state.selectedRunPage = typeof value === 'function' ? value(state.selectedRunPage) : value
    },
  }
  for (const name of ['runWorkflowSnapshot', 'runResult', 'runProgress', 'csvStreamStatus', 'stopRequest', 'runError', 'runStatus']) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = value => { state[name] = value }
  }

  const run = runInNewContext(code, context)
  await run()

  assert.equal(state.runWorkflowSnapshot, workflowDraft)
  assert.equal(state.selectedRunPage, 'Results')
  assert.equal(state.runResult, result)
  assert.equal(state.runProgress, null)
  assert.equal(state.csvStreamStatus, null)
  assert.equal(state.runError, null)
  assert.equal(state.runStatus, 'idle')
  assert.equal(calls[0].command, 'run_workflow_simulation')
})
