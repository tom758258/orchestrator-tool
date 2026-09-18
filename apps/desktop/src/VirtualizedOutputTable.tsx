import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ResultRowDto } from './workflow'
import { OUTPUT_ROW_HEIGHT, OUTPUT_ROW_OVERSCAN, virtualRowRange, virtualOutputRows } from './virtualRows'

export default function VirtualizedOutputTable({ rows, outputs, iterationRows }: {
  rows: readonly ResultRowDto[]
  outputs: readonly { id: string; name: string }[]
  iterationRows: boolean
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLTableSectionElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

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
    rowCount: rows.length, rowHeight: OUTPUT_ROW_HEIGHT, scrollTop, viewportHeight,
    overscan: OUTPUT_ROW_OVERSCAN,
  })
  const items = virtualOutputRows(rows, range.start, range.end)
  const columnCount = outputs.length + (iterationRows ? 1 : 0)

  return <div ref={scroll} className="output-table-scroll" role="region" aria-label="Last Run outputs" tabIndex={0}
    onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
    <table className="output-table" aria-labelledby="output-data-title" aria-rowcount={rows.length + 1}
      style={{ '--output-row-height': `${OUTPUT_ROW_HEIGHT}px` } as CSSProperties}>
      <thead ref={header}>
        <tr aria-rowindex={1}>
          {iterationRows && <th scope="col">Iteration</th>}
          {outputs.map(step => <th key={step.id} scope="col">{step.name}</th>)}
        </tr>
      </thead>
      <tbody>
        {range.topSpacerHeight > 0 && <tr aria-hidden="true">
          <td className="output-table-spacer" colSpan={columnCount} style={{ height: range.topSpacerHeight }} />
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
        {range.bottomSpacerHeight > 0 && <tr aria-hidden="true">
          <td className="output-table-spacer" colSpan={columnCount} style={{ height: range.bottomSpacerHeight }} />
        </tr>}
      </tbody>
    </table>
  </div>
}
