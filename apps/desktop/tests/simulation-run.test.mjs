import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const simulation = source.slice(source.indexOf('const runSimulation'), source.indexOf('const workflowBusy'))

test('Run Simulation is guarded immediately before React busy state can render', () => {
  assert.match(simulation, /if \(!workflowDraft \|\| !claimRunGate\(runInFlightRef\)\)/)
  assert.match(simulation, /finally \{[\s\S]*releaseRunGate\(runInFlightRef\)/)
  const onClick = source.indexOf('onClick={() => void runSelectedMode()}')
  const button = source.slice(source.lastIndexOf('<button', onClick), source.indexOf('</button>', onClick))
  assert.match(button, /disabled=\{workflowBusy \|\| toolConfigBusy !== null \|\| loading\}/)
})

test('Simulation validates streaming options before replacing Last Run state', () => {
  assert.ok(simulation.indexOf('streamingOptions(') < simulation.indexOf('runIdRef.current = null'))
  assert.ok(simulation.indexOf('streamingOptions(') < simulation.indexOf('setRunWorkflowSnapshot(workflowDraft)'))
})

test('Simulation completion stores compact metadata only and ignores stale generations', () => {
  assert.match(simulation, /invoke<RunMetadataDto>\('run_workflow_simulation'/)
  assert.match(simulation, /if \(isCurrentRunGeneration\(generation, runGenerationRef\.current\)\) \{[\s\S]*setRunMetadata\(results\)/)
  assert.doesNotMatch(simulation, /setRunResult|setRunProgress|result_rows|step_executions/)
})
