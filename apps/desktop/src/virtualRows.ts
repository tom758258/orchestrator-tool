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

export function virtualOutputRows(rows: readonly ResultRowDto[], start: number, end: number) {
  return Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset
    const iteration = rows.length - index
    return { row: rows[iteration - 1], index, iteration }
  })
}
