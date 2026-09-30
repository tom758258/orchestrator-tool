import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { MESSAGE_TARGET_LABELS, limitMessageText, visibleMessageWindow } from '../src/workflow.ts'
import { MESSAGE_WINDOW_SIZE } from '../src/executionWindow.ts'
import { composeMessageText } from '../src/workflow.ts'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const editor = readFileSync(new URL('../src/ShowMessageEditor.tsx', import.meta.url), 'utf8')
const storedRun = readFileSync(new URL('../src-tauri/src/stored_run.rs', import.meta.url), 'utf8')

const page = (runId, target, messages) => ({ runId, target, messages })
const counts = (...entries) => entries.map(([target, total, revision]) => ({ target, total, revision }))

test('R01 a fetched window is listed in production order, oldest first', () => {
  const active = { runId: 7, target: 'message-1',
    counts: counts(['message-1', 3, 3]) }
  const window = visibleMessageWindow(page(7, 'message-1', ['A\n', 'B\n', 'C\n']), active)
  // The backend returns production order, so the array order is the display order.
  assert.deepEqual(window.items, ['A\n', 'B\n', 'C\n'])
  assert.equal(window.items[0], 'A\n')
  assert.equal(window.total, 3)
  assert.equal(window.retained, 3)
  assert.equal(window.discarded, 0)

  // The panel label must not claim the newest-first order used by Execution Results.
  const panel = source.slice(source.indexOf('<section className="run-messages"'),
    source.indexOf('<section className="run-results"'))
  assert.match(panel, /'message' : 'messages'} · oldest first/)
  assert.doesNotMatch(panel, /latest first/)
  // Execution Results keeps its own latest-first wording.
  assert.match(source, /'execution' : 'executions'} · latest first/)
})

test('R01 a window that does not belong to the active run or tab is never shown', () => {
  const countsAll = counts(['message-1', 1, 1], ['message-2', 1, 1], ['message-3', 0, 0])
  // A window fetched for another tab.
  assert.deepEqual(
    visibleMessageWindow(page(7, 'message-1', ['stale\n']),
      { runId: 7, target: 'message-2', counts: countsAll }).items, [])
  // A window fetched for a previous run.
  assert.deepEqual(
    visibleMessageWindow(page(6, 'message-1', ['stale\n']),
      { runId: 7, target: 'message-1', counts: countsAll }).items, [])
  // No window at all, such as after Clear Last Run.
  assert.deepEqual(
    visibleMessageWindow(null, { runId: null, target: 'message-1', counts: [] }).items, [])
  // Each tab in turn shows only its own window.
  for (const target of ['message-1', 'message-2', 'message-3']) {
    const window = visibleMessageWindow(page(7, target, [`${target}\n`]),
      { runId: 7, target, counts: countsAll })
    assert.deepEqual(window.items, [`${target}\n`])
    assert.equal(window.total, target === 'message-3' ? 0 : 1)
  }
})

