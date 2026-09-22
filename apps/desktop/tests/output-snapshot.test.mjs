import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outputWindowCovers, outputWindowResponseIsCurrent } from '../src/virtualRows.ts'

const rows = count => Array.from({ length: count }, () => ({ page: 'Results', outputs: [] }))
const window = {
  run_id: 7,
  page: 'Results',
  revision: 10,
  total_rows: 100,
  offset: 0,
  rows: rows(15),
}

test('an unchanged revision still refetches when the viewport needs more rows at the same start', () => {
  assert.equal(outputWindowCovers(window, {
    runId: 7, page: 'Results', revision: 10, rowCount: 100, start: 0, end: 15,
  }), true)
  assert.equal(outputWindowCovers(window, {
    runId: 7, page: 'Results', revision: 10, rowCount: 100, start: 0, end: 25,
  }), false)
})

test('window identity rejects a different run, Page, revision, total, or start', () => {
  const base = { runId: 7, page: 'Results', revision: 10, rowCount: 100, start: 0, end: 15 }
  for (const changed of [
    { runId: 8 }, { page: 'Other' }, { revision: 11 }, { rowCount: 101 }, { start: 1, end: 16 },
  ]) {
    assert.equal(outputWindowCovers(window, { ...base, ...changed }), false)
  }
})

test('a stale async response cannot overwrite the newest request generation', () => {
  const request = { runId: 7, page: 'Results', revision: 10, rowCount: 100, start: 0, end: 15 }
  assert.equal(outputWindowResponseIsCurrent(window, request, 2, 2), true)
  assert.equal(outputWindowResponseIsCurrent(window, request, 1, 2), false)
  assert.equal(outputWindowResponseIsCurrent({ ...window, revision: 9 }, request, 2, 2), false)
})
