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

test('Chart Options are shared by Simulation and Live, snapshotted per run and outside Template data', () => {
  assert.match(app, /chartSamplingOptions.*enabled: false, threshold: '5', showMarkers: false/)
  assert.match(app, /const \[chartFitData, setChartFitData\] = useState\(false\)/)
  assert.match(app, /aria-labelledby="chart-options-title"/)
  assert.match(app, /Chart Options/)
  assert.match(app, /Preserve Significant Changes/)
  assert.match(app, /Fit Data/)
  assert.doesNotMatch(app, /Live Chart Options|liveChartOptions|activeLiveChartOptions/)

  // Sampling keeps its shared validation rule; Fit Data is captured beside it.
  assert.match(app, /function chartSamplingSnapshot\(options: \{ enabled: boolean; threshold: string; showMarkers: boolean \}\)/)
  assert.match(app, /showMarkers: options\.showMarkers/)
  assert.match(app, /Chart Sampling change threshold must be a finite number greater than zero\./)
  const simulation = app.slice(app.indexOf('const runSimulation'), app.indexOf('const runSelectedMode'))
  const live = app.slice(app.indexOf('const runLive'), app.indexOf('const runSimulation'))
  for (const [label, run] of [['Simulation', simulation], ['Live', live]]) {
    assert.match(run, /const chartSampling = chartSamplingOptions\.enabled\s*\n\s*\? chartSamplingSnapshot\(chartSamplingOptions\) : null/, label)
    assert.match(run, /const fitData = chartFitData/, label)
    // Sampling validation must precede any Last Run state being replaced.
    assert.ok(run.indexOf('chartSamplingSnapshot(') < run.indexOf('setRunWorkflowSnapshot(workflowDraft)'), label)
    assert.ok(run.indexOf('chartSamplingSnapshot(') < run.indexOf('runIdRef.current = null'), label)
    assert.match(run, /setRunChartSampling\(chartSampling\)/, label)
    assert.match(run, /setRunChartFitData\(fitData\)/, label)
  }
  // Last Run consumes snapshots, not the editable controls.
  assert.doesNotMatch(app, /setRunChartSampling\(chartSamplingOptions\)/)
  assert.doesNotMatch(app, /setRunChartFitData\(chartFitData\)/)
  assert.match(app, /setRunChartSampling\(null\)/)
  assert.match(app, /setRunChartFitData\(false\)/)
  assert.match(app, /changeSettings=\{runChartSampling\} fitData=\{runChartFitData\}[\s\S]*?saveChartsWithTemplate=\{saveChartsWithTemplate\}[\s\S]*?onSaveChartsWithTemplateChange=\{setSaveChartsWithTemplate\} \/>/)
  assert.doesNotMatch(app, /lastRunExecutionMode === 'live' \?/)

  // An invalid sampling threshold still blocks the single mode-aware Run button in both modes.
  const onClick = app.indexOf('onClick={() => void runSelectedMode()}')
  const button = app.slice(app.lastIndexOf('<button', onClick), app.indexOf('</button>', onClick))
  assert.match(button, /\|\| chartThresholdInvalid\}/)
  assert.doesNotMatch(button, /executionMode === 'live' &&/)

  const saveTemplate = app.slice(app.indexOf('const handleSaveTemplate'), app.indexOf('const handleSaveTemplate') + 1150)
  assert.doesNotMatch(saveTemplate, /chartSamplingOptions|runChartSampling|chartFitData|runChartFitData/)
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

test('Sampling and Fit Data controls are grouped under Chart Options below CSV Export', () => {
  const sidebar = app.slice(app.indexOf('<aside className="workflow-sidebar">'),
    app.indexOf('</aside>', app.indexOf('<aside className="workflow-sidebar">')))
  assert.ok(sidebar.indexOf('className="streaming-panel"') >= 0)
  assert.match(sidebar, /onClick=\{\(\) => setStreamingExpanded\(current => !current\)\}>\s*CSV Export\s*<span/)
  assert.ok(sidebar.indexOf('className="chart-options"') > sidebar.indexOf('className="streaming-panel"'))
  assert.equal((app.match(/id="chart-options-title"/g) ?? []).length, 1)
  assert.match(sidebar, /checked=\{chartSamplingOptions\.showMarkers\}/)
  assert.match(sidebar, /disabled=\{!chartSamplingOptions\.enabled\}/)
  assert.match(sidebar, /Show Significant Change Markers/)
  assert.match(sidebar, /checked=\{chartFitData\}/)
  assert.match(sidebar, /Fit Data/)
  assert.doesNotMatch(app.slice(app.indexOf('</aside>'), app.indexOf('className="workflow-actions"')),
    /className="chart-options"/)
})

test('Chart Options, Sampling and Y-axis collapse independently with existing +/- headers', () => {
  const sidebar = app.slice(app.indexOf('<aside className="workflow-sidebar">'),
    app.indexOf('</aside>', app.indexOf('<aside className="workflow-sidebar">')))
  // Steps stays expanded; CSV Export and Chart Options start collapsed.
  for (const state of ['stepsExpanded', 'streamingExpanded', 'chartOptionsExpanded']) {
    const setter = `set${state[0].toUpperCase()}${state.slice(1)}`
    const initial = state === 'stepsExpanded'
    assert.match(app, new RegExp(`const \\[${state}, ${setter}\\] = useState\\(${initial}\\)`), state)
    assert.match(sidebar, new RegExp(`aria-expanded=\\{${state}\\}`), state)
    assert.match(sidebar, new RegExp(`<span aria-hidden="true">\\{${state} \\? '−' : '\\+'\\}</span>`), state)
    assert.match(sidebar, new RegExp(`onClick=\\{\\(\\) => ${setter}\\(current => !current\\)\\}`), state)
  }
  assert.ok(sidebar.indexOf('className="step-palette"') < sidebar.indexOf('className="streaming-panel"'))
  assert.ok(sidebar.indexOf('className="streaming-panel"') < sidebar.indexOf('className="chart-options"'))
  assert.match(sidebar, /\{chartOptionsExpanded && <div className="chart-options-sections">/)

  // Sampling and Y-axis match the existing Steps category interaction but keep separate state.
  for (const state of ['chartSamplingExpanded', 'chartYAxisExpanded']) {
    const setter = `set${state[0].toUpperCase()}${state.slice(1)}`
    assert.match(app, new RegExp(`const \\[${state}, ${setter}\\] = useState\\(true\\)`), state)
    assert.match(sidebar, new RegExp(`aria-expanded=\\{${state}\\}`), state)
    assert.match(sidebar, new RegExp(`onClick=\\{\\(\\) => ${setter}\\(current => !current\\)\\}`), state)
  }
  assert.match(sidebar, /\{chartSamplingExpanded && <fieldset className="chart-sampling-fields" disabled=\{workflowBusy\}>/)
  assert.match(sidebar, /\{chartYAxisExpanded && <fieldset className="chart-y-axis-fields" disabled=\{workflowBusy\}>/)
  assert.match(sidebar, /aria-expanded=\{expandedStepCategories\[category\]\}/)
})

test('collapsing Chart Options sections hides content without changing settings', () => {
  const sidebar = app.slice(app.indexOf('<aside className="workflow-sidebar">'),
    app.indexOf('</aside>', app.indexOf('<aside className="workflow-sidebar">')))
  for (const setter of ['setStepsExpanded', 'setStreamingExpanded', 'setChartOptionsExpanded',
    'setChartSamplingExpanded', 'setChartYAxisExpanded']) {
    assert.equal((app.match(new RegExp(`const \\[\\w+, ${setter}\\]`, 'g')) ?? []).length, 1, setter)
    assert.equal((sidebar.match(new RegExp(`${setter}\\(current => !current\\)`, 'g')) ?? []).length, 1, setter)
  }
  for (const setter of ['setStreamCsv', 'setStreamPage', 'setStreamAllPages', 'setStreamOutputFolder',
    'setChartSamplingOptions', 'setChartFitData', 'setExpandedStepCategories']) {
    assert.ok(!sidebar.includes(`${setter}(current => !current)`), setter)
  }
})
