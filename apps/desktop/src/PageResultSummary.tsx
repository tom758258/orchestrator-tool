import { summarizePageResults } from './numericSummary'
import type { ResultRowDto } from './workflow'

export default function PageResultSummary({ rows }: { rows: ResultRowDto[] }) {
  const summaries = summarizePageResults(rows)
  if (rows.length === 0) return null

  return <section className="page-result-summary" aria-labelledby="page-result-summary-title">
    <h4 id="page-result-summary-title">Summary</h4>
    {summaries.length === 0 ? <p>No numeric outputs to summarize.</p> : (
      <div className="output-table-scroll">
        <table className="output-table" aria-label="Page Result Summary">
          <thead><tr>
            <th scope="col">Output</th><th scope="col">Count</th>
            <th scope="col">Min</th><th scope="col">Max</th><th scope="col">Avg</th>
          </tr></thead>
          <tbody>{summaries.map(summary => <tr key={summary.name}>
            <th scope="row">{summary.name}</th><td>{summary.count}</td>
            <td>{summary.min}</td><td>{summary.max}</td><td>{summary.avg}</td>
          </tr>)}</tbody>
        </table>
      </div>
    )}
  </section>
}
