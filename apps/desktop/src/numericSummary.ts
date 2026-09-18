import type { ResultRowDto } from './workflow'

export type NumericSummary = {
  name: string
  count: number
  min: number
  max: number
  avg: number
}

export function summarizePageResults(rows: readonly ResultRowDto[]): NumericSummary[] {
  const summaries = new Map<string, NumericSummary>()
  for (const row of rows) {
    for (const { name, value } of row.outputs) {
      // Match Charts' numeric cell semantics without requiring every cell to be numeric.
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      const summary = summaries.get(name)
      if (!summary) {
        summaries.set(name, { name, count: 1, min: value, max: value, avg: value })
      } else {
        summary.count += 1
        summary.min = Math.min(summary.min, value)
        summary.max = Math.max(summary.max, value)
        summary.avg += (value - summary.avg) / summary.count
      }
    }
  }
  return [...summaries.values()]
}
