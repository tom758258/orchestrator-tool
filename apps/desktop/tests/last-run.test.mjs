import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

function asyncCallback(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, `callback boundaries exist for ${startMarker}`)
  const declaration = source.slice(start, end)
  const callback = declaration.slice(declaration.indexOf('async () =>'), declaration.lastIndexOf('}, [') + 1)
  return stripTypeScriptTypes('(' + callback + ')')
}

function updateStepsCallback() {
  const start = source.indexOf('  const updateSteps = useCallback(')
  const end = source.indexOf('\n  const updateToolInstances =', start)
  assert.ok(start >= 0 && end > start, 'updateSteps callback boundaries exist')
  const declaration = source.slice(start, end)
  const callbackStart = declaration.indexOf('    (update:')
  const callbackEnd = declaration.lastIndexOf('\n    [],')
  const callback = declaration.slice(callbackStart, callbackEnd).trimEnd().replace(/,$/, '')
  return stripTypeScriptTypes('(' + callback + ')')
}

function updateToolInstancesCallback() {
  const start = source.indexOf('  const updateToolInstances = useCallback(')
  const end = source.indexOf('\n  const addStep =', start)
  assert.ok(start >= 0 && end > start, 'updateToolInstances callback boundaries exist')
  const declaration = source.slice(start, end)
  const callback = declaration.slice(declaration.indexOf('(tool_instances:'), declaration.lastIndexOf('}, [])') + 1)
  return stripTypeScriptTypes('(' + callback + ')')
}

const draft = {
  schema_version: 1,
  name: 'Current',
  tool_instances: [],
  workflow: {
    steps: [{ type: 'wait', id: 'wait-1', duration_ms: 5 }],
  },
}

test('Workflow and Tool Setup edits preserve Last Run state', () => {
  let workflowDraft = structuredClone(draft)
  let validationStatus = 'valid'
  let validationError = 'old validation'
  let templateIoMessage = 'Template saved.'
  const previous = {
    runWorkflowSnapshot: { ...draft, name: 'Run snapshot' },
    runResult: { step_executions: [{ step_id: 'wait-1' }], result_rows: [] },
    runProgress: { step_executions: [{ step_id: 'partial' }], result_rows: [] },
    csvStreamStatus: { path: 'previous.csv', rows: 1, finished: true },
    runError: 'previous run error',
  }
  const context = {
    setWorkflowDraft(value) {
      workflowDraft = typeof value === 'function' ? value(workflowDraft) : value
    },
    setValidationStatus(value) { validationStatus = value },
    setValidationError(value) { validationError = value },
    setTemplateIoMessage(value) { templateIoMessage = value },
  }

  const updateSteps = runInNewContext(updateStepsCallback(), context)
  updateSteps(steps => steps.map(step => ({ ...step, duration_ms: 10 })))

  assert.equal(workflowDraft.workflow.steps[0].duration_ms, 10)
  assert.equal(validationStatus, 'idle')
  assert.equal(validationError, null)
  assert.equal(templateIoMessage, null)
  assert.equal(previous.runResult.step_executions[0].step_id, 'wait-1')
  assert.equal(previous.runWorkflowSnapshot.name, 'Run snapshot')
  assert.equal(previous.csvStreamStatus.path, 'previous.csv')
  assert.equal(previous.runError, 'previous run error')

  const updateToolInstances = runInNewContext(updateToolInstancesCallback(), context)
  updateToolInstances([{ id: 'powers-1', tool: 'powers', setup: {} }])
  assert.equal(workflowDraft.tool_instances[0].id, 'powers-1')
  assert.equal(previous.runProgress.step_executions[0].step_id, 'partial')
})

test('manual Current Page export uses the Last Run snapshot and Run Page', async () => {
  const runWorkflowSnapshot = {
    ...draft,
    name: 'Run snapshot',
    workflow: {
      steps: [{ type: 'output', id: 'voltage', name: 'Voltage', page: 'Results', value: { source: 'literal', value: 5 } }],
    },
  }
  const runResult = { step_executions: [], result_rows: [] }
  const calls = []
  const context = {
    runWorkflowSnapshot,
    runResult,
    hasRunOutputs: true,
    runSucceeded: true,
    hasExportableOutputRows: true,
    workflowBusy: false,
    exportAllPages: false,
    exportFormat: 'csv',
    runPage: { name: 'Results' },
    setExporting() {},
    setExportError() {},
    setExportMessage() {},
    async save() { return 'last-run.csv' },
    async open() { throw new Error('unexpected folder picker') },
    async invoke(command, args) { calls.push({ command, args }) },
  }

  const handleExport = runInNewContext(asyncCallback(
    '  const handleExport = useCallback(',
    '\n  const selectedStep =',
  ), context)
  await handleExport()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'export_workflow_pages')
  assert.deepEqual(JSON.parse(calls[0].args.templateJson), runWorkflowSnapshot)
  assert.equal(calls[0].args.page, 'Results')
  assert.equal(calls[0].args.runResult, runResult)
})

test('Open Template clears the Last Run context after a successful load', async () => {
  const loadedDraft = { ...draft, name: 'Loaded' }
  const previous = {
    workflowDraft: draft,
    runWorkflowSnapshot: { ...draft, name: 'Run snapshot' },
    runResult: { step_executions: [], result_rows: [] },
    runProgress: { step_executions: [{ step_id: 'partial' }], result_rows: [] },
    csvStreamStatus: { path: 'previous.csv' },
    runError: 'previous run error',
  }
  const state = { ...previous }
  const context = {
    async open() { return 'loaded.json' },
    async invoke(command) {
      assert.equal(command, 'load_workflow_template')
      return JSON.stringify(loadedDraft)
    },
    setTemplateIoStatus(value) { state.templateIoStatus = value },
    setTemplateIoError(value) { state.templateIoError = value },
    setTemplateIoMessage(value) { state.templateIoMessage = value },
    setWorkflowDraft(value) { state.workflowDraft = value },
    setSelectedStepId(value) { state.selectedStepId = value },
    setValidationStatus(value) { state.validationStatus = value },
    setValidationError(value) { state.validationError = value },
    setRunResult(value) { state.runResult = value },
    setRunProgress(value) { state.runProgress = value },
    setRunWorkflowSnapshot(value) { state.runWorkflowSnapshot = value },
    setCsvStreamStatus(value) { state.csvStreamStatus = value },
    setRunError(value) { state.runError = value },
  }

  const handleLoadTemplate = runInNewContext(asyncCallback(
    '  const handleLoadTemplate = useCallback(',
    '\n  const handleSaveTemplate =',
  ), context)
  await handleLoadTemplate()

  assert.equal(state.workflowDraft.name, 'Loaded')
  for (const key of ['runResult', 'runProgress', 'runWorkflowSnapshot', 'csvStreamStatus', 'runError']) {
    assert.equal(state[key], null)
  }
})
