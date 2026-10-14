import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transformWithOxc } from 'vite'
import { allWorkflowSteps } from '../src/workflow.ts'
import { claimRunGate, isCurrentRunGeneration, releaseRunGate } from '../src/runLifecycle.ts'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const live = source.slice(source.indexOf('const runLive'), source.indexOf('const runSimulation'))

test('Live shares the immediate cross-mode run guard and keeps confirmation before replacing Last Run', () => {
  assert.match(live, /if \(!workflowDraft \|\| !claimRunGate\(runInFlightRef\)\)/)
  assert.ok(live.indexOf('await confirm(') < live.indexOf('runIdRef.current = null'))
  assert.ok(live.indexOf('streamingOptions(') < live.indexOf('runIdRef.current = null'))
  assert.match(live, /finally \{[\s\S]*releaseRunGate\(runInFlightRef\)/)
})

test('Live completion stores compact metadata only and ignores stale generations', () => {
  assert.match(live, /invoke<RunMetadataDto>\('run_workflow_live'/)
  assert.match(live, /if \(isCurrentRunGeneration\(generation, runGenerationRef\.current\)\) \{[\s\S]*setRunMetadata\(results\)/)
  assert.doesNotMatch(live, /setRunResult|setRunProgress|result_rows|step_executions/)
})

test('Live keeps graceful-stop and streaming status cleanup behavior', () => {
  assert.match(live, /setStopRequest\(null\)/)
  assert.match(live, /setCsvStreamStatus\(null\)/)
  assert.match(live, /progressChannelRef\.current === onProgress/)
})

const { code } = await transformWithOxc(live, 'runLive.ts')
function liveHarness(result) {
  const old = { run_id: 7, status: 'succeeded', pages: [{ row_count: 1 }], error: null }
  const context = {
    workflowDraft: { tool_instances: [{ id: 'power', tool: 'powers', setup: {} }], workflow: { steps: [
      { type: 'tool-action', id: 'off', target: 'power', action: 'output-off', arguments: { channel: 1 } },
    ] } },
    livePreflight: { blocked: false, reject(error) { context.preflightError = error } },
    runInFlightRef: { current: false }, runGenerationRef: { current: 0 }, runIdRef: { current: 7 }, progressChannelRef: { current: null },
    chartSamplingOptions: { enabled: false }, chartFitData: false, resourceDrafts: { power: 'USB::1' },
    streamCsv: false, hasWorkflowOutputs: false, streamOutputFolder: null, streamingPage: 'Results', streamAllPages: false, scopesOutputFolder: null,
    useCallback: callback => callback, claimRunGate, isCurrentRunGeneration, releaseRunGate, allWorkflowSteps,
    confirm: async () => true, formatLiveResourceConfirmation: () => 'power USB::1', streamingOptions: () => null,
    outputPages: () => [{ name: 'Results' }],
    Channel: class { constructor(callback) { this.onmessage = callback } },
    invoke: async command => {
      if (command === 'get_tool_status') return []
      if (command === 'get_live_resources') return { power: 'USB::1' }
      if (command === 'get_live_resource_identities') return {}
      if (command === 'run_workflow_live') return result()
      throw new Error(command)
    },
    receiveRunProgress: event => {
      if (event.type === 'csv-stream') { context.view.csvStreamStatus = event.status; return }
      context.runIdRef.current = event.run.run_id
      context.view.runMetadata = event.run
    },
    view: { runMetadata: old, runWorkflowSnapshot: { name: 'previous' }, executionPage: ['execution'], messagePage: ['message'], runStatus: 'idle' },
  }
  for (const name of code.matchAll(/\b(set[A-Z]\w+)\(/g)) {
    context[name[1]] = value => {
      const key = name[1][3].toLowerCase() + name[1].slice(4)
      context.view[key] = value
    }
  }
  return { context, run: new Function('context', `with (context) { ${code}; return runLive }`)(context) }
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

test('live_preflight backend rejection preserves Last Run and is not a Run failure', async () => {
  const h = liveHarness(() => Promise.reject('Live Preflight failed: CH3 unsupported'))
  const before = structuredClone(h.context.view)
  await h.run()
  for (const key of ['runMetadata', 'runWorkflowSnapshot', 'executionPage', 'messagePage', 'runStatus']) {
    assert.deepEqual(h.context.view[key], before[key])
  }
  assert.equal(h.context.runIdRef.current, 7)
  assert.equal(h.context.runInFlightRef.current, false)
  assert.equal(h.context.view.runError, undefined)
  assert.match(h.context.preflightError, /CH3 unsupported/)
})

test('live_preflight keeps Last Run until the backend accepts a new run, then receives its results', async () => {
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const h = liveHarness(() => pending)
  const run = h.run()
  await settle()
  assert.equal(h.context.runIdRef.current, 7)
  assert.equal(h.context.view.runMetadata.run_id, 7)
  assert.deepEqual(h.context.view.messagePage, ['message'])
  h.context.progressChannelRef.current.onmessage({ type: 'csv-stream', status: { state: 'streaming' } })
  assert.equal(h.context.view.csvStreamStatus.state, 'streaming')
  const next = { run_id: 8, status: 'running' }
  h.context.progressChannelRef.current.onmessage({ type: 'progress-batch', run: next, completed_step_ids: [] })
  assert.equal(h.context.view.runMetadata.run_id, 8)
  assert.equal(h.context.view.runStatus, 'running')
  assert.equal(h.context.view.messagePage, null)
  assert.equal(h.context.runIdRef.current, 8)
  assert.equal(h.context.view.executionPage, null)
  // Startup is still pending with no Step progress, but the accepted Run is visible.
  await settle()
  assert.equal(h.context.view.runStatus, 'running')
  h.context.view.executionPage = ['new execution']
  h.context.view.messagePage = ['new message']
  const snapshot = h.context.view.runWorkflowSnapshot
  const progress = { ...next, execution_count: 1 }
  h.context.progressChannelRef.current.onmessage({ type: 'progress-batch', run: progress, completed_step_ids: ['off'] })
  h.context.progressChannelRef.current.onmessage({ type: 'progress-batch', run: progress, completed_step_ids: [] })
  assert.equal(h.context.view.runWorkflowSnapshot, snapshot)
  assert.deepEqual(h.context.view.executionPage, ['new execution'])
  assert.deepEqual(h.context.view.messagePage, ['new message'])
  complete({ ...next, status: 'succeeded' })
  await run
  assert.equal(h.context.view.runMetadata.status, 'succeeded')
  assert.equal(h.context.view.runStatus, 'idle')
})

test('accepted Live Worker startup failure is shown on the new Run', async () => {
  let complete
  const h = liveHarness(() => new Promise(resolve => { complete = resolve }))
  const run = h.run()
  await settle()
  const next = { run_id: 8, status: 'running', execution_count: 0, error: null }
  h.context.progressChannelRef.current.onmessage({ type: 'progress-batch', run: next, completed_step_ids: [] })
  complete({ ...next, status: 'failed', error: 'Worker startup failed' })
  await run
  assert.equal(h.context.runIdRef.current, 8)
  assert.equal(h.context.view.runMetadata.status, 'failed')
  assert.equal(h.context.view.runMetadata.error, 'Worker startup failed')
  assert.equal(h.context.preflightError, undefined)
})

test('stale Live generation events and completion cannot replace the current Run', async () => {
  let complete
  const h = liveHarness(() => new Promise(resolve => { complete = resolve }))
  const run = h.run()
  await settle()
  const staleChannel = h.context.progressChannelRef.current
  h.context.runGenerationRef.current += 1
  const current = { run_id: 9, status: 'running' }
  h.context.runIdRef.current = 9
  h.context.view.runMetadata = current
  h.context.view.runStatus = 'running'
  staleChannel.onmessage({ type: 'progress-batch', run: { run_id: 8, status: 'running' }, completed_step_ids: [] })
  staleChannel.onmessage({ type: 'csv-stream', status: { state: 'failed' } })
  complete({ run_id: 8, status: 'succeeded' })
  await run
  assert.equal(h.context.runIdRef.current, 9)
  assert.equal(h.context.view.runMetadata, current)
  assert.equal(h.context.view.runStatus, 'running')
  assert.deepEqual(h.context.view.messagePage, ['message'])
  assert.equal(h.context.view.csvStreamStatus, undefined)
})

test('live_preflight Checking or Failed prevents Live invocation through the callback guard', async () => {
  const h = liveHarness(() => { assert.fail('Live backend must not be called') })
  h.context.livePreflight.blocked = true
  await h.run()
  assert.equal(h.context.runIdRef.current, 7)
  assert.equal(h.context.view.runMetadata.run_id, 7)
})
