import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const workflowTypes = readFileSync(new URL('../src/workflow.ts', import.meta.url), 'utf8')
const storedRun = readFileSync(new URL('../src-tauri/src/stored_run.rs', import.meta.url), 'utf8')

test('manual export sends only the run selector and export options to Rust', () => {
  const handler = source.slice(source.indexOf('const handleExport'), source.indexOf('const selectedStep'))
  assert.match(handler, /invoke\('export_last_run_pages'/)
  assert.match(handler, /runId: runMetadata\.run_id/)
  assert.match(handler, /page: exportAllPages \? null : runPage\?\.name/)
  assert.doesNotMatch(handler, /templateJson|runResult|result_rows|step_executions/)
})

test('Clear Last Run clears Rust ownership before dropping frontend state', () => {
  const handler = source.slice(source.indexOf('const handleClearLastRun'), source.indexOf('const csvStreamFeedback'))
  assert.match(handler, /const runId = runMetadata\?\.run_id \?\? runIdRef\.current/)
  assert.match(handler, /if \(runId !== null\) await invoke\('clear_last_run', \{ runId \}\)/)
  assert.ok(handler.indexOf("invoke('clear_last_run'") < handler.indexOf('setRunMetadata(null)'))
  assert.match(handler, /setRunMetadata\(null\)/)
  assert.match(handler, /setExecutionPage\(null\)/)
  assert.match(handler, /setChartPanels\(\[\]\)/)
  assert.match(handler, /runIdRef\.current = null/)
  assert.match(handler, /Could not clear Last Run/)
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

test('failed diagnostics add a user explanation and preserve technical details', () => {
  assert.match(source, /function failurePresentation\(message: string, stepType\?: WorkflowStep\['type'\]\)/)
  assert.match(source, /stepType === 'assert'/)
  assert.match(source, /normalized\.includes\('timed out'\) \|\| normalized\.includes\('timeout'\)/)
  assert.match(source, /This operation failed while executing\./)
  assert.match(source, /normalized\.includes\('invalid arguments'\)[\s\S]*?\|\| normalized\.includes\('unsupported action'\)/)
  assert.match(source, /This operation was not valid or supported with the current settings\./)
  assert.doesNotMatch(source, /The external tool rejected this operation\./)
  assert.match(source, /Technical details/)
  assert.match(source, /result\.status === 'failed' && result\.message/)
  assert.match(source, /<FailureDetails message=\{result\.message\} stepType=\{resultStep\?\.type\} \/>/)
})

test('run failures use the same explanation without replacing raw diagnostics', () => {
  assert.match(source, /runError && \([\s\S]*?<FailureDetails message=\{runError\} \/>/)
  assert.match(source, /displayedRun\?\.status === 'failed' && displayedRun\.error[\s\S]*?<FailureDetails message=\{displayedRun\.error\} \/>/)
})

test('friendly failure text does not add per-execution DTO fields', () => {
  const stepExecution = workflowTypes.slice(
    workflowTypes.indexOf('export type StepExecutionDto'),
    workflowTypes.indexOf('export type ResultRowDto'),
  )
  const compactExecution = storedRun.slice(
    storedRun.indexOf('pub struct CompactExecutionDto'),
    storedRun.indexOf('pub struct StepSummaryDto'),
  )
  assert.doesNotMatch(stepExecution, /user_message|failure_summary|failure_guidance/)
  assert.doesNotMatch(compactExecution, /user_message|failure_summary|failure_guidance/)
})

test('bounded execution previews distinguish omitted data from a real null', () => {
  assert.match(source, /result\.output_omitted && result\.output === null/)
  assert.match(source, /Preview omitted/)
})


test('failed or terminal incomplete runs are labeled and exported as Partial Results', () => {
  assert.match(source, /runMetadata\?\.completed_successfully === true/)
  assert.match(source, /runMetadata\.status !== 'running' && \(runMetadata\.status === 'failed' \|\| !runCompletedSuccessfully\)/)
  assert.match(source, /Committed rows are partial results and can be exported\./)
  assert.match(source, /No committed output rows are available for export\./)
  assert.match(source, /partialRun \? 'Partial results exported successfully\.' : 'Pages exported successfully\.'/)
  assert.match(source, /partialRun \? 'Partial ' : ''/)
  assert.doesNotMatch(source, /cannot be exported\./)
})
