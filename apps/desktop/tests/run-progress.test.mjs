import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const backend = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
const workflow = readFileSync(new URL('../src/workflow.ts', import.meta.url), 'utf8')

test('progress IPC carries run metadata and completed IDs, not raw rows or execution arrays', () => {
  const event = workflow.slice(workflow.indexOf('export type WorkflowRunEventDto'), workflow.indexOf('export function allWorkflowSteps'))
  assert.match(event, /run: RunMetadataDto/)
  assert.match(event, /completed_step_ids: string\[\]/)
  assert.doesNotMatch(event, /result_rows|step_executions/)
  const dto = backend.slice(backend.indexOf('enum WorkflowRunEventDto'), backend.indexOf('struct DesktopProgressBatcher'))
  assert.match(dto, /run: Box<RunMetadataDto>/)
  assert.match(dto, /completed_step_ids: Vec<String>/)
  assert.doesNotMatch(dto, /result_rows|step_executions/)
})

test('frontend rejects stale progress metadata before updating current run state', () => {
  const receive = app.slice(app.indexOf('const receiveRunProgress'), app.indexOf('const runLive'))
  assert.match(receive, /event\.run\.run_id !== runIdRef\.current\) return/)
  assert.match(receive, /setRunMetadata\(event\.run\)/)
  assert.doesNotMatch(receive, /result_rows|step_executions/)
})

test('both Desktop run commands use streaming Core execution and return compact metadata', () => {
  const production = backend.slice(0, backend.indexOf('#[cfg(all(test, any()))]'))
  assert.equal((production.match(/run_workflow_streaming_with_loop_stop\s*\(/g) ?? []).length, 2)
  assert.equal((production.match(/Result<RunMetadataDto, String>/g) ?? []).length, 2)
  assert.doesNotMatch(production, /workflow_run_result_dto/)
})

test('run completion in App stores metadata rather than a full WorkflowRunResult', () => {
  assert.equal((app.match(/invoke<RunMetadataDto>\('run_workflow_/g) ?? []).length, 2)
  assert.doesNotMatch(app, /WorkflowRunResultDto|setRunResult|setRunProgress/)
})
