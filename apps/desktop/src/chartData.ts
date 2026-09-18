import type { ResultRowDto } from './workflow'

export function numericOutputNames(rows: readonly ResultRowDto[], names: readonly string[]): string[] {
  return rows.length === 0 ? [] : names.filter(name => rows.every(row => {
    const value = row.outputs.find(output => output.name === name)?.value
    return typeof value === 'number' && Number.isFinite(value)
  }))
}

// Presentation-only, owned by one Page in one Last Run. ResultRows remain authoritative.
export function createPageChartData(rows: readonly ResultRowDto[]) {
  const iteration = Float64Array.from({ length: rows.length }, (_, index) => index + 1)
  const series = new Map<string, Float64Array>()
  return {
    rowCount: rows.length,
    iteration,
    series,
    getSeries(name: string): Float64Array {
      let values = series.get(name)
      if (!values) {
        values = Float64Array.from(rows, row => row.outputs.find(output => output.name === name)!.value as number)
        series.set(name, values)
      }
      return values
    },
  }
}

export type PageChartData = ReturnType<typeof createPageChartData>

export function exactHoverIndex(x: number, rowCount: number): number {
  return Math.max(0, Math.min(rowCount - 1, Math.round(x) - 1))
}

export function minMaxDecimate(
  iteration: Float64Array, values: Float64Array, pixelWidth: number,
): [number, number][] {
  const count = values.length
  const buckets = Math.max(1, Math.floor(pixelWidth))
  const points: [number, number][] = []
  const append = (index: number) => points.push([iteration[index], values[index]])
  if (count <= buckets * 2) {
    for (let index = 0; index < count; index++) append(index)
    return points
  }
  append(0)
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor(bucket * count / buckets)
    const end = Math.floor((bucket + 1) * count / buckets)
    let min = start
    let max = start
    for (let index = start + 1; index < end; index++) {
      if (values[index] < values[min]) min = index
      if (values[index] > values[max]) max = index
    }
    for (const index of min === max ? [min] : [Math.min(min, max), Math.max(min, max)]) {
      if (points.at(-1)![0] !== iteration[index]) append(index)
    }
  }
  if (points.at(-1)![0] !== iteration[count - 1]) append(count - 1)
  return points
}
