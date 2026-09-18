import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

function callback(name, endMarker) {
  const start = source.indexOf(`  const ${name} = useCallback(`)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start)
  const declaration = source.slice(start, end)
  return stripTypeScriptTypes('(' + declaration.slice(
    declaration.indexOf('useCallback(') + 'useCallback('.length, declaration.lastIndexOf('}, [') + 1,
  ) + ')')
}

function harness() {
  const state = { progress: null, stop: null, progressUpdates: 0, stopUpdates: 0 }
  const timers = new Map()
  let nextTimer = 0
  const context = {
    pendingStepExecutionsRef: { current: [] }, pendingResultRowsRef: { current: [] },
    pendingCompletedStepIdsRef: { current: new Set() }, progressFlushTimerRef: { current: null },
    progressChannelRef: { current: null },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    setRunProgress(update) {
      state.progress = typeof update === 'function' ? update(state.progress) : update
      state.progressUpdates++
    },
    setStopRequest(update) {
      state.stop = typeof update === 'function' ? update(state.stop) : update
      state.stopUpdates++
    },
    setCsvStreamStatus(value) { state.csv = value },
  }
  context.resetRunProgressBatch = runInNewContext(callback('resetRunProgressBatch', '\n  const flushRunProgressBatch'), context)
  context.flushRunProgressBatch = runInNewContext(callback('flushRunProgressBatch', '\n  useEffect'), context)
  context.receiveRunProgress = runInNewContext(callback('receiveRunProgress', '\n  const runLive'), context)
  return { state, timers, context }
}

const execution = step_id => ({ type: 'step-completed', execution: { step_id } })
const row = id => ({ type: 'result-row-committed', row: { id } })

test('one batch preserves both event orders and clears only the completed targeted loop', () => {
  const { state, timers, context: c } = harness()
  state.progress = { step_executions: [{ step_id: 'A' }], result_rows: [{ id: 1 }] }
  state.stop = { loopId: 'loop' }
  for (const event of [execution('B'), row(2), execution('C'), row(3)]) c.receiveRunProgress(event)
  assert.equal(state.progressUpdates, 0)
  assert.equal(state.stopUpdates, 0)
  assert.equal(timers.size, 1)
  assert.equal([...timers.values()][0].delay, 100)
  c.flushRunProgressBatch()
  assert.deepEqual(Array.from(state.progress.step_executions, value => value.step_id), ['A', 'B', 'C'])
  assert.deepEqual(Array.from(state.progress.result_rows, value => value.id), [1, 2, 3])
  assert.equal(state.progressUpdates, 1)
  assert.equal(state.stopUpdates, 1)
  assert.equal(state.stop.loopId, 'loop')
  c.receiveRunProgress(execution('loop'))
  c.flushRunProgressBatch()
  assert.equal(state.stop, null)
  assert.equal(timers.size, 0)
  assert.equal(c.pendingCompletedStepIdsRef.current.size, 0)
  const previous = state.progress
  c.flushRunProgressBatch()
  assert.equal(state.progress, previous)
  assert.equal(state.progressUpdates, 2)
})

test('CSV status updates directly without scheduling a progress batch', () => {
  const { state, timers, context: c } = harness()
  const status = { rows: 5 }
  c.receiveRunProgress({ type: 'csv-stream', status })
  assert.equal(state.csv, status)
  assert.equal(timers.size, 0)
  assert.equal(state.progressUpdates, 0)
})

for (const mode of ['Simulation', 'Live']) {
  for (const failure of [false, true]) {
    test(`${mode} resets old batches and ${failure ? 'preserves pending progress on failure' : 'keeps final results authoritative'}`, async () => {
      const { state, timers, context: c } = harness()
      c.receiveRunProgress(execution('stale'))
      c.receiveRunProgress(row('stale'))
      const final = { step_executions: [{ step_id: 'final' }], result_rows: [{ id: 'final' }] }
      let channel
      Object.assign(c, {
        workflowDraft: { tool_instances: [], workflow: { steps: [] } },
        runStatus: 'idle', liveRunInFlight: { current: false }, resourceDrafts: {},
        streamCsv: false, hasWorkflowOutputs: false, outputFolder: null,
        streamingPage: 'Results', streamAllPages: false, streamDestination: null,
        streamingOptions() { return null }, outputPages() { return [] },
        async confirm() { return true },
        Channel: class { constructor(receive) { this.onmessage = receive; channel = this } },
        setRunResult(value) { state.result = value }, setRunError(value) { state.error = value },
        async invoke(command) {
          if (!command.startsWith('run_workflow_')) return {}
          assert.equal(timers.size, 0)
          assert.equal(c.pendingStepExecutionsRef.current.length, 0)
          assert.equal(c.pendingResultRowsRef.current.length, 0)
          assert.equal(c.pendingCompletedStepIdsRef.current.size, 0)
          assert.equal(state.progress.step_executions.length, 0)
          channel.onmessage(execution('partial'))
          channel.onmessage(row('committed'))
          if (failure) throw new Error('invoke failed')
          return final
        },
      })
      for (const name of ['Tools', 'LiveConfirmationPending', 'RunWorkflowSnapshot', 'WorkflowChangedSinceRun',
        'SelectedRunPage', 'ExecutionOffset', 'RunStatus']) c[`set${name}`] = () => {}
      const end = mode === 'Live' ? '\n  const runSimulation' : '\n  const workflowBusy'
      await runInNewContext(callback(`run${mode}`, end), c)()
      assert.equal(timers.size, 0)
      assert.equal(c.pendingResultRowsRef.current.length, 0)
      if (failure) {
        assert.equal(state.result, null)
        assert.deepEqual(Array.from(state.progress.step_executions, value => value.step_id), ['partial'])
        assert.deepEqual(Array.from(state.progress.result_rows, value => value.id), ['committed'])
        assert.match(state.error, /invoke failed/)
      } else {
        assert.equal(state.result, final)
        assert.equal(state.progress, null)
      }
      channel.onmessage(row('late'))
      assert.equal(timers.size, 0)
    })
  }
}
