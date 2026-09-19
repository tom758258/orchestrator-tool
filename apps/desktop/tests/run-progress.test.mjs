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

const execution = step_id => ({ type: 'progress-batch', step_executions: [{ step_id }], result_rows: [] })
const row = id => ({ type: 'progress-batch', step_executions: [], result_rows: [{ id }] })

test('one batch preserves both event orders and clears only the completed targeted loop', () => {
  const { state, timers, context: c } = harness()
  state.progress = { step_executions: [{ step_id: 'A' }], result_rows: [{ id: 1 }] }
  state.stop = { loopId: 'loop' }
  c.receiveRunProgress({ type: 'progress-batch', step_executions: [{ step_id: 'B' }, { step_id: 'C' }], result_rows: [{ id: 2 }, { id: 3 }] })
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

for (const cancelAfterFirstFrame of [false, true]) {
  test(`startup defers probes and cancels StrictMode replay after ${cancelAfterFirstFrame ? 'first' : 'zero'} frames`, () => {
    const end = source.indexOf('}, [createDraft, refresh])')
    const start = source.lastIndexOf('  useEffect(() => {', end)
    assert.ok(start >= 0 && end > start)
    const frames = new Map()
    const calls = []
    let nextFrame = 0
    const setup = runInNewContext(stripTypeScriptTypes('(() => {' + source.slice(start + '  useEffect(() => {'.length, end) + '})'), {
      requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id },
      cancelAnimationFrame(id) { frames.delete(id) },
      refresh() { calls.push('refresh') }, createDraft() { calls.push('draft') },
    })
    const paint = () => {
      const pending = [...frames.values()]
      frames.clear()
      for (const fn of pending) fn()
    }
    const cleanup = setup()
    assert.deepEqual(calls, [])
    if (cancelAfterFirstFrame) paint()
    assert.deepEqual(calls, [])
    cleanup()
    assert.equal(frames.size, 0)
    const cleanupReplay = setup()
    paint()
    assert.deepEqual(calls, [])
    paint()
    assert.deepEqual(calls, ['refresh', 'draft'])
    cleanupReplay()
    paint()
    assert.deepEqual(calls, ['refresh', 'draft'])
  })
}

test('startup preserves StrictMode and direct manual Refresh', () => {
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
  assert.match(main, /<StrictMode>/)
  assert.match(source, /onClick=\{\(\) => void refresh\(\)\}/)
})

test('status Refresh and local tool configuration controls are mutually exclusive', () => {
  const toolsPanel = source.slice(
    source.indexOf('<section id="tools-panel"'),
    source.indexOf('<section id="setup-panel"'),
  )
  assert.match(toolsPanel, /onClick=\{\(\) => void refresh\(\)\}\s+disabled=\{loading \|\| toolConfigBusy !== null\}/)
  assert.match(toolsPanel, /handleBrowseToolExecutable\(tool\.tool_id\)[\s\S]+?disabled=\{toolConfigBusy !== null \|\| workflowBusy \|\| loading\}/)
  assert.match(toolsPanel, /handleResetToolExecutable\(tool\.tool_id\)[\s\S]+?disabled=\{toolConfigBusy !== null \|\| workflowBusy \|\| loading \|\| tool\.source !== 'configured'\}/)

  const setupStart = source.indexOf('<section id="setup-panel"')
  const setupPanel = source.slice(setupStart, source.indexOf("{activeTab === 'workflow'", setupStart))
  assert.equal(
    (setupPanel.match(/disabled=\{toolConfigBusy !== null \|\| workflowBusy \|\| loading\}/g) ?? []).length,
    5,
  )
})

test('both Desktop run adapters flush before propagating run failure', () => {
  const backend = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
  assert.equal((backend.match(/batcher\.flush\(\);\s*let results = run_result\?;/g) ?? []).length, 2)
})
