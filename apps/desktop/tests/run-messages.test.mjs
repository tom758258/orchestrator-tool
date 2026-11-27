import assert from 'node:assert/strict'
import { test } from 'node:test'
import { limitMessageText, visibleMessageWindow, composeMessageText } from '../src/workflow.ts'

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
  assert.equal(first.discarded, 500, 'only records evicted by the 1,000-record cap count as discarded')
  // Switching to an unfetched tab shows nothing but still reports that tab's total.
  const other = visibleMessageWindow(page(7, 'message-1', ['m1\n']),
    { runId: 7, target: 'message-2', counts: countsAll })
  assert.deepEqual(other.items, [])
  assert.equal(other.total, 4)
})

test('R02 switching a tab does not invent discarded messages', () => {
  const waiting = visibleMessageWindow(page(7, 'message-1', ['old-tab\n']),
    { runId: 7, target: 'message-2', counts: counts(['message-1', 1, 1], ['message-2', 4, 4]) })
  assert.deepEqual(waiting.items, [])
  assert.equal(waiting.total, 4)
  assert.equal(waiting.discarded, 0, 'unfetched records are not discarded records')
})

test('R05 the frontend limits String fields by Unicode character, not UTF-16 unit', () => {

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

test('R08 the message preview keeps the record terminator', () => {
  // The Message Preview still ends with exactly one newline, like a real record.
  assert.equal(composeMessageText([{ kind: 'text', text: 'a', newline: false }], () => undefined), 'a\n')
})
