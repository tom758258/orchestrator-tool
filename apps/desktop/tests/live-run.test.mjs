import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

// Exercise the actual component callback without a WebView or instrument runtime.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const start = source.indexOf('  const runLive = useCallback(')
const end = source.indexOf('\n  const runSimulation =', start)
assert.ok(start >= 0 && end > start, 'Live callback boundaries exist')
const declaration = source.slice(start, end)
const callback = declaration.slice(declaration.indexOf('async () =>'), declaration.lastIndexOf('}, [') + 1)
const code = stripTypeScriptTypes('(' + callback + ')')

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness({ streamingError = null } = {}) {
  const dialog = deferred()
  const execution = deferred()
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
    runError: 'previous error',
  }
  const state = { ...previous, selectedRunPage: 'Results' }
  const changes = []
  const calls = []
  let confirmations = 0
  let channels = 0
  let streamOptions = 0
  const context = {
    workflowDraft: { tool_instances: [], workflow: { steps: [] } },
    resourceDrafts: {}, runStatus: 'idle', liveRunInFlight: { current: false },
    streamCsv: true, hasWorkflowOutputs: true, outputFolder: 'data',
    streamingPage: 'Results', streamAllPages: false, streamDestination: 'results.csv',
    setTools() {}, receiveRunProgress() {},
    outputPages() { return [] },
    setSelectedRunPage(value) {
      state.selectedRunPage = typeof value === 'function' ? value(state.selectedRunPage) : value
    },
    streamingOptions() {
      streamOptions++
      if (streamingError) throw new Error(streamingError)
      return { output_folder: 'data' }
    },
    Channel: class { constructor() { channels++ } },
    confirm() { confirmations++; return dialog.promise },
    async invoke(command, args) {
      calls.push({ command, args })
      if (command === 'run_workflow_live') return execution.promise
      return command === 'get_tool_status' ? [] : {}
    },
  }
  for (const name of [...Object.keys(previous), 'liveConfirmationPending']) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = value => {
      state[name] = value
      changes.push(name)
    }
  }
  return {
    run: runInNewContext(code, context), context, state, previous, changes, calls, dialog, execution,
    counts: () => ({ confirmations, channels, streamOptions }),
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('Cancel preserves previous run state and releases the guard', async () => {
  const h = harness()
  const pending = h.run()
  await flush()
  for (const [key, value] of Object.entries(h.previous)) assert.equal(h.state[key], value)
  h.dialog.resolve(false)
  await pending
  for (const [key, value] of Object.entries(h.previous)) assert.equal(h.state[key], value)
  assert.deepEqual(h.changes.filter(key => key !== 'liveConfirmationPending'), [])
  assert.deepEqual(h.counts(), { confirmations: 1, channels: 0, streamOptions: 0 })
  assert.equal(h.calls.some(call => call.command === 'run_workflow_live'), false)
  assert.equal(h.context.liveRunInFlight.current, false)
  await h.run()
  assert.equal(h.counts().confirmations, 2)
})

test('Rapid calls share one confirmation and execution; Confirm resets state', async () => {
  const h = harness()
  const pending = h.run()
  await h.run()
  await flush()
  await h.run()
  assert.equal(h.counts().confirmations, 1)
  h.dialog.resolve(true)
  await flush()
  await h.run()
  assert.deepEqual(h.counts(), { confirmations: 1, channels: 1, streamOptions: 1 })
  assert.equal(h.calls.filter(call => call.command === 'run_workflow_live').length, 1)
  assert.equal(h.state.runStatus, 'running')
  assert.equal(h.state.runWorkflowSnapshot, h.context.workflowDraft)
  assert.equal(h.state.selectedRunPage, 'Results')
  assert.equal(h.state.runResult, null)
  assert.equal(h.state.csvStreamStatus, null)
  assert.equal(h.state.runError, null)
  assert.equal(h.state.stopRequest, null)
  assert.equal(h.state.runProgress.step_executions.length, 0)
  assert.equal(h.state.runProgress.result_rows.length, 0)
  const result = {
    step_executions: [],
    result_rows: [{
      page: 'Results',
      outputs: [{ name: 'value', value: 99 }],
      for_iteration: null,
      while_iteration: null,
    }],
  }
  h.execution.resolve(result)
  await pending
  assert.equal(h.state.runResult, result)
  assert.equal(h.state.runProgress, null)
  assert.equal(h.state.runStatus, 'idle')
  assert.equal(h.context.liveRunInFlight.current, false)
  await h.run()
  assert.equal(h.counts().confirmations, 2)
})

test('Invalid Streaming config after confirmation preserves the previous Last Run', async () => {
  const h = harness({ streamingError: 'Select a destination CSV before running.' })
  const pending = h.run()
  await flush()
  h.dialog.resolve(true)
  await pending
  for (const key of ['runWorkflowSnapshot', 'runResult', 'runProgress', 'csvStreamStatus', 'stopRequest']) {
    assert.equal(h.state[key], h.previous[key])
  }
  assert.equal(h.state.runStatus, 'idle')
  assert.equal(h.calls.some(call => call.command === 'run_workflow_live'), false)
  assert.deepEqual(h.counts(), { confirmations: 1, channels: 0, streamOptions: 1 })
})

test('Confirmation and execution errors release the guard; running blocks Live', async () => {
  for (const phase of ['confirmation', 'execution']) {
    const h = harness()
    const pending = h.run()
    await flush()
    if (phase === 'confirmation') h.dialog.reject(new Error('dialog failed'))
    else {
      h.dialog.resolve(true)
      await flush()
      h.execution.reject(new Error('execution failed'))
    }
    await pending
    assert.equal(h.context.liveRunInFlight.current, false)
    assert.equal(h.state.liveConfirmationPending, false)
    assert.equal(h.state.runStatus, 'idle')
    if (phase === 'confirmation') {
      for (const key of ['runWorkflowSnapshot', 'runResult', 'runProgress', 'csvStreamStatus', 'stopRequest']) {
        assert.equal(h.state[key], h.previous[key])
      }
    }
    await h.run()
    assert.equal(h.counts().confirmations, 2)
  }
  const h = harness()
  h.context.runStatus = 'running'
  await h.run()
  assert.equal(h.calls.length, 0)
  assert.equal(h.counts().confirmations, 0)
})
