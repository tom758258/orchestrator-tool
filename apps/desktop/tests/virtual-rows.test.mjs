import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OUTPUT_ROW_HEIGHT, OUTPUT_ROW_OVERSCAN, virtualRowRange, virtualOutputWindow } from '../src/virtualRows.ts'

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

test('server-side Output windows retain absolute indices and newest-first Iteration', () => {
  const newest = [
    { page: 'Results', outputs: [{ name: 'Value', value: 10 }] },
    { page: 'Results', outputs: [{ name: 'Value', value: 9 }] },
    { page: 'Results', outputs: [{ name: 'Value', value: 8 }] },
  ]
  const top = virtualOutputWindow(newest, 0, 10)
  assert.deepEqual(top.map(item => [item.index, item.iteration, item.row.outputs[0].value]), [
    [0, 10, 10], [1, 9, 9], [2, 8, 8],
  ])
  const middle = virtualOutputWindow([
    { page: 'Results', outputs: [{ name: 'Value', value: 5 }] },
    { page: 'Results', outputs: [{ name: 'Value', value: 4 }] },
  ], 5, 10)
  assert.deepEqual(middle.map(item => [item.index, item.iteration]), [[5, 5], [6, 4]])
})
