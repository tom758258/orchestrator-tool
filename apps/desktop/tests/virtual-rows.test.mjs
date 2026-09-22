import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  OUTPUT_ROW_HEIGHT,
  OUTPUT_ROW_OVERSCAN,
  OUTPUT_SCROLL_HEIGHT_LIMIT,
  logicalScrollTopForPhysical,
  physicalScrollHeight,
  physicalScrollTopForLogical,
  preserveLiveHistoryScrollTop,
  preserveVirtualScrollTop,
  rebaseNewestFirstWindow,
  virtualRowRange,
  virtualOutputWindow,
} from '../src/virtualRows.ts'

test('Output ranges keep the existing exact geometry while physical height is below the cap', () => {
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
  }
  assert.deepEqual(virtualRowRange({ ...options, rowCount: 0, scrollTop: 0 }), {
    start: 0, end: 0, topSpacerHeight: 0, bottomSpacerHeight: 0,
  })
  assert.deepEqual(virtualRowRange({ ...options, rowCount: 3, scrollTop: 0 }), {
    start: 0, end: 3, topSpacerHeight: 0, bottomSpacerHeight: 0,
  })
})

test('million-row Output virtualization keeps the DOM layout below the physical height cap', () => {
  const rowCount = 1_000_000
  const viewportHeight = 360
  assert.equal(physicalScrollHeight(rowCount, OUTPUT_ROW_HEIGHT), OUTPUT_SCROLL_HEIGHT_LIMIT)
  for (const scrollTop of [0, OUTPUT_SCROLL_HEIGHT_LIMIT / 2, Number.MAX_SAFE_INTEGER]) {
    const range = virtualRowRange({
      rowCount, rowHeight: OUTPUT_ROW_HEIGHT, viewportHeight,
      overscan: OUTPUT_ROW_OVERSCAN, scrollTop,
    })
    const renderedHeight = (range.end - range.start) * OUTPUT_ROW_HEIGHT
    assert.equal(
      range.topSpacerHeight + renderedHeight + range.bottomSpacerHeight,
      OUTPUT_SCROLL_HEIGHT_LIMIT,
    )
    assert.ok(range.topSpacerHeight >= 0)
    assert.ok(range.bottomSpacerHeight >= 0)
  }
  const bottom = virtualRowRange({
    rowCount, rowHeight: OUTPUT_ROW_HEIGHT, viewportHeight,
    overscan: OUTPUT_ROW_OVERSCAN, scrollTop: Number.MAX_SAFE_INTEGER,
  })
  assert.equal(bottom.end, rowCount)
  assert.equal(bottom.bottomSpacerHeight, 0)
})

test('compressed physical and logical scroll positions round-trip and preserve a live history anchor', () => {
  const viewportHeight = 360
  const previousRows = 999_900
  const nextRows = 1_000_000
  const logicalTop = 500_000 * OUTPUT_ROW_HEIGHT + 7
  const physicalTop = physicalScrollTopForLogical(
    logicalTop, previousRows, OUTPUT_ROW_HEIGHT, viewportHeight,
  )
  assert.ok(Math.abs(logicalScrollTopForPhysical(
    physicalTop, previousRows, OUTPUT_ROW_HEIGHT, viewportHeight,
  ) - logicalTop) < 1e-6)

  const rebasedPhysical = preserveLiveHistoryScrollTop(
    physicalTop, previousRows, nextRows, OUTPUT_ROW_HEIGHT, viewportHeight,
  )
  const rebasedLogical = logicalScrollTopForPhysical(
    rebasedPhysical, nextRows, OUTPUT_ROW_HEIGHT, viewportHeight,
  )
  assert.ok(Math.abs(
    rebasedLogical - (logicalTop + (nextRows - previousRows) * OUTPUT_ROW_HEIGHT),
  ) < 1e-6)
  assert.equal(preserveLiveHistoryScrollTop(
    0, previousRows, nextRows, OUTPUT_ROW_HEIGHT, viewportHeight,
  ), 0)

  const resized = preserveVirtualScrollTop(
    physicalTop, previousRows, previousRows, OUTPUT_ROW_HEIGHT, viewportHeight, 720,
  )
  assert.ok(Math.abs(logicalScrollTopForPhysical(
    resized, previousRows, OUTPUT_ROW_HEIGHT, 720,
  ) - logicalTop) < 1e-6)
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

test('newest-first windows rebase by exactly the appended row count', () => {
  assert.deepEqual(rebaseNewestFirstWindow(50, 100, 105), { offset: 55, totalRows: 105 })
  assert.deepEqual(rebaseNewestFirstWindow(0, 100, 100), { offset: 0, totalRows: 100 })
})
