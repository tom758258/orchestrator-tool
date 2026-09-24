type NumericBuffer = { values: Float64Array; length: number }

function appendBuffer(buffer: NumericBuffer | undefined, tail: readonly number[]): NumericBuffer {
  const length = buffer?.length ?? 0
  let values = buffer?.values ?? new Float64Array(Math.max(16, tail.length))
  if (length + tail.length > values.length) {
    const next = new Float64Array(Math.max(length + tail.length, values.length * 2))
    next.set(values.subarray(0, length))
    values = next
  }
  values.set(tail, length)
  return { values, length: length + tail.length }
}

// Presentation-only numeric storage. Capacity growth makes appends amortized O(batch size).
export function createPageChartData() {
  const series = new Map<string, NumericBuffer>()
  let iteration: NumericBuffer = { values: new Float64Array(16), length: 0 }
  let version = 0
  return {
    series,
    append(name: string, startRow: number, tail: readonly number[]) {
      const current = series.get(name)
      if ((current?.length ?? 0) !== startRow) return false
      series.set(name, appendBuffer(current, tail))
      version++
      const required = startRow + tail.length
      if (required > iteration.length) {
        iteration = appendBuffer(iteration, Array.from(
          { length: required - iteration.length }, (_, index) => iteration.length + index + 1,
        ))
      }
      return true
    },
    removeExcept(names: ReadonlySet<string>) {
      let changed = false
      for (const name of [...series.keys()]) {
        if (!names.has(name)) {
          series.delete(name)
          changed = true
        }
      }
      if (!changed) return false
      const required = Math.max(0, ...[...series.values()].map(buffer => buffer.length))
      if (iteration.length > required) {
        const values = new Float64Array(Math.max(16, required))
        values.set(iteration.values.subarray(0, required))
        iteration = { values, length: required }
      }
      version++
      return true
    },
    length(name: string) { return series.get(name)?.length ?? 0 },
    commonLength(names: readonly string[]) {
      return names.length === 0 ? 0 : Math.min(...names.map(name => series.get(name)?.length ?? 0))
    },
    get rowCount() { return Math.max(0, ...[...series.values()].map(buffer => buffer.length)) },
    get version() { return version },
    get iteration() { return iteration.values.subarray(0, iteration.length) },
    getSeries(name: string): Float64Array {
      const buffer = series.get(name)
      return buffer ? buffer.values.subarray(0, buffer.length) : new Float64Array()
    },
  }
}

export type PageChartData = ReturnType<typeof createPageChartData>

export function pruneChartData(
  chartData: Map<string, PageChartData>,
  panels: readonly { page: string; outputs: readonly string[] }[],
  preservePage?: string,
): void {
  const consumers = new Map<string, Set<string>>()
  for (const panel of panels) {
    let names = consumers.get(panel.page)
    if (!names) {
      names = new Set()
      consumers.set(panel.page, names)
    }
    for (const name of panel.outputs) names.add(name)
  }
  for (const [page, data] of [...chartData.entries()]) {
    if (page === preservePage) continue
    const names = consumers.get(page)
    if (!names || names.size === 0) {
      chartData.delete(page)
    } else {
      data.removeExcept(names)
    }
  }
}

export function chartNeedsLoad(
  data: PageChartData,
  outputs: readonly string[],
  targetRowCount: number,
): boolean {
  return outputs.some(name => data.length(name) < targetRowCount)
}

export function chartLoadGroups(
  data: PageChartData,
  outputs: readonly string[],
  targetRowCount: number,
  chunkRows: number,
): { startRow: number; names: string[]; limit: number }[] {
  const grouped = new Map<number, string[]>()
  for (const name of outputs) {
    const startRow = data.length(name)
    if (startRow >= targetRowCount) continue
    grouped.set(startRow, [...(grouped.get(startRow) ?? []), name])
  }
  return [...grouped].map(([startRow, names]) => ({
    startRow,
    names,
    limit: Math.min(chunkRows, targetRowCount - startRow),
  })).filter(group => group.limit > 0)
}

export function exactHoverIndex(x: number, rowCount: number): number | null {
  if (!Number.isFinite(x) || rowCount === 0 || x < 1 || x > rowCount) return null
  return Math.max(0, Math.min(rowCount - 1, Math.round(x) - 1))
}

export function minMaxDecimateRange(
  iteration: Float64Array, values: Float64Array, pixelWidth: number,
  range: { min: number; max: number },
): [number, number][] {
  const count = Math.min(iteration.length, values.length)
  if (count === 0 || range.max < iteration[0] || range.min > iteration[count - 1]) return []

  const lowerBound = (value: number, inclusive: boolean) => {
    let low = 0
    let high = count
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (iteration[middle] < value || (!inclusive && iteration[middle] === value)) low = middle + 1
      else high = middle
    }
    return low
  }
  const start = Math.max(0, lowerBound(range.min, true) - 1)
  const end = Math.min(count, lowerBound(range.max, false) + 1)
  return minMaxDecimate(iteration.subarray(start, end), values.subarray(start, end), pixelWidth)
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
