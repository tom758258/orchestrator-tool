import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseChartThresholdPercent } from '../src/chartData.ts'

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

test('Chart Sampling is shared by Simulation and Live, configured pre-run and frozen outside Template data', () => {
  // Available in both modes, and named as a general chart setting rather than a Live one.
  assert.match(app, /chartSamplingOptions.*enabled: false, threshold: '5', showMarkers: false/)
  assert.match(app, /aria-labelledby="chart-sampling-options-title"/)
  assert.match(app, /Preserve Significant Changes/)
  assert.doesNotMatch(app, /Live Chart Options|liveChartOptions|activeLiveChartOptions/)

  // One shared rule snapshots the setting and rejects an invalid threshold.
  assert.match(app, /function chartSamplingSnapshot\(options: \{ enabled: boolean; threshold: string; showMarkers: boolean \}\)/)
  assert.match(app, /showMarkers: options\.showMarkers/)
  assert.match(app, /Chart Sampling change threshold must be a finite number greater than zero\./)
  // Both run paths validate first and store the same snapshot.
  const simulation = app.slice(app.indexOf('const runSimulation'), app.indexOf('const runSelectedMode'))
  const live = app.slice(app.indexOf('const runLive'), app.indexOf('const runSimulation'))
  for (const [label, run] of [['Simulation', simulation], ['Live', live]]) {
    assert.match(run, /const chartSampling = chartSamplingOptions\.enabled\s*\n\s*\? chartSamplingSnapshot\(chartSamplingOptions\) : null/, label)
    // Validation must precede any Last Run state being replaced.
    assert.ok(run.indexOf('chartSamplingSnapshot(') < run.indexOf('setRunWorkflowSnapshot(workflowDraft)'), label)
    assert.ok(run.indexOf('chartSamplingSnapshot(') < run.indexOf('runIdRef.current = null'), label)
    assert.match(run, /setRunChartSampling\(chartSampling\)/, label)
  }
  // The snapshot is stored, not the live form value, and is cleared with the Last Run.
  assert.doesNotMatch(app, /setRunChartSampling\(chartSamplingOptions\)/)
  assert.match(app, /setRunChartSampling\(null\)/)

  // The Last Run chart always uses the snapshot, with no mode condition.
  assert.match(app, /changeSettings=\{runChartSampling\} \/>/)
  assert.doesNotMatch(app, /lastRunExecutionMode === 'live' \?/)

  // An invalid threshold blocks the single mode-aware Run button in both modes.
  const onClick = app.indexOf('onClick={() => void runSelectedMode()}')
  const button = app.slice(app.lastIndexOf('<button', onClick), app.indexOf('</button>', onClick))
  assert.match(button, /\|\| chartThresholdInvalid\}/)
  assert.doesNotMatch(button, /executionMode === 'live' &&/)

  const saveTemplate = app.slice(app.indexOf('const handleSaveTemplate'), app.indexOf('const handleSaveTemplate') + 1150)
  assert.doesNotMatch(saveTemplate, /chartSamplingOptions|runChartSampling/)
})

test('both run paths reject the same invalid thresholds through one shared parser', () => {
  for (const valid of ['5', ' 5 ', '0.5', '100', '1e2']) {
    assert.equal(parseChartThresholdPercent(valid), Number(valid.trim()), valid)
  }
  for (const invalid of ['', '   ', '0', '0.0', '-5', '-0.1', 'abc', '5abc', 'NaN',
    'Infinity', '-Infinity', '1/0']) {
    assert.ok(Number.isNaN(parseChartThresholdPercent(invalid)), `expected ${invalid} to be invalid`)
  }
  // Disabled sampling never inspects the threshold, so an empty field is harmless.
  assert.match(app, /const chartThresholdInvalid = chartSamplingOptions\.enabled &&/)
})

test('marker checkbox is in the left sidebar under Streaming, disabled when sampling is off', () => {
  const sidebar = app.slice(app.indexOf('<aside className="workflow-sidebar">'),
    app.indexOf('</aside>', app.indexOf('<aside className="workflow-sidebar">')))
  assert.ok(sidebar.indexOf('className="streaming-panel"') >= 0)
  assert.ok(sidebar.indexOf('className="chart-sampling-options"') > sidebar.indexOf('className="streaming-panel"'))
  assert.equal((app.match(/id="chart-sampling-options-title"/g) ?? []).length, 1)
  assert.match(sidebar, /checked=\{chartSamplingOptions\.showMarkers\}/)
  assert.match(sidebar, /disabled=\{!chartSamplingOptions\.enabled\}/)
  assert.match(sidebar, /Show Significant Change Markers/)
  assert.doesNotMatch(app.slice(app.indexOf('</aside>'), app.indexOf('className="workflow-actions"')),
    /className="chart-sampling-options"/)
})

test('Steps, Streaming and Chart Sampling Options collapse with the shared +/- header', () => {
  const sidebar = app.slice(app.indexOf('<aside className="workflow-sidebar">'),
    app.indexOf('</aside>', app.indexOf('<aside className="workflow-sidebar">')))
  // Every top-level sidebar panel starts expanded and reuses the shared header.
  for (const state of ['stepsExpanded', 'streamingExpanded', 'chartSamplingExpanded']) {
    const setter = `set${state[0].toUpperCase()}${state.slice(1)}`
    assert.match(app, new RegExp(`const \\[${state}, ${setter}\\] = useState\\(true\\)`), state)
    assert.match(sidebar, new RegExp(`aria-expanded=\\{${state}\\}`), state)
    assert.match(sidebar, new RegExp(`<span aria-hidden="true">\\{${state} \\? '\u2212' : '\\+'\\}</span>`), state)
    assert.match(sidebar, new RegExp(`onClick=\\{\\(\\) => ${setter}\\(current => !current\\)\\}`), state)
  }
  // Panel order and the label content stay unchanged.
  assert.ok(sidebar.indexOf('className="step-palette"') < sidebar.indexOf('className="streaming-panel"'))
  assert.ok(sidebar.indexOf('className="streaming-panel"') < sidebar.indexOf('className="chart-sampling-options"'))

  // Panel bodies render only while expanded, and the step category state is untouched.
  assert.match(sidebar, /\{stepsExpanded && <>/)
  assert.match(sidebar, /\{streamingExpanded && <>/)
  assert.match(sidebar, /\{chartSamplingExpanded && <fieldset className="chart-sampling-fields" disabled=\{workflowBusy\}>/)
  assert.match(sidebar, /aria-expanded=\{expandedStepCategories\[category\]\}/)
  assert.doesNotMatch(sidebar, /<legend>Chart Sampling Options<\/legend>/)
})

test('collapsing a sidebar panel hides content without changing any setting', () => {
  const sidebar = app.slice(app.indexOf('<aside className="workflow-sidebar">'),
    app.indexOf('</aside>', app.indexOf('<aside className="workflow-sidebar">')))
  for (const setter of ['setStepsExpanded', 'setStreamingExpanded', 'setChartSamplingExpanded']) {
    assert.equal((app.match(new RegExp(`const \\[\\w+, ${setter}\\]`, 'g')) ?? []).length, 1, setter)
    assert.equal((sidebar.match(new RegExp(`${setter}\\(current => !current\\)`, 'g')) ?? []).length, 1, setter)
  }
  // Streaming and Chart Sampling keep their own state setters outside the panel toggles.
  for (const setter of ['setStreamCsv', 'setStreamPage', 'setStreamAllPages', 'setStreamOutputFolder',
    'setChartSamplingOptions', 'setExpandedStepCategories']) {
    assert.ok(!sidebar.includes(`${setter}(current => !current)`), setter)
  }
})
