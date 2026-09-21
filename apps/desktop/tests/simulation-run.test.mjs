import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const simulation = source.slice(source.indexOf('const runSimulation'), source.indexOf('const workflowBusy'))

test('Run Simulation remains disabled while another desktop operation is busy', () => {
  const onClick = source.indexOf('onClick={() => void runSimulation()}')
  const button = source.slice(source.lastIndexOf('<button', onClick), source.indexOf('</button>', onClick))
  assert.match(button, /disabled=\{workflowBusy \|\| toolConfigBusy !== null \|\| loading\}/)
})

test('Simulation validates streaming options before replacing Last Run state', () => {
  assert.ok(simulation.indexOf('streamingOptions(') < simulation.indexOf('runIdRef.current = null'))
  assert.ok(simulation.indexOf('streamingOptions(') < simulation.indexOf('setRunWorkflowSnapshot(workflowDraft)'))
})

test('Simulation completion stores compact metadata only', () => {
  assert.match(simulation, /invoke<RunMetadataDto>\('run_workflow_simulation'/)
  assert.match(simulation, /setRunMetadata\(results\)/)
  assert.doesNotMatch(simulation, /setRunResult|setRunProgress|result_rows|step_executions/)
})
