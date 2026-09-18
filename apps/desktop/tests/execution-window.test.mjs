import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXECUTION_WINDOW_SIZE, executionWindow } from '../src/executionWindow.ts'

test('a small execution window is newest first and preserves chronological storage', () => {
  const executions = Object.freeze([1, 2, 3])
  assert.deepEqual(executionWindow(executions, 0, EXECUTION_WINDOW_SIZE), {
    items: [3, 2, 1], total: 3, offset: 0, start: 1, end: 3,
    hasNewer: false, hasOlder: false,
  })
})

const executions = Object.freeze(Array.from({ length: 50_251 }, (_, index) => index + 1))
for (const [offset, start, end, first, last, hasNewer, hasOlder] of [
  [0, 1, 200, 50_251, 50_052, false, true],
  [200, 201, 400, 50_051, 49_852, true, true],
  [50_200, 50_201, 50_251, 51, 1, true, false],
]) {
  test(`execution window at offset ${offset} has the correct range and boundaries`, () => {
    const window = executionWindow(executions, offset, EXECUTION_WINDOW_SIZE)
    assert.deepEqual(window, {
      items: Array.from({ length: end - start + 1 }, (_, index) => first - index),
      total: 50_251, offset, start, end, hasNewer, hasOlder,
    })
    assert.equal(window.items.at(-1), last)
    assert.ok(window.items.length <= 200)
  })
}

test('empty, exact-size, and stale offsets stay within bounds', () => {
  assert.deepEqual(executionWindow([], 200, 200), {
    items: [], total: 0, offset: 0, start: 0, end: 0, hasNewer: false, hasOlder: false,
  })
  const exact = executionWindow(executions.slice(0, 200), 0, 200)
  assert.equal(exact.items.length, 200)
  assert.equal(exact.hasOlder, false)
  assert.deepEqual(executionWindow(executions, 50_400, 200), executionWindow(executions, 50_200, 200))
})

test('new executions refresh the newest window and retain newest-relative older offsets', () => {
  const growing = [1, 2, 3, 4]
  growing.push(5)
  assert.deepEqual(executionWindow(growing, 0, 2).items, [5, 4])
  assert.deepEqual(executionWindow(growing, 2, 2).items, [3, 2])
})
