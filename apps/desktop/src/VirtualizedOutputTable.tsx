import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ResultRowDto } from './workflow'
import { OUTPUT_ROW_HEIGHT, OUTPUT_ROW_OVERSCAN, virtualRowRange, virtualOutputWindow } from './virtualRows'

type PageRowsResponse = { run_id: number; page: string; revision: number; total_rows: number; offset: number; rows: ResultRowDto[] }

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
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [window, setWindow] = useState<PageRowsResponse | null>(null)
  const desiredRef = useRef({ runId, page, start: 0, end: 0 })
  const activeQueryRef = useRef<{ key: string; settled: boolean } | null>(null)

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

  const range = virtualRowRange({
    rowCount, rowHeight: OUTPUT_ROW_HEIGHT, scrollTop, viewportHeight,
    overscan: OUTPUT_ROW_OVERSCAN,
  })
  desiredRef.current = { runId, page, start: range.start, end: range.end }
  useEffect(() => {
    const key = `${runId}|${page}|${range.start}|${range.end}`
    if (activeQueryRef.current && activeQueryRef.current.key === key && !activeQueryRef.current.settled) {
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      const query = { key, settled: false }
      activeQueryRef.current = query
      void invoke<PageRowsResponse>('get_last_run_page_rows', {
        runId, page, offset: range.start, limit: range.end - range.start,
      }).then(response => {
        query.settled = true
        if (cancelled) return
        const desired = desiredRef.current
        if (response.run_id !== desired.runId || response.page !== desired.page) return
        if (response.offset !== desired.start) return
        setWindow(current => {
          if (current && current.run_id === response.run_id && current.page === response.page
            && response.revision < current.revision) {
            return current
          }
          return response
        })
      }).catch(() => {
        query.settled = true
      })
    }, 30)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [runId, page, revision, range.start, range.end])
  // The displayed window is a coherent snapshot: geometry, Iteration numbers,
  // and rows all derive from window.total_rows, never from the newer rowCount prop.
  const displayRowCount = window && window.run_id === runId && window.page === page
    ? window.total_rows : rowCount
  const displayRange = window && window.run_id === runId && window.page === page
    ? virtualRowRange({
      rowCount: window.total_rows, rowHeight: OUTPUT_ROW_HEIGHT, scrollTop, viewportHeight,
      overscan: OUTPUT_ROW_OVERSCAN,
    })
    : range
  const items = window && window.run_id === runId && window.page === page && window.offset === displayRange.start
    ? virtualOutputWindow(window.rows, window.offset, window.total_rows) : []
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
