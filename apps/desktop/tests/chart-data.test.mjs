import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createPageChartData, exactHoverIndex, minMaxDecimate } from '../src/chartData.ts'

const sequence = count => Float64Array.from({ length: count }, (_, index) => index + 1)

test('small and empty data remain complete without modifying raw arrays', () => {
  const x = sequence(4)
  const y = Float64Array.of(3, -4, 9, 1)
  assert.deepEqual(minMaxDecimate(x, y, 2), [[1, 3], [2, -4], [3, 9], [4, 1]])
  assert.deepEqual([...x], [1, 2, 3, 4])
  assert.deepEqual([...y], [3, -4, 9, 1])
  assert.deepEqual(minMaxDecimate(new Float64Array(), new Float64Array(), 800), [])
  assert.deepEqual(minMaxDecimate(sequence(1), Float64Array.of(7), 0), [[1, 7]])
})

test('large monotonic data retain endpoints and ordered raw points within a pixel-based bound', () => {
  const x = sequence(500_000)
  for (const width of [1, 320, 800, 1200.5]) {
    const points = minMaxDecimate(x, x, width)
    assert.ok(points.length <= Math.floor(width) * 2 + 2)
    assert.deepEqual(points[0], [1, 1])
    assert.deepEqual(points.at(-1), [500_000, 500_000])
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i][0] > points[i - 1][0])
      assert.equal(points[i][1], x[points[i][0] - 1])
    }
  }
  assert.ok(minMaxDecimate(x, x, 320).length < minMaxDecimate(x, x, 800).length)
})

test('spikes, dips and first/last values survive even with extrema in reverse order', () => {
  const x = sequence(10_003)
  const y = new Float64Array(x.length)
  y[0] = 2
  y[401] = 100
  y[402] = -100
  y[y.length - 1] = 3
  const points = minMaxDecimate(x, y, 100)
  assert.ok(points.some(([x, y]) => x === 402 && y === 100))
  assert.ok(points.some(([x, y]) => x === 403 && y === -100))
  assert.deepEqual(points[0], [1, 2])
  assert.deepEqual(points.at(-1), [10_003, 3])
  assert.ok(points.length <= 202)
  assert.ok(points.every(([value], index) => index === 0 || value > points[index - 1][0]))
  assert.equal(y[401], 100)
  assert.equal(y[402], -100)
})

test('hover rounds and clamps the full raw sequence, independent of display points', () => {
  for (const [x, expected] of [[1, 0], [250_000, 249_999], [234_520.7, 234_520], [-5, 0], [600_000, 499_999]]) {
    assert.equal(exactHoverIndex(x, 500_000), expected)
  }
  assert.equal(exactHoverIndex(9, 1), 0)
  const x = sequence(100)
  const a = Float64Array.from(x, value => value * 2)
  const b = Float64Array.from(x, value => -value)
  assert.ok(!minMaxDecimate(x, a, 1).some(([iteration]) => iteration === 50))
  assert.equal(a[exactHoverIndex(50, 100)], 100)
  assert.equal(b[exactHoverIndex(50, 100)], -50)
})

test('Page adapter appends compact tails and shares each raw series once', () => {
  const page = createPageChartData()
  assert.equal(page.version, 0)
  assert.equal(page.append('V', 0, [1, 2]), true)
  assert.equal(page.version, 1)
  assert.equal(page.rowCount, 2)
  assert.ok(page.iteration instanceof Float64Array)
  assert.deepEqual([...page.iteration], [1, 2])
  const voltage = page.getSeries('V')
  assert.ok(voltage instanceof Float64Array)
  assert.equal(page.series.size, 1)
  assert.equal(page.getSeries('V').buffer, voltage.buffer)
  assert.equal(page.append('I', 0, [2, 4]), true)
  assert.deepEqual([...page.getSeries('I')], [2, 4])
  assert.equal(page.append('V', 2, [3]), true)
  assert.deepEqual([...page.getSeries('V')], [1, 2, 3])
  assert.equal(page.append('V', 1, [99]), false)
  assert.equal(page.version, 3)
  assert.equal(page.series.size, 2)
  assert.equal(page.commonLength(['V']), 3)
  assert.equal(page.commonLength(['V', 'I']), 2)
  assert.equal(page.commonLength(['missing']), 0)
  const other = createPageChartData()
  other.append('V', 0, [99])
  assert.deepEqual([...other.getSeries('V')], [99])
  assert.deepEqual([...voltage], [1, 2])
})

test('ChartPlot refreshes raw typed-array views after live appends', () => {
  const source = readFileSync(new URL('../src/ChartPlot.tsx', import.meta.url), 'utf8')
  assert.match(source, /\[data, data\.version, panel\.outputs\]/)
})

test('ResultChart loads large raw series through bounded incremental queries', () => {
  const source = readFileSync(new URL('../src/ResultChart.tsx', import.meta.url), 'utf8')
  assert.match(source, /CHART_SERIES_CHUNK_ROWS = 25_000/)
  assert.match(source, /Math\.min\(CHART_SERIES_CHUNK_ROWS, latest - startRow\)/)
  assert.match(source, /while \(!cancelled\)/)
})


test('ChartPlot uses the common selected-series prefix for axis, decimation, and hover', () => {
  const source = readFileSync(new URL('../src/ChartPlot.tsx', import.meta.url), 'utf8')
  assert.match(source, /const rawRowCount = useMemo\(\(\) => data\.commonLength\(panel\.outputs\)/)
  assert.match(source, /data\.iteration\.subarray\(0, rawRowCount\)/)
  assert.match(source, /data\.getSeries\(name\)\.subarray\(0, rawRowCount\)/)
  assert.match(source, /exactHoverIndex\(x, rawRowCount\)/)
  assert.doesNotMatch(source, /exactHoverIndex\(x, data\.rowCount\)/)
})
