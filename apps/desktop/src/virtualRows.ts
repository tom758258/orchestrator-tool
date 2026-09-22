import type { ResultRowDto } from './workflow'

export const OUTPUT_ROW_HEIGHT = 36
export const OUTPUT_ROW_OVERSCAN = 5

// The range is [start, end); scrollTop is relative to the table body.
export function virtualRowRange({ rowCount, rowHeight, scrollTop, viewportHeight, overscan }: {
  rowCount: number
  rowHeight: number
  scrollTop: number
  viewportHeight: number
  overscan: number
}) {
  const height = Math.max(0, viewportHeight)
  const offset = Math.min(Math.max(0, scrollTop), Math.max(0, rowCount * rowHeight - height))
  const start = Math.max(0, Math.floor(offset / rowHeight) - overscan)
  const end = Math.min(rowCount, Math.ceil((offset + height) / rowHeight) + overscan)
  return { start, end, topSpacerHeight: start * rowHeight, bottomSpacerHeight: (rowCount - end) * rowHeight }
}

export function virtualOutputWindow(rows: readonly ResultRowDto[], offset: number, totalRows: number) {
  return rows.map((row, localIndex) => {
    const index = offset + localIndex
    return { row, index, iteration: totalRows - index }
  })
}

export function preserveLiveHistoryScrollTop(
  scrollTop: number, previousRowCount: number, nextRowCount: number, rowHeight: number,
) {
  if (nextRowCount <= previousRowCount || scrollTop <= 1) return scrollTop <= 1 ? 0 : scrollTop
  return scrollTop + (nextRowCount - previousRowCount) * rowHeight
}

export function rebaseNewestFirstWindow(offset: number, totalRows: number, nextTotalRows: number) {
  const added = Math.max(0, nextTotalRows - totalRows)
  return { offset: offset + added, totalRows: nextTotalRows }
}
