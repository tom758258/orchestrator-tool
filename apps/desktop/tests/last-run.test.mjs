import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { failurePresentation } from '../src/failurePresentation.ts'

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

const invalidSettingsSummary = 'This operation was not valid or supported with the current settings.'

test('failure presentation matches real invalid and unsupported adapter errors', () => {
  for (const message of [
    'invalid Powers arguments: channel must be a positive integer',
    'invalid Meters arguments: unexpected argument field',
    'unsupported Powers action example',
    'unsupported Meters action example',
    'workflow execution failed: invalid Powers arguments: channel must be a positive integer',
  ]) {
    assert.equal(failurePresentation(message).summary, invalidSettingsSummary)
  }
  assert.equal(
    failurePresentation('instrument rejected command because device is busy').summary,
    'This operation failed while executing.',
  )
})

test('Assert failure presentation distinguishes a failed check from evaluation errors', () => {
  assert.equal(
    failurePresentation('Assertion failed.', { type: 'assert', message: '' }).summary,
    'This check did not pass.',
  )
  assert.equal(
    failurePresentation('Voltage must stay below limit.', {
      type: 'assert', message: 'Voltage must stay below limit.',
    }).summary,
    'This check did not pass.',
  )
  assert.equal(
    failurePresentation('unresolved variable foo', { type: 'assert', message: '' }).summary,
    'This check could not be evaluated.',
  )
  const longMessage = '😀'.repeat(513)
  const boundedMessage = Array.from(longMessage).slice(0, 512).join('')
  assert.equal(
    failurePresentation(boundedMessage, { type: 'assert', message: longMessage }).summary,
    'This check did not pass.',
  )
})

test('failed diagnostics use the presentation helper only for failed results and preserve technical details', () => {
  assert.match(source, /import \{ failurePresentation \} from '\.\/failurePresentation'/)
  assert.match(source, /const presentation = failurePresentation\(message, step\)/)
  assert.match(source, /Technical details/)
  assert.match(source, /result\.status === 'failed' && result\.message/)
  assert.match(source, /<FailureDetails message=\{result\.message\} step=\{resultStep\} \/>/)
})

test('run failures use the same explanation without replacing raw diagnostics', () => {
  assert.match(source, /runError && \([\s\S]*?<FailureDetails message=\{runError\} \/>/)
  assert.match(source, /displayedRun\?\.status === 'failed' && displayedRun\.error[\s\S]*?<FailureDetails message=\{displayedRun\.error\} \/>/)
})

test('non-run actions keep errors local instead of labeling them as Run failed', () => {
  const clearHandler = source.slice(source.indexOf('const handleClearLastRun'), source.indexOf('const csvStreamFeedback'))
  assert.match(clearHandler, /setClearLastRunError\(null\)/)
  assert.match(clearHandler, /setClearLastRunError\('Could not clear Last Run: ' \+ String\(message\)\)/)
  assert.doesNotMatch(clearHandler, /setRunError\('Could not clear Last Run:/)

  const folderHandler = source.slice(source.indexOf('async function selectOutputFolder'), source.indexOf('const handleExport'))
  assert.match(folderHandler, /setStreamOutputFolderError\(null\)/)
  assert.match(folderHandler, /setStreamOutputFolderError\('Could not select CSV output folder: ' \+ String\(message\)\)/)
  assert.doesNotMatch(folderHandler, /setRunError\('Could not select CSV output folder:/)

  const streamingPanel = source.slice(source.indexOf('<section className="streaming-panel"'), source.indexOf('<section className="chart-sampling-options"'))
  assert.match(streamingPanel, /streamOutputFolderError &&/)
  const outputPanel = source.slice(source.indexOf('<section id="output-panel"'))
  assert.match(outputPanel, /clearLastRunError &&/)
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
