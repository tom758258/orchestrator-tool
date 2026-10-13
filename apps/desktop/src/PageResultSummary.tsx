import { useState } from 'react'
import { formatElapsedTime, formatNumber } from './outputTime'
import type { NumericDisplayFormat } from './outputTime'
import type { NumericSummary, OutputStep } from './workflow'

const columns = [
  { key: 'count', label: 'Count', value: (s: NumericSummary) => s.count, default: true },
  { key: 'min', label: 'Min', value: (s: NumericSummary) => s.min, default: true },
  { key: 'max', label: 'Max', value: (s: NumericSummary) => s.max, default: true },
  { key: 'avg', label: 'Avg', value: (s: NumericSummary) => s.avg, default: true },
  { key: 'range', label: 'Range (Max − Min)', value: (s: NumericSummary) => s.max - s.min, default: false },
  { key: 'stdDev', label: 'Std Dev (σ)', value: (s: NumericSummary) => s.std_dev, default: false },
  { key: 'twoSigma', label: '2σ', value: (s: NumericSummary) => s.std_dev === null ? null : s.std_dev * 2, default: false },
  { key: 'threeSigma', label: '3σ', value: (s: NumericSummary) => s.std_dev === null ? null : s.std_dev * 3, default: false },
] as const

export default function PageResultSummary({ summaries, outputs, numericFormat }: {
  summaries: readonly NumericSummary[]
  outputs: readonly OutputStep[]
  numericFormat: NumericDisplayFormat
}) {
  const [selected, setSelected] = useState<string[]>(() => columns.filter(column => column.default).map(column => column.key))
  const visible = columns.filter(column => selected.includes(column.key))
  return <section className="page-result-summary" aria-labelledby="page-result-summary-title">
    <div className="summary-header">
      <h4 id="page-result-summary-title">Summary</h4>
      <details className="summary-columns">
        <summary>Columns ▾</summary>
        <div>{columns.map(column => <label key={column.key}>
          <input type="checkbox" checked={selected.includes(column.key)} onChange={event =>
            setSelected(current => event.target.checked ? [...current, column.key] : current.filter(key => key !== column.key))} />
          {column.label}
        </label>)}</div>
      </details>
    </div>
    {summaries.length === 0 ? <p>No numeric outputs to summarize.</p> : (
      <div className="output-table-scroll">
        <table className="output-table" aria-label="Page Result Summary">
          <thead><tr>
            <th scope="col">Output</th>{visible.map(column => <th scope="col" key={column.key}>{column.label}</th>)}
          </tr></thead>
          <tbody>{summaries.map(summary => {
            const output = outputs.find(output => output.name === summary.name)
            const format = output?.value.source === 'elapsed-time' && output.time_format?.kind === 'elapsed-time'
              ? output.time_format.format : undefined
            return <tr key={summary.name}>
              <th scope="row">{summary.name}</th>
              {visible.map(column => {
                const value = column.value(summary)
                return <td key={column.key}>{value === null ? '—' : column.key !== 'count' && format
                  ? formatElapsedTime(value, format) : column.key === 'count' ? value : formatNumber(value, numericFormat)}</td>
              })}
            </tr>
          })}</tbody>
        </table>
      </div>
    )}
  </section>
}
