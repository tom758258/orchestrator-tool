import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('manual export sends only the run selector and export options to Rust', () => {
  const handler = source.slice(source.indexOf('const handleExport'), source.indexOf('const selectedStep'))
  assert.match(handler, /invoke\('export_last_run_pages'/)
  assert.match(handler, /runId: runMetadata\.run_id/)
  assert.match(handler, /page: exportAllPages \? null : runPage\?\.name/)
  assert.doesNotMatch(handler, /templateJson|runResult|result_rows|step_executions/)
})

test('Clear Last Run clears Rust ownership and all frontend windows', () => {
  const handler = source.slice(source.indexOf('const handleClearLastRun'), source.indexOf('const csvStreamFeedback'))
  assert.match(handler, /invoke\('clear_last_run', \{ runId: runMetadata\.run_id \}\)/)
  assert.match(handler, /setRunMetadata\(null\)/)
  assert.match(handler, /setExecutionPage\(null\)/)
  assert.match(handler, /runIdRef\.current = null/)
})

test('frontend Last Run state is metadata and one execution window only', () => {
  assert.match(source, /useState<RunMetadataDto \| null>/)
  assert.match(source, /useState<ExecutionRowsResponse \| null>/)
  assert.doesNotMatch(source, /useState<WorkflowRunResultDto|setRunResult|setRunProgress/)
})

test('Output shows Last Run Page tabs while Page editing stays in Workflow Properties', () => {
  const output = source.slice(source.indexOf('<section id="output-panel"'))
  assert.ok(output.includes('aria-label="Last Run Pages"'))
  assert.ok(output.includes('setSelectedRunPage(page.name)'))
  assert.ok(!output.includes('Rename this Page'))
  const properties = source.slice(0, source.indexOf('<section id="output-panel"'))
  assert.ok(properties.includes('Existing compatible Page'))
  assert.ok(properties.includes('selectedCompatiblePages.map'))
})
