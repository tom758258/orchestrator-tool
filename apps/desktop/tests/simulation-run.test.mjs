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
  assert.match(button, /disabled=\{workflowBusy \|\| toolConfigBusy !== null \|\| loading/)
  // Chart Sampling is mode-independent, so an invalid threshold blocks Simulation too.
  assert.match(button, /\|\| chartThresholdInvalid\}/)
  assert.doesNotMatch(button, /executionMode === 'live' &&/)
})

test('Simulation snapshots Chart Options the same way Live does', () => {
  assert.match(simulation, /const chartSampling = chartSamplingOptions\.enabled\s*\n\s*\? chartSamplingSnapshot\(chartSamplingOptions\) : null/)
  assert.match(simulation, /const fitData = chartFitData/)
  assert.match(simulation, /setRunChartSampling\(chartSampling\)/)
  assert.match(simulation, /setRunChartFitData\(fitData\)/)
  // Simulation no longer discards the sampling snapshot unconditionally.
  assert.doesNotMatch(simulation, /setRunChartSampling\(null\)/)
  // The threshold is validated before the Last Run is replaced, so a bad value
  // cannot destroy the previous run.
  assert.ok(simulation.indexOf('chartSamplingSnapshot(') < simulation.indexOf('setRunWorkflowSnapshot(workflowDraft)'))
  assert.ok(simulation.indexOf('chartSamplingSnapshot(') < simulation.indexOf('runIdRef.current = null'))
  // Changing either control for the next run does not alter the current Last Run chart.
  assert.match(simulation, /\}, \[workflowDraft, chartSamplingOptions, chartFitData, receiveRunProgress,/)
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
