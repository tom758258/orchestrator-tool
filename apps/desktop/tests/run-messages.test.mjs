import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { MESSAGE_TARGET_LABELS } from '../src/workflow.ts'
import { MESSAGE_WINDOW_SIZE } from '../src/executionWindow.ts'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const results = source.slice(source.indexOf('<section className="run-results"'),
  source.indexOf('<section id="output-panel"'))
const messages = source.slice(source.indexOf('<section className="run-messages"'),
  source.indexOf('<section className="run-results"'))

test('Messages sits between the run controls and the Last Run Execution Results', () => {
  assert.match(messages, /<section className="run-messages" aria-labelledby="run-messages-title">/)
  // The run feedback stays above the Messages panel and the run results stay below it.
  assert.ok(source.indexOf("Run failed: {displayedRun.error}") < source.indexOf('<section className="run-messages"'))
  assert.ok(source.indexOf('<section className="run-messages"') < source.indexOf('<section className="run-results"'))
})

test('Messages and Execution Results collapse independently and default to expanded', () => {
  assert.match(source, /const \[executionsExpanded, setExecutionsExpanded\] = useState\(true\)/)
  assert.match(source, /const \[messagesExpanded, setMessagesExpanded\] = useState\(true\)/)
  for (const [section, state, title] of [
    [messages, 'messagesExpanded', 'run-messages-title'],
    [results, 'executionsExpanded', 'run-results-title'],
  ]) {
    assert.match(section, new RegExp(`<h3 id="${title}">\\s*\\n\\s*<button type="button" className="collapsible-header"\\s*\\n\\s*aria-expanded=\\{${state}\\}`))
    assert.match(section, new RegExp(`aria-hidden="true">\\{${state} \\? '−' : '\\+'\\}`))
  }
})

test('a collapsed Execution Results keeps its title, mode badge and count summary', () => {
  // The summary paragraph stays outside the collapsible body.
  assert.ok(results.indexOf('run-result-count') < results.indexOf('{executionsExpanded &&'))
  assert.ok(results.indexOf('{executionsExpanded &&') < results.indexOf('run-result-list'))
  assert.match(results, /Last Run Execution Results \{lastRunExecutionMode && <span className=\{`execution-mode-badge/)
  assert.match(results, /\{executions\.total\.toLocaleString\('en-US'\)\} \{executions\.total === 1 \? 'execution' : 'executions'\} · latest first/)
  // The list and its Newer / Older paging live inside the collapsible body only.
  for (const hidden of ['run-result-list', '>Newer<', '>Older<', 'Showing {executions.start']) {
    assert.ok(results.indexOf(hidden) > results.indexOf('{executionsExpanded &&'), hidden)
  }
  // Collapsing is presentation only: it never touches stored executions.
  assert.doesNotMatch(results.slice(0, results.indexOf('{executionsExpanded &&')),
    /setExecutionPage|null\)/)
})

test('Messages renders three independent tabs with a bounded scrolling list', () => {
  assert.deepEqual(Object.values(MESSAGE_TARGET_LABELS), ['Message 1', 'Message 2', 'Message 3'])
  assert.match(messages, /<div className="last-run-page-tabs" role="tablist" aria-label="Messages">/)
  assert.match(messages, /MESSAGE_TARGETS\.map\(\(target, index\) => \(\s*<button key=\{target\} type="button" role="tab"/)
  assert.match(messages, /aria-controls="run-messages-body"/)
  assert.match(messages, /aria-selected=\{target === messageTarget\}/)
  assert.match(messages, /onClick=\{\(\) => setMessageTarget\(target\)\}/)
  assert.match(messages, /\{messages\.items\.length === 0\s*\n\s*\? <p className="step-properties-empty">No messages were produced by this run\.<\/p>/)
  // Switching tabs only changes the pull target, so no message body is discarded.
  assert.match(source, /const \[messagePage, setMessagePage\] = useState<MessageRowsResponse \| null>\(null\)/)
  assert.match(source, /const \[messageTarget, setMessageTarget\] = useState<MessageTargetWire>\('message-1'\)/)
  assert.doesNotMatch(messages, /setMessagePage\(null\)/)
})

test('messages are pulled per tab with a bounded window and a cumulative total', () => {
  assert.equal(MESSAGE_WINDOW_SIZE, 1_000)
  assert.match(source, /invoke<MessageRowsResponse>\('get_last_run_messages', \{\s*\n\s*runId: displayedRun\.run_id, target: messageTarget, offset: 0, limit: MESSAGE_WINDOW_SIZE,/)
  // Only the active tab and the revision are watched, never the full history.
  assert.match(source, /\}, \[displayedRun\?\.run_id, displayedRun\?\.message_revision, messageTarget\]\)/)
  assert.match(source, /const messageTotal = runMetadata\?\.messages\.find\(item => item\.target === messageTarget\)\?\.total \?\? 0/)
  assert.match(source, /discarded: Math\.max\(0, messageTotal - \(messagePage\?\.messages\.length \?\? 0\)\)/)
  // Clearing the run drops the previous tab window.
  assert.match(source, /if \(!displayedRun\) \{ setMessagePage\(null\); return \}/)
})

test('a cleared Last Run drops messages and Progress batches never carry message bodies', () => {
  assert.match(source, /messages\.items\.map\(\(text, index\) => \(\s*<li className="run-message"/)
  // The ProgressBatch only carries counts plus a monotonic revision.
  const backend = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
  const dto = backend.slice(backend.indexOf('enum WorkflowRunEventDto'),
    backend.indexOf('struct DesktopProgressBatcher'))
  assert.match(dto, /run: Box<RunMetadataDto>/)
  assert.doesNotMatch(dto, /messages: Vec<String>/)
  const stored = readFileSync(new URL('../src-tauri/src/stored_run.rs', import.meta.url), 'utf8')
  assert.match(stored, /pub message_revision: u64,\s*\n\s*pub messages: Vec<MessageCountDto>,/)
})
