import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ResultRowDto } from './workflow'
import {
  OUTPUT_ROW_HEIGHT,
  OUTPUT_ROW_OVERSCAN,
  outputWindowCovers,
  outputWindowResponseIsCurrent,
  preserveVirtualScrollTop,
  rebaseNewestFirstWindow,
  virtualOutputWindow,
  virtualRowRange,
} from './virtualRows'

type PageRowsResponse = {
  run_id: number
  page: string
  revision: number
  total_rows: number
  offset: number
  rows: ResultRowDto[]
}

export default function VirtualizedOutputTable({ runId, page, rowCount, revision, outputs, iterationRows }: {
  runId: number
  page: string
  rowCount: number
  revision: number
  outputs: readonly { id: string; name: string }[]
  iterationRows: boolean
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLTableSectionElement>(null)
  const previousRowCountRef = useRef(rowCount)
  const previousViewportHeightRef = useRef(0)
  const requestGenerationRef = useRef(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [window, setWindow] = useState<PageRowsResponse | null>(null)

  useLayoutEffect(() => {
    const container = scroll.current!
    const heading = header.current!
    const measure = () => {
      setViewportHeight(Math.max(0, container.clientHeight - heading.getBoundingClientRect().height))
      setScrollTop(container.scrollTop)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(heading)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const previousRowCount = previousRowCountRef.current
    const previousViewportHeight = previousViewportHeightRef.current
    previousRowCountRef.current = rowCount
    previousViewportHeightRef.current = viewportHeight
    const container = scroll.current
    if (!container) return
    const nextScrollTop = preserveVirtualScrollTop(
      container.scrollTop,
      previousRowCount,
      rowCount,
      OUTPUT_ROW_HEIGHT,
      previousViewportHeight,
      viewportHeight,
    )
    if (nextScrollTop !== container.scrollTop) {
      if (rowCount > previousRowCount) {
        setWindow(current => {
          if (!current || current.run_id !== runId || current.page !== page
            || current.total_rows !== previousRowCount) return current
          const rebased = rebaseNewestFirstWindow(current.offset, current.total_rows, rowCount)
          return { ...current, revision, total_rows: rebased.totalRows, offset: rebased.offset }
        })
      }
      container.scrollTop = nextScrollTop
      setScrollTop(container.scrollTop)
    }
  }, [runId, page, revision, rowCount, viewportHeight])

  const range = virtualRowRange({
    rowCount, rowHeight: OUTPUT_ROW_HEIGHT, scrollTop, viewportHeight,
    overscan: OUTPUT_ROW_OVERSCAN,
  })

  const samePageWindow = window && window.run_id === runId && window.page === page ? window : null
  const requestedWindow = {
    runId, page, revision, rowCount, start: range.start, end: range.end,
  }
  const currentWindow = outputWindowCovers(samePageWindow, requestedWindow) ? samePageWindow : null

  useEffect(() => {
    if (currentWindow) return
    const generation = ++requestGenerationRef.current
    const requested = {
      runId, page, revision, rowCount, start: range.start, end: range.end,
    }
    const requestedOffset = requested.start
    const requestedLimit = requested.end - requested.start
    let cancelled = false
    const timer = setTimeout(() => {
      void invoke<PageRowsResponse>('get_last_run_page_rows', {
        runId, page, offset: requestedOffset, limit: requestedLimit,
      }).then(response => {
        if (cancelled || !outputWindowResponseIsCurrent(
          response, requested, generation, requestGenerationRef.current,
        )) return
        setWindow(response)
      }).catch(() => {})
    }, 30)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [runId, page, revision, rowCount, range.start, range.end, currentWindow])
  // While a newer top window is loading, keep rendering the previous window
  // with its own total/range so rows and Iteration numbers never mix revisions.
  const displayRowCount = samePageWindow?.total_rows ?? rowCount
  const displayRange = samePageWindow
    ? virtualRowRange({
      rowCount: samePageWindow.total_rows, rowHeight: OUTPUT_ROW_HEIGHT, scrollTop, viewportHeight,
      overscan: OUTPUT_ROW_OVERSCAN,
    })
    : range
  const displayWindow = samePageWindow?.offset === displayRange.start ? samePageWindow : null
  const items = displayWindow
    ? virtualOutputWindow(displayWindow.rows, displayWindow.offset, displayWindow.total_rows)
    : []
  const columnCount = outputs.length + (iterationRows ? 1 : 0)
  const pendingRows = Math.max(0, displayRange.end - displayRange.start - items.length)

  return <div ref={scroll} className="output-table-scroll" role="region" aria-label="Last Run outputs" tabIndex={0}
    onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
    <table className="output-table" aria-labelledby="output-data-title" aria-rowcount={displayRowCount + 1}
      style={{ '--output-row-height': `${OUTPUT_ROW_HEIGHT}px` } as CSSProperties}>
      <thead ref={header}>
        <tr aria-rowindex={1}>
          {iterationRows && <th scope="col">Iteration</th>}
          {outputs.map(step => <th key={step.id} scope="col">{step.name}</th>)}
        </tr>
      </thead>
      <tbody>
        {displayRange.topSpacerHeight > 0 && <tr aria-hidden="true">
          <td className="output-table-spacer" colSpan={columnCount} style={{ height: displayRange.topSpacerHeight }} />
        </tr>}
        {items.map(({ row, index, iteration }) => (
          <tr key={index} aria-rowindex={index + 2}>
            {iterationRows && <td>{iteration}</td>}
            {outputs.map(step => {
              const output = row.outputs.find(output => output.name === step.name) ?? { value: undefined }
              const value = typeof output.value === 'string' ? output.value : JSON.stringify(output.value) ?? '—'
              return <td key={step.id} title={value}>{value}</td>
            })}
          </tr>
        ))}
        {pendingRows > 0 && <tr aria-hidden="true">
          <td className="output-table-spacer" colSpan={columnCount} style={{ height: pendingRows * OUTPUT_ROW_HEIGHT }} />
        </tr>}
        {displayRange.bottomSpacerHeight > 0 && <tr aria-hidden="true">
          <td className="output-table-spacer" colSpan={columnCount} style={{ height: displayRange.bottomSpacerHeight }} />
        </tr>}
      </tbody>
    </table>
  </div>
}
