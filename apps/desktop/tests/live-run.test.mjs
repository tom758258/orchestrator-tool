import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const live = source.slice(source.indexOf('const runLive'), source.indexOf('const runSimulation'))

test('Live keeps the re-entry guard and confirmation before replacing Last Run', () => {
  assert.match(live, /liveRunInFlight\.current/)
  assert.ok(live.indexOf('await confirm(') < live.indexOf('runIdRef.current = null'))
  assert.ok(live.indexOf('streamingOptions(') < live.indexOf('runIdRef.current = null'))
  assert.match(live, /finally \{[\s\S]*liveRunInFlight\.current = false/)
})

test('Live completion stores only returned run metadata', () => {
  assert.match(live, /invoke<RunMetadataDto>\('run_workflow_live'/)
  assert.match(live, /setRunMetadata\(results\)/)
  assert.doesNotMatch(live, /setRunResult|setRunProgress|result_rows|step_executions/)
})

test('Live keeps graceful-stop and streaming status cleanup behavior', () => {
  assert.match(live, /setStopRequest\(null\)/)
  assert.match(live, /setCsvStreamStatus\(null\)/)
  assert.match(live, /progressChannelRef\.current = null/)
})
