import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OUTPUT_ROW_HEIGHT, OUTPUT_ROW_OVERSCAN, virtualRowRange, virtualOutputRows } from '../src/virtualRows.ts'

test('Output ranges clamp at the top, middle, bottom, and an empty Page', () => {
  const options = { rowCount: 10_000, rowHeight: OUTPUT_ROW_HEIGHT, viewportHeight: 360, overscan: OUTPUT_ROW_OVERSCAN }
  for (const [scrollTop, start, end] of [
    [0, 0, 15],
    [5000 * OUTPUT_ROW_HEIGHT, 4995, 5015],
    [9995 * OUTPUT_ROW_HEIGHT, 9985, 10_000],
    [20_000 * OUTPUT_ROW_HEIGHT, 9985, 10_000],
  ]) {
    const range = virtualRowRange({ ...options, scrollTop })
    assert.deepEqual(range, {
      start, end, topSpacerHeight: start * OUTPUT_ROW_HEIGHT,
      bottomSpacerHeight: (options.rowCount - end) * OUTPUT_ROW_HEIGHT,
    })
    assert.ok(range.end - range.start <= 20)
    assert.ok(range.topSpacerHeight >= 0 && range.bottomSpacerHeight >= 0)
  }
  assert.deepEqual(virtualRowRange({ ...options, rowCount: 0, scrollTop: 0 }), {
    start: 0, end: 0, topSpacerHeight: 0, bottomSpacerHeight: 0,
  })
  assert.deepEqual(virtualRowRange({ ...options, rowCount: 3, scrollTop: 0 }), {
    start: 0, end: 3, topSpacerHeight: 0, bottomSpacerHeight: 0,
  })
})

test('virtual Output items retain absolute indices and newest-first Iteration without changing rows', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    page: 'Results', outputs: [{ name: 'Value', value: index + 1 }],
    for_iteration: { for_step_id: 'loop', iteration_index: index }, while_iteration: null,
  }))
  const items = virtualOutputRows(rows, 5000, 5010)
  assert.equal(items.length, 10)
  assert.equal(items[0].index, 5000)
  assert.equal(items[0].iteration, 5000)
  assert.equal(items[0].row, rows[4999])
  assert.equal(items[9].iteration, 4991)
  assert.equal(virtualOutputRows(rows, 0, 1)[0].row, rows[9999])
  assert.equal(virtualOutputRows(rows, 9999, 10_000)[0].row, rows[0])
  assert.equal(rows.length, 10_000)
  assert.equal(rows[0].outputs[0].value, 1)
  assert.equal(rows[9999].outputs[0].value, 10_000)

  rows.push({ ...rows[9999], outputs: [{ name: 'Value', value: 10_001 }] })
  const newest = virtualOutputRows(rows, 0, 1)[0]
  assert.equal(newest.row, rows[10_000])
  assert.equal(newest.iteration, 10_001)
})
