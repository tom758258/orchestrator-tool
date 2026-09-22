import type { ResultRowDto } from './workflow'

export const OUTPUT_ROW_HEIGHT = 36
export const OUTPUT_ROW_OVERSCAN = 5
export const OUTPUT_SCROLL_HEIGHT_LIMIT = 16_000_000

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function scrollMetrics(rowCount: number, rowHeight: number, viewportHeight: number) {
  const logicalHeight = Math.max(0, rowCount * rowHeight)
  const physicalHeight = Math.min(logicalHeight, OUTPUT_SCROLL_HEIGHT_LIMIT)
  const viewport = Math.max(0, viewportHeight)
  return {
    logicalHeight,
    physicalHeight,
    logicalMaxScroll: Math.max(0, logicalHeight - viewport),
    physicalMaxScroll: Math.max(0, physicalHeight - viewport),
  }
}

export function physicalScrollHeight(rowCount: number, rowHeight: number): number {
  return Math.min(Math.max(0, rowCount * rowHeight), OUTPUT_SCROLL_HEIGHT_LIMIT)
}

export function logicalScrollTopForPhysical(
  scrollTop: number, rowCount: number, rowHeight: number, viewportHeight: number,
): number {
  const metrics = scrollMetrics(rowCount, rowHeight, viewportHeight)
  const physical = clamp(scrollTop, 0, metrics.physicalMaxScroll)
  if (metrics.logicalMaxScroll === 0 || metrics.physicalMaxScroll === 0) return 0
  if (metrics.logicalHeight <= metrics.physicalHeight) return Math.min(physical, metrics.logicalMaxScroll)
  return physical * metrics.logicalMaxScroll / metrics.physicalMaxScroll
}

export function physicalScrollTopForLogical(
  logicalScrollTop: number, rowCount: number, rowHeight: number, viewportHeight: number,
): number {
  const metrics = scrollMetrics(rowCount, rowHeight, viewportHeight)
  const logical = clamp(logicalScrollTop, 0, metrics.logicalMaxScroll)
  if (metrics.logicalMaxScroll === 0 || metrics.physicalMaxScroll === 0) return 0
  if (metrics.logicalHeight <= metrics.physicalHeight) return Math.min(logical, metrics.physicalMaxScroll)
  return logical * metrics.physicalMaxScroll / metrics.logicalMaxScroll
}

// The range is [start, end). scrollTop is the bounded physical scrollbar position;
// start/end always remain authoritative logical row indices.
export function virtualRowRange({ rowCount, rowHeight, scrollTop, viewportHeight, overscan }: {
  rowCount: number
  rowHeight: number
  scrollTop: number
  viewportHeight: number
  overscan: number
}) {
  const height = Math.max(0, viewportHeight)
  const metrics = scrollMetrics(rowCount, rowHeight, height)
  const physicalTop = clamp(scrollTop, 0, metrics.physicalMaxScroll)
  const logicalTop = logicalScrollTopForPhysical(physicalTop, rowCount, rowHeight, height)
  const start = Math.max(0, Math.floor(logicalTop / rowHeight) - overscan)
  const end = Math.min(rowCount, Math.ceil((logicalTop + height) / rowHeight) + overscan)
  const renderedHeight = Math.max(0, end - start) * rowHeight
  const logicalOffsetWithinWindow = logicalTop - start * rowHeight
  const maximumTopSpacer = Math.max(0, metrics.physicalHeight - renderedHeight)
  const topSpacerHeight = clamp(physicalTop - logicalOffsetWithinWindow, 0, maximumTopSpacer)
  const bottomSpacerHeight = Math.max(0, metrics.physicalHeight - topSpacerHeight - renderedHeight)
  return { start, end, topSpacerHeight, bottomSpacerHeight }
}

type OutputWindowLike = {
  run_id: number
  page: string
  revision: number
  total_rows: number
  offset: number
  rows: readonly unknown[]
}

export type OutputWindowRequest = {
  runId: number
  page: string
  revision: number
  rowCount: number
  start: number
  end: number
}

export function outputWindowCovers(
  window: OutputWindowLike | null | undefined,
  request: OutputWindowRequest,
): boolean {
  if (!window) return false
  return window.run_id === request.runId
    && window.page === request.page
    && window.revision === request.revision
    && window.total_rows === request.rowCount
    && window.offset === request.start
    && window.rows.length >= request.end - request.start
}

export function outputWindowResponseIsCurrent(
  response: OutputWindowLike,
  request: OutputWindowRequest,
  generation: number,
  currentGeneration: number,
): boolean {
  return generation === currentGeneration && outputWindowCovers(response, request)
}

export function virtualOutputWindow(rows: readonly ResultRowDto[], offset: number, totalRows: number) {
  return rows.map((row, localIndex) => {
    const index = offset + localIndex
    return { row, index, iteration: totalRows - index }
  })
}

export function preserveLiveHistoryScrollTop(
  scrollTop: number,
  previousRowCount: number,
  nextRowCount: number,
  rowHeight: number,
  viewportHeight = 0,
) {
  if (nextRowCount <= previousRowCount || scrollTop <= 1) return scrollTop <= 1 ? 0 : scrollTop
  const logicalTop = logicalScrollTopForPhysical(
    scrollTop, previousRowCount, rowHeight, viewportHeight,
  )
  return physicalScrollTopForLogical(
    logicalTop + (nextRowCount - previousRowCount) * rowHeight,
    nextRowCount,
    rowHeight,
    viewportHeight,
  )
}

export function rebaseNewestFirstWindow(offset: number, totalRows: number, nextTotalRows: number) {
  const added = Math.max(0, nextTotalRows - totalRows)
  return { offset: offset + added, totalRows: nextTotalRows }
}