test('R02 switching tabs and runs keeps the retained and discarded counts honest', () => {
  const countsAll = counts(['message-1', 1500, 9], ['message-2', 4, 2], ['message-3', 0, 0])
  const first = visibleMessageWindow(page(7, 'message-1', ['m1\n']),
    { runId: 7, target: 'message-1', counts: countsAll })
  assert.equal(first.retained, 1)
  assert.equal(first.discarded, 1499, 'records beyond the retained window are reported')
  // Switching to an unfetched tab shows nothing but still reports that tab's total.
  const other = visibleMessageWindow(page(7, 'message-1', ['m1\n']),
    { runId: 7, target: 'message-2', counts: countsAll })
  assert.deepEqual(other.items, [])
  assert.equal(other.total, 4)
  // The App derives its window from this helper rather than reading a stale state.
  assert.match(source, /visibleMessageWindow\(/)
  assert.doesNotMatch(source, /messagePage\?\.messages \?\? \[\]/)
})

test('R06 only the active tab revision drives a refetch, and a collapsed panel pauses it', () => {
  // The effect depends on the active tab's own revision, not a global one.
  assert.match(source, /\}, \[displayedRun\?\.run_id, messageWindow\.revision, messageTarget, messagesExpanded\]\)/)
  assert.doesNotMatch(source, /message_revision/)
  // Collapsing skips the query; the backend still receives and counts every message.
  assert.match(source, /if \(!displayedRun \|\| !messagesExpanded\) return/)
  // Re-expanding refetches because messagesExpanded is a dependency.
  // Totals and revisions arrive with every progress batch regardless of expansion.
  assert.match(source, /const messageCounts = runMetadata\?\.messages \?\? EMPTY_MESSAGE_COUNTS/)
  assert.match(source, /invoke<MessageRowsResponse>\('get_last_run_messages', \{\s*\n\s*runId: displayedRun\.run_id, target: messageTarget, offset: 0, limit: MESSAGE_WINDOW_SIZE,/)
  assert.equal(MESSAGE_WINDOW_SIZE, 1_000)
  // Per-tab revision lives on the stored buffer, not on a single shared counter.
  assert.match(storedRun, /revision: u64,/)
  assert.match(storedRun, /self\.total \+= 1;\s*\n\s*self\.revision \+= 1;/)
  assert.doesNotMatch(storedRun, /message_revision/)
})

test('R05 the frontend limits String fields by Unicode character, not UTF-16 unit', () => {
  // maxLength would count UTF-16 code units and cut Emoji early, so it is not used.
  assert.doesNotMatch(editor, /maxLength=/)
  assert.match(editor, /limitMessageText\(event\.target\.value, MAX_MESSAGE_TEXT_CHARS\)/)
  assert.match(editor, /\{Array\.from\(field\.text\)\.length\} \/ \{MAX_MESSAGE_TEXT_CHARS\} characters/)

  assert.equal(limitMessageText('abc', 256), 'abc')
  assert.equal(Array.from('a'.repeat(256)).length, 256)
  assert.equal(limitMessageText('a'.repeat(256), 256).length, 256)
  assert.equal(limitMessageText('a'.repeat(257), 256).length, 256)
  // 256 astral characters are 512 UTF-16 units but only 256 characters, so all survive.
  const emoji = '\u{1F600}'.repeat(256)
  assert.equal(emoji.length, 512, 'fixture is 512 UTF-16 units')
  assert.equal(limitMessageText(emoji, 256), emoji, 'no early truncation for Emoji')
  assert.equal(limitMessageText('\u{1F600}'.repeat(257), 256), emoji)
  // CJK and ASCII input is unaffected.
  const cjk = '\u{7d2}'.repeat(300)
  assert.equal(limitMessageText(cjk, 256), '\u{7d2}'.repeat(256))
  // Truncation never leaves a lone surrogate.
  const cut = limitMessageText('\u{1F600}'.repeat(300), 257)
  assert.equal(Array.from(cut).length, 257)
  assert.ok(!/[\uD800-\uDFFF]/.test(cut.replace(/[\u{1F600}-\u{1F64F}]/gu, '')))
})

test('R08 the bounded message is truncated in Core and the preview matches the shape', () => {
  // The Core bound and the marker are exported once and reused by the executor.
  const workflow = readFileSync(new URL('../../../src/workflow.rs', import.meta.url), 'utf8')
  assert.match(workflow, /pub const MAX_MESSAGE_CHARS: usize = 4_096;/)
  assert.match(workflow, /pub const MESSAGE_TRUNCATION_MARKER: &str = "…\[truncated\]";/)
  // The Message Preview still ends with exactly one newline, like a real record.
  assert.equal(composeMessageText([{ kind: 'text', text: 'a', newline: false }], () => undefined), 'a\n')
  assert.match(editor, /<pre>\{composeMessageText\(step\.fields,/)
  assert.deepEqual(Object.values(MESSAGE_TARGET_LABELS), ['Message 1', 'Message 2', 'Message 3'])
})
