import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithOxc } from 'vite'
import { allWorkflowSteps } from '../src/workflow.ts'
import { failurePresentation } from '../src/failurePresentation.ts'
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
  assert.match(button, /\|\| chartThresholdInvalid\b/)
  assert.match(button, /\|\| livePreflight\.blocked\b/)
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
  assert.doesNotMatch(app.slice(app.indexOf('</aside>'), app.indexOf('className="run-messages"')),
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
  assert.match(sidebar, /const expanded = !locked && expandedStepCategories\[category\]/)
  assert.match(sidebar, /aria-expanded=\{expanded\}/)
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

test('Workflow controls and feedback precede the Builder, with Clear Workflow kept in Sequence', () => {
  const workflow = app.slice(app.indexOf('<div className="workflow-summary">'), app.indexOf("{activeTab === 'output' && ("))
  const builder = workflow.indexOf('<div className="workflow-builder">')
  const header = workflow.slice(0, builder)
  assert.match(header, /className="workflow-summary-header"/)
  assert.match(header, /className="workflow-details"[\s\S]*className="workflow-actions"/)
  assert.match(header, /validateDraft\(\)[\s\S]*runSelectedMode\(\)[\s\S]*\{stopControls\}/)
  for (const feedback of ['{stopFeedback}', '{runningText}', 'Valid', 'Validation failed:', 'Run failed', '<FailureDetails']) {
    assert.ok(header.includes(feedback), feedback)
  }
  const below = workflow.slice(builder)
  assert.doesNotMatch(below, /workflow-actions|\{stopControls\}|\{stopFeedback\}|Validation failed:|failure-run-title/)
  assert.equal((workflow.match(/className="workflow-actions"/g) ?? []).length, 1)
  assert.match(below, /<SequenceEditor[\s\S]*onClearWorkflow=\{\(\) => void clearWorkflow\(\)\}/)
})

// Render the actual summary JSX using the same isolated JSX approach as Properties tests.
const summaryStart = app.indexOf('<div className="workflow-summary-header">')
const summary = app.slice(summaryStart, app.indexOf('<div className="workflow-builder">', summaryStart))
const stop = app.slice(app.indexOf('  const requestStop ='), app.indexOf('  const displayedRun ='))
const failure = app.slice(app.indexOf('function FailureDetails('), app.indexOf('type WorkflowDraft ='))
const { code: summaryCode } = await transformWithOxc(`${failure}
function summaryView(params) {
  const { workflowDraft, workflowBusy, toolConfigBusy, loading, chartThresholdInvalid,
    executionMode, validationStatus, validationError, runStatus, runningText, runError,
    displayedRun, activeLoop, activeAncestors, stopRequest, stopping, setStopRequest,
    invoke, validateDraft, runSelectedMode, livePreflight, liveStartError } = params
  ${stop}
  return <>${summary}</>
}`, 'workflow-summary.tsx', { jsx: { runtime: 'classic' } })
const renderSummary = new Function('React', 'allWorkflowSteps', 'failurePresentation',
  `${summaryCode}; return summaryView`)(React, allWorkflowSteps, failurePresentation)
const summaryDefaults = {
  workflowDraft: { name: 'Untitled', workflow: { steps: [] } }, workflowBusy: false,
  toolConfigBusy: null, loading: false, chartThresholdInvalid: false, executionMode: 'simulate',
  validationStatus: 'idle', validationError: null, runStatus: 'idle', runningText: 'Running…',
  runError: null, displayedRun: null, activeLoop: null, activeAncestors: [], stopRequest: null,
  stopping: false, setStopRequest: () => {}, invoke: async () => true,
  validateDraft: () => {}, runSelectedMode: () => {},
  livePreflight: { status: 'passed', blocked: false, errors: [], reject: () => {} }, liveStartError: null,
}
function summaryElements(node) {
  if (Array.isArray(node)) return node.flatMap(summaryElements)
  return React.isValidElement(node) ? [node, ...summaryElements(node.props.children)] : []
}
function summaryView(overrides = {}) {
  const tree = renderSummary({ ...summaryDefaults, ...overrides })
  return { html: renderToStaticMarkup(tree), buttons: summaryElements(tree).filter(node => node.type === 'button') }
}

test('summary renders one ordered mode-aware Run and preserves handlers and disabled gates', () => {
  const calls = []
  for (const executionMode of ['simulate', 'live']) {
    const view = summaryView({ executionMode, validateDraft: () => calls.push('validate'), runSelectedMode: () => calls.push(executionMode) })
    assert.equal(view.buttons.length, 2)
    assert.equal(renderToStaticMarkup(view.buttons[0]).includes('Validate'), true)
    assert.match(renderToStaticMarkup(view.buttons[1]), new RegExp(`Run ${executionMode === 'live' ? 'Live' : 'Simulation'}`))
    assert.equal(view.buttons[1].props.disabled, false)
    view.buttons[0].props.onClick()
    view.buttons[1].props.onClick()
    for (const gate of ['workflowBusy', 'toolConfigBusy', 'loading', 'chartThresholdInvalid']) {
      const disabled = summaryView({ executionMode, [gate]: gate === 'toolConfigBusy' ? 'meters' : true })
      assert.equal(disabled.buttons[1].props.disabled, true, gate)
      assert.equal(disabled.buttons[0].props.disabled, gate === 'workflowBusy', gate)
    }
    for (const status of ['checking', 'failed', 'passed']) {
      // The hook owns mode-aware blocking; render each of its possible results.
      const blocked = executionMode === 'live' && status !== 'passed'
      const preflight = summaryView({ executionMode,
        livePreflight: { ...summaryDefaults.livePreflight, status, blocked,
          errors: status === 'failed' ? ['CH3 unsupported'] : [] } })
      assert.equal(preflight.buttons[1].props.disabled, blocked, `${executionMode} ${status}`)
      if (executionMode === 'live') {
        if (status === 'failed') {
          assert.match(preflight.html, /role="alert"/)
          assert.match(preflight.html, /Live Preflight failed/)
          assert.match(preflight.html, /CH3 unsupported/)
        } else assert.match(preflight.html, new RegExp(`Live Preflight: ${status === 'checking' ? 'Checking…' : 'Passed'}`))
      } else assert.doesNotMatch(preflight.html, /Live Preflight|CH3 unsupported/)
    }
  }
  assert.deepEqual(calls, ['validate', 'simulate', 'validate', 'live'])
  assert.match(summaryView({ validationStatus: 'validating', workflowBusy: true }).html, /Validating…/)
})

test('summary renders status and detailed alerts beside the controls without repeating the same run error', () => {
  assert.match(summaryView({ validationStatus: 'valid' }).html, /role="status">Valid/)
  assert.match(summaryView({ validationError: 'Invalid template' }).html, /role="alert">Validation failed: Invalid template/)
  assert.match(summaryView({ runStatus: 'running' }).html, /role="status">Running…/)
  for (const overrides of [{ runError: 'Execution failed' }, { displayedRun: { status: 'failed', error: 'Execution failed' } },
    { runError: 'Execution failed', displayedRun: { status: 'failed', error: 'Execution failed' } }]) {
    const { html } = summaryView(overrides)
    assert.equal((html.match(/failure-run-title/g) ?? []).length, 1)
    assert.match(html, /role="alert"/)
    assert.match(html, /Technical details/)
    assert.match(html, /run-result-message">Execution failed/)
  }
})

test('summary preserves loop Stop, pending disable state, rejection and retry feedback', async () => {
  const calls = []
  let request = null
  const params = { activeLoop: { id: 'inner' }, activeAncestors: [{ id: 'outer' }], runStatus: 'running',
    invoke: async (command, args) => { calls.push([command, args.loopStepId]); return true },
    setStopRequest: value => { request = typeof value === 'function' ? value(request) : value } }
  const view = summaryView(params)
  assert.equal(view.buttons.length, 4)
  await view.buttons[2].props.onClick()
  await view.buttons[3].props.onClick()
  assert.deepEqual(calls, [['request_workflow_stop', 'outer'], ['request_workflow_stop', 'inner']])
  assert.match(view.html, /Finishes the current innermost iteration/)
  const pending = summaryView({ ...params, stopping: true, stopRequest: { loopId: 'inner' }, runningText: 'Stopping…' })
  assert.ok(pending.buttons.slice(2).every(button => button.props.disabled))
  assert.match(pending.html, /Stopping…/)
  await pending.buttons[3].props.onClick()
  assert.equal(calls.length, 2, 'Stopping does not issue another request')
  await summaryView({ ...params, invoke: async () => { throw 'Transport failed' } }).buttons[3].props.onClick()
  const failed = summaryView({ ...params, stopRequest: request })
  assert.match(failed.html, /role="alert">Stop request failed: Transport failed/)
  assert.ok(failed.buttons.slice(2).every(button => !button.props.disabled))
  await summaryView({ ...params, invoke: async () => false }).buttons[3].props.onClick()
  assert.equal(request, null)
})

test('existing Validate callback still invokes validation and publishes success or failure', async () => {
  const validate = app.slice(app.indexOf('  const validateDraft ='), app.indexOf('  const handleLoadTemplate ='))
  const { code } = await transformWithOxc(`function validation(params) {
    const { workflowDraft, invoke, setValidationStatus, setValidationError, setWorkflowDraft, setStepSelection } = params
    const chartPanels = [], saveChartsWithTemplate = false
    const useCallback = fn => fn
    const templateDraftJson = draft => JSON.stringify(draft)
    const workflowOnlyDraft = draft => draft
    const reconcileSelection = (_steps, selection) => selection
    ${validate}
    return validateDraft
  }`, 'summary-validation.ts', {})
  const callback = new Function(`${code}; return validation`)()
  for (const fail of [false, true]) {
    const statuses = [], errors = [], calls = []
    let canonical = null
    await callback({ workflowDraft: summaryDefaults.workflowDraft,
      invoke: async (command, args) => {
        calls.push([command, args.templateJson])
        if (fail) throw 'Invalid template'
        return JSON.stringify(summaryDefaults.workflowDraft)
      },
      setValidationStatus: status => statuses.push(status), setValidationError: error => errors.push(error),
      setWorkflowDraft: draft => { canonical = draft }, setStepSelection: () => {},
    })()
    assert.deepEqual(calls, [['validate_workflow_draft', JSON.stringify(summaryDefaults.workflowDraft)]])
    assert.deepEqual(statuses, ['validating', fail ? 'idle' : 'valid'])
    assert.deepEqual(errors, fail ? [null, 'Invalid template'] : [null])
    assert.equal(canonical !== null, !fail)
  }
})
