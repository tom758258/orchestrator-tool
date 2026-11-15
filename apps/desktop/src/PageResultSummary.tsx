import { useI18n } from './i18n/I18nProvider'
import Collapsible from './Collapsible'
import { useState } from 'react'
import { formatElapsedTime, formatNumber } from './outputTime'
import type { NumericDisplayFormat } from './outputTime'
import type { NumericSummary, OutputStep } from './workflow'

export default function PageResultSummary({ summaries, outputs, numericFormat }: {
  summaries: readonly NumericSummary[]
  outputs: readonly OutputStep[]
  numericFormat: NumericDisplayFormat
}) {
  const { t } = useI18n()
const columns = [
  { key: 'count', label: t("pageResultSummary.count"), value: (s: NumericSummary) => s.count, default: true },
  { key: 'min', label: t("pageResultSummary.min"), value: (s: NumericSummary) => s.min, default: true },
  { key: 'max', label: t("pageResultSummary.max"), value: (s: NumericSummary) => s.max, default: true },
  { key: 'avg', label: t("pageResultSummary.avg"), value: (s: NumericSummary) => s.avg, default: true },
  { key: 'range', label: t("pageResultSummary.rangeMaxMin"), value: (s: NumericSummary) => s.max - s.min, default: false },
  { key: 'stdDev', label: t("pageResultSummary.stdDev"), value: (s: NumericSummary) => s.std_dev, default: false },
  { key: 'twoSigma', label: '2σ', value: (s: NumericSummary) => s.std_dev === null ? null : s.std_dev * 2, default: false },
  { key: 'threeSigma', label: '3σ', value: (s: NumericSummary) => s.std_dev === null ? null : s.std_dev * 3, default: false },
] as const

  const [selected, setSelected] = useState<string[]>(() => columns.filter(column => column.default).map(column => column.key))
  const visible = columns.filter(column => selected.includes(column.key))
  return <Collapsible className="page-result-summary" title={t("pageResultSummary.summary")} actions={
      <details className="summary-columns">
        <summary>{t("pageResultSummary.columns")}</summary>
        <div>{columns.map(column => <label key={column.key}>
          <input type="checkbox" checked={selected.includes(column.key)} onChange={event =>
            setSelected(current => event.target.checked ? [...current, column.key] : current.filter(key => key !== column.key))} />
          {column.label}
        </label>)}</div>
      </details>}>
    {summaries.length === 0 ? <p>{t("pageResultSummary.noNumericOutputsToSummarize")}</p> : (
      <div className="output-table-scroll">
        <table className="output-table" aria-label={t("pageResultSummary.pageResultSummary")}>
          <thead><tr>
            <th scope="col">{t("pageResultSummary.output")}</th>{visible.map(column => <th scope="col" key={column.key}>{column.label}</th>)}
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
  </Collapsible>
}
