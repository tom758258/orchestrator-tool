import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const live = source.slice(source.indexOf('const runLive'), source.indexOf('const runSimulation'))

test('Live shares the immediate cross-mode run guard and keeps confirmation before replacing Last Run', () => {
  assert.match(live, /if \(!workflowDraft \|\| runInFlightRef\.current\)/)
  assert.match(live, /runInFlightRef\.current = true/)
  assert.ok(live.indexOf('await confirm(') < live.indexOf('runIdRef.current = null'))
  assert.ok(live.indexOf('streamingOptions(') < live.indexOf('runIdRef.current = null'))
  assert.match(live, /finally \{[\s\S]*runInFlightRef\.current = false/)
})

test('Live completion stores compact metadata only and ignores stale generations', () => {
  assert.match(live, /invoke<RunMetadataDto>\('run_workflow_live'/)
  assert.match(live, /if \(generation === runGenerationRef\.current\) \{[\s\S]*setRunMetadata\(results\)/)
  assert.doesNotMatch(live, /setRunResult|setRunProgress|result_rows|step_executions/)
})

test('Live keeps graceful-stop and streaming status cleanup behavior', () => {
  assert.match(live, /setStopRequest\(null\)/)
  assert.match(live, /setCsvStreamStatus\(null\)/)
  assert.match(live, /progressChannelRef\.current === onProgress/)
})
