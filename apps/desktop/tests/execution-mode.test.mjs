import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const setup = readFileSync(new URL('../src/ToolSetupEditor.tsx', import.meta.url), 'utf8')
const mode = readFileSync(new URL('../src/executionMode.ts', import.meta.url), 'utf8')

test('Desktop Execution Mode defaults and resets to Simulation without entering Template data', () => {
  assert.match(mode, /DEFAULT_EXECUTION_MODE: ExecutionMode = 'simulate'/)
  assert.match(app, /useState<ExecutionMode>\(DEFAULT_EXECUTION_MODE\)/)
  assert.ok((app.match(/setExecutionMode\(DEFAULT_EXECUTION_MODE\)/g) ?? []).length >= 2)
  assert.doesNotMatch(app, /workflowDraft[^\n]*executionMode|execution_mode[^\n]*workflowDraft/)
})

test('one mode-aware Run dispatches to the existing mode-specific commands', () => {
  assert.match(mode, /mode === 'simulate' \? 'run_workflow_simulation' : 'run_workflow_live'/)
  assert.match(app, /const runSelectedMode/)
  assert.match(app, /workflowRunCommand\(executionMode\)/)
  assert.equal((app.match(/onClick=\{\(\) => void runSelectedMode\(\)\}/g) ?? []).length, 1)
  assert.doesNotMatch(app, />\s*Run Simulation\s*<\/button>[\s\S]*>\s*Run Live\s*<\/button>/)
})

test('mode selector and visible mode labels remain locked during external operations', () => {
  assert.match(app, /aria-label="Desktop Execution Mode"/)
  assert.match(app, /disabled=\{workflowBusy\}/)
  assert.match(app, /executionModeLabel\(executionMode\)/)
  assert.match(app, /executionModeLabel\(lastRunExecutionMode\)/)
  assert.match(setup, /executionModeLabel\(executionMode\)/)
})

test('capability queries select simulator identity only in Simulation', () => {
  assert.match(setup, /model=\{executionMode === 'live' \? resourceIdentities\[instance\.id\]\?\.model : undefined\}/)
  assert.match(setup, /modelId=\{executionMode === 'live' \? resourceIdentities\[instance\.id\]\?\.model_id : undefined\}/)
  assert.match(setup, /get_meters_capabilities[\s\S]*executionMode/)
  assert.match(setup, /get_powers_capabilities[\s\S]*executionMode/)
})

test('Live Resource remains stored for Live mode and saving it does not switch modes', () => {
  assert.match(app, /Stored for Live mode\. Current execution mode is Simulation\./)
  const handler = app.slice(app.indexOf('const handleResource'), app.indexOf('const refreshPowersStatus'))
  assert.doesNotMatch(handler, /setExecutionMode/)
})
