import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeOutputValue, DEFAULT_NUMERIC_DISPLAY_FORMAT, formatNumber, formatElapsedTime, formatOutputValue, formatTimestamp, formatTimestampMillis } from '../src/outputTime.ts'
import { copySteps, pasteSteps, singleSelection } from '../src/stepEditing.ts'
import { addChartPanel, chartRequiredOutputs, reconcileRunChartPanels } from '../src/chartPanels.ts'
import { createPageChartData, prepareChartSeries } from '../src/chartData.ts'
import { chartPresentationOptions, formatScatterX } from '../src/chartOptions.ts'

const step = (source, time_format) => ({ type: 'output', id: 'out', name: 'Time', page: 'Results', value: { source }, time_format })
const formats = ['seconds', 'minutes-seconds', 'hours-minutes-seconds', 'days-decimal']
const combinations = [[true, true], [true, false], [false, true], [false, false]]
const timestamp = '2026-10-12T23:24:10.123+08:00'
const displays = [timestamp, '2026-10-12T23:24:10.123', '23:24:10.123+08:00', '23:24:10.123']
const colors = { ink: '#000', axis: '#000', grid: '#ccc' }

test('numeric display defaults to Auto and formats floats without changing values', () => {
  assert.equal(DEFAULT_NUMERIC_DISPLAY_FORMAT.mode, 'auto')
  const output = step('literal')
  const values = Object.freeze([10.600000000000001, 16.000000000000014, -10.900000000000002,
    0, 1.234567890123456e100, 1.234567890123456e-100, Number.MAX_VALUE, -Number.MAX_VALUE])
  const expected = ['10.6', '16', '-10.9', '0', '1.23456789012346e+100', '1.23456789012346e-100',
    '1.7976931348623157e+308', '-1.7976931348623157e+308']
  const before = structuredClone(values)
  values.forEach((value, index) => {
    assert.equal(formatOutputValue(output, value), expected[index])
    assert.equal(formatOutputValue(output, value, { mode: 'raw', decimalPlaces: 2 }), String(value))
  })
  assert.equal(formatOutputValue(output, values[0], { mode: 'fixed', decimalPlaces: 2 }), '10.60')
  assert.deepEqual(values, before)
})

test('Fixed supports every decimal place from 0 to 12 and bounds invalid precision', () => {
  for (let decimalPlaces = 0; decimalPlaces <= 12; decimalPlaces++) {
    assert.equal(formatNumber(10.6, { mode: 'fixed', decimalPlaces }), (10.6).toFixed(decimalPlaces))
    assert.equal(formatNumber(-10.6, { mode: 'fixed', decimalPlaces }), (-10.6).toFixed(decimalPlaces))
  }
  assert.equal(formatNumber(10.6, { mode: 'fixed', decimalPlaces: -1 }), '11')
  assert.equal(formatNumber(10.6, { mode: 'fixed', decimalPlaces: 13 }), '10.600000000000')
})

test('numeric settings preserve time formats and nonnumeric Output values', () => {
  for (const mode of ['auto', 'fixed', 'raw']) {
    const numericFormat = { mode, decimalPlaces: 2 }
    formats.forEach(format => {
      const output = step('elapsed-time', { kind: 'elapsed-time', format })
      assert.equal(formatOutputValue(output, 90061.123, numericFormat), formatElapsedTime(90061.123, format))
    })
    combinations.forEach(([include_date, include_utc_offset], index) => {
      const output = step('timestamp', { kind: 'timestamp', include_date, include_utc_offset })
      assert.equal(formatOutputValue(output, timestamp, numericFormat), displays[index])
    })
    for (const value of ['10.600000000000001', true, false, null, { value: 10.600000000000001 },
      [10.600000000000001], undefined]) {
      assert.equal(formatOutputValue(step('literal'), value, numericFormat),
        typeof value === 'string' ? value : JSON.stringify(value) ?? '—')
    }
  }
})

test('elapsed Output display uses accumulated units and millisecond precision', () => {
  const expected = ['90061.123', '1501:01.123', '25:01:01.123', '1.042374109 d']
  formats.forEach((format, index) => {
    const output = step('elapsed-time', { kind: 'elapsed-time', format })
    const before = structuredClone(output)
    assert.equal(formatOutputValue(output, 90061.123), expected[index])
    assert.deepEqual(output, before)
  })
  for (const [seconds, minutes, hours] of [
    [0, '00:00.000', '00:00:00.000'],
    [59.999, '00:59.999', '00:00:59.999'],
    [60, '01:00.000', '00:01:00.000'],
    [3600, '60:00.000', '01:00:00.000'],
    [86400, '1440:00.000', '24:00:00.000'],
    [86400.001, '1440:00.001', '24:00:00.001'],
  ]) {
    assert.equal(formatElapsedTime(seconds, 'minutes-seconds'), minutes)
    assert.equal(formatElapsedTime(seconds, 'hours-minutes-seconds'), hours)
  }
})

test('negative elapsed display uses one sign and preserves millisecond rounding', () => {
  for (const [seconds, minutes, hours] of [
    [-0.5, '-00:00.500', '-00:00:00.500'],
    [-60.001, '-01:00.001', '-00:01:00.001'],
    [-3600.123, '-60:00.123', '-01:00:00.123'],
    [-90061.123, '-1501:01.123', '-25:01:01.123'],
    [-0.0006, '-00:00.001', '-00:00:00.001'],
    [-0.0015, '-00:00.001', '-00:00:00.001'],
    [-59.9996, '-01:00.000', '-00:01:00.000'],
    [59.9996, '01:00.000', '00:01:00.000'],
    ...[0, -0, -0.0001, -0.0005].map(seconds => [seconds, '00:00.000', '00:00:00.000']),
  ]) {
    assert.equal(formatElapsedTime(seconds, 'minutes-seconds'), minutes)
    assert.equal(formatElapsedTime(seconds, 'hours-minutes-seconds'), hours)
  }
  assert.equal(formatElapsedTime(-0.5, 'seconds'), '-0.500')
  assert.equal(formatElapsedTime(-90061.123, 'days-decimal'), '-1.042374109 d')
})

test('Scatter formats negative elapsed ticks while retaining raw seconds', () => {
  const base = addChartPanel([], 'Results', ['Voltage'])[0]
  const panel = { ...base, type: 'scatter', scatterXOutput: 'Time',
    xAxis: { ...base.xAxis, min: -90061.123, max: 0, interval: 0.5 } }
  const x = [-90061.123, -3600.123, -60.001, -0.5, 0]
  const y = [12, 13, 14, 15, 16]
  const data = createPageChartData()
  data.append('Time', 0, x)
  data.append('Voltage', 0, y)
  const expected = [
    ['minutes-seconds', ['-1501:01.123', '-60:00.123', '-01:00.001', '-00:00.500', '00:00.000']],
    ['hours-minutes-seconds', ['-25:01:01.123', '-01:00:00.123', '-00:01:00.001', '-00:00:00.500', '00:00:00.000']],
  ]
  for (const [format, labels] of expected) {
    const axis = chartPresentationOptions(panel, 1, colors, undefined, undefined, undefined, {}, false,
      { kind: 'elapsed-time', format }).xAxis
    assert.deepEqual(x.map(axis.axisLabel.formatter), labels)
    assert.equal(axis.min, -90061.123)
    assert.equal(axis.max, 0)
    assert.equal(axis.interval, 0.5)
    assert.deepEqual(prepareChartSeries(panel, data, 800, { min: 1, max: 5 })[0].data,
      x.map((value, row) => [value, y[row]]))
    assert.deepEqual(Array.from(data.getSeries('Time')), x)
  }
})

test('Timestamp display combinations preserve the full raw value in any host timezone', () => {
  const originalTZ = process.env.TZ
  try {
    for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Taipei']) {
      process.env.TZ = timezone
      combinations.forEach(([include_date, include_utc_offset], index) => {
        const format = { kind: 'timestamp', include_date, include_utc_offset }
        const output = step('timestamp', format)
        const row = Object.freeze({ name: 'Time', value: timestamp })
        assert.equal(formatOutputValue(output, row.value), displays[index])
        assert.equal(formatTimestampMillis(Date.parse(timestamp), format), displays[index])
        assert.equal(row.value, timestamp)
      })
    }
  } finally {
    if (originalTZ === undefined) delete process.env.TZ
    else process.env.TZ = originalTZ
  }
  const output = changeOutputValue(step('literal'), { source: 'timestamp' })
  assert.deepEqual(output.time_format, { kind: 'timestamp', include_date: true, include_utc_offset: true })
  assert.equal(formatOutputValue(output, timestamp), timestamp)
})

test('Output settings survive copy/paste and JSON, and changing source removes inactive settings', () => {
  const settings = formats.map(format => ({ kind: 'elapsed-time', format }))
    .concat(combinations.map(([include_date, include_utc_offset]) => ({ kind: 'timestamp', include_date, include_utc_offset })))
  settings.forEach(format => {
    const output = step(format.kind, format)
    const clipboard = copySteps([output], singleSelection('out'))
    const pasted = pasteSteps([output], clipboard, singleSelection('out')).steps[1]
    assert.deepEqual(pasted.time_format, format)
    assert.deepEqual(JSON.parse(JSON.stringify(pasted)).time_format, format)
    assert.deepEqual(changeOutputValue(output, { source: format.kind }).time_format, format)
    for (const value of [{ source: 'literal', value: 12 }, { source: 'variable', variable: 'v' },
      { source: 'step-output', step_id: 'read', pointer: '/value' }]) {
      assert.equal(Object.hasOwn(changeOutputValue(output, value), 'time_format'), false)
    }
  })
  assert.deepEqual(changeOutputValue(step('timestamp', settings[4]), { source: 'elapsed-time' }).time_format,
    { kind: 'elapsed-time', format: 'seconds' })
})

test('ordinary Output display is unchanged even with an inapplicable time setting', () => {
  const output = step('literal', { kind: 'elapsed-time', format: 'days-decimal' })
  for (const [value, expected] of [[12.5, '12.5'], ['12.5', '12.5'], [true, 'true'],
    [null, 'null'], [{ value: 1 }, '{"value":1}'], [[1, true], '[1,true]'], [undefined, '—']]) {
    assert.equal(formatOutputValue(output, value), expected)
  }
})

test('Scatter keeps Timestamp X through reconciliation and plots continuous numeric pairs', () => {
  const outputs = [{ name: 'Voltage' }, { name: 'Time' }]
  const panel = { ...addChartPanel([], 'Results', ['Voltage'])[0], type: 'scatter', scatterXOutput: 'Time' }
  const metadata = [{ name: 'Results', row_count: 2, numeric_outputs: ['Voltage'], timestamp_outputs: ['Time'] }]
  const reconciled = reconcileRunChartPanels([panel], [{ name: 'Results', outputs }], metadata)
  assert.equal(reconciled[0].scatterXOutput, 'Time')
  assert.deepEqual(reconciled[0].outputs, ['Voltage'])
  const invalidY = { ...panel, outputs: ['Voltage', 'Time'] }
  assert.deepEqual(reconcileRunChartPanels([invalidY], [{ name: 'Results', outputs }], metadata)[0].outputs, ['Voltage'])
  const data = createPageChartData()
  const x = ['2026-10-12T23:59:59.900+08:00', '2026-10-13T00:00:00.100+08:00'].map(Date.parse)
  data.append('Time', 0, x)
  data.append('Voltage', 0, [12, 13])
  assert.deepEqual(chartRequiredOutputs(panel), ['Time', 'Voltage'])
  assert.deepEqual(prepareChartSeries(panel, data, 800, { min: 1, max: 2 })[0].data, [[x[0], 12], [x[1], 13]])
  assert.equal(x[1] - x[0], 200)
  combinations.forEach(([include_date, include_utc_offset], index) => {
    const format = { kind: 'timestamp', include_date, include_utc_offset }
    const axis = chartPresentationOptions(panel, 1, colors, undefined, undefined, undefined, {}, false, format).xAxis
    assert.equal(axis.scale, true)
    assert.equal(axis.axisLabel.formatter(Date.parse(timestamp)), displays[index])
    assert.equal(formatTimestampMillis(x[1], format), formatTimestamp('2026-10-13T00:00:00.100+08:00', format))
  })
  data.append('Elapsed', 0, [90061.123, 90062.123])
  assert.deepEqual(prepareChartSeries({ ...panel, scatterXOutput: 'Elapsed' }, data, 800, { min: 1, max: 2 })[0].data,
    [[90061.123, 12], [90062.123, 13]])
  const numericAxis = chartPresentationOptions(panel, 1, colors).xAxis
  assert.equal(numericAxis.axisLabel.formatter, undefined)
})

test('ECharts renders readable fixed-offset Timestamp X labels across midnight', async () => {
  const { init } = await import('echarts')
  const panel = { ...addChartPanel([], 'Results', ['Voltage'])[0], type: 'scatter', scatterXOutput: 'Time' }
  const x = ['2026-10-12T23:59:59.900+08:00', '2026-10-13T00:00:00.100+08:00'].map(Date.parse)
  const format = { kind: 'timestamp', include_date: false, include_utc_offset: true }
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 400 })
  try {
    chart.setOption({ animation: false, ...chartPresentationOptions(panel, 1, colors, undefined,
      undefined, undefined, {}, false, format), series: [{ name: 'Voltage', type: 'scatter', data: [[x[0], 12], [x[1], 13]] }] })
    const svg = chart.renderToSVGString()
    assert.match(svg, /23:59:59\.[0-9]{3}\+08:00/)
    assert.match(svg, /00:00:00\.[0-9]{3}\+08:00/)
    assert.doesNotMatch(svg, /2026-10-1[23]T/)
  } finally {
    chart.dispose()
  }
})

test('Scatter Elapsed axes and hover share Output display while preserving raw pairs', () => {
  const panel = { ...addChartPanel([], 'Results', ['Voltage'])[0], type: 'scatter', scatterXOutput: 'Time' }
  const data = createPageChartData()
  const x = [2.857, 3600.123, 90061.123]
  data.append('Time', 0, x)
  data.append('Voltage', 0, [12, 13, 14])
  const pairs = [[2.857, 12], [3600.123, 13], [90061.123, 14]]
  const expected = [
    ['2.857', '3600.123', '90061.123'],
    ['00:02.857', '60:00.123', '1501:01.123'],
    ['00:00:02.857', '01:00:00.123', '25:01:01.123'],
    ['0.000033067 d', '0.041668090 d', '1.042374109 d'],
  ]
  formats.forEach((format, index) => {
    const timeFormat = { kind: 'elapsed-time', format }
    const axis = chartPresentationOptions(panel, 1, colors, undefined, undefined, undefined, {}, false, timeFormat).xAxis
    assert.equal(axis.scale, undefined)
    assert.deepEqual(x.map(axis.axisLabel.formatter), expected[index])
    assert.deepEqual(x.map(value => formatScatterX(value, timeFormat)), expected[index])
    assert.deepEqual(x.map(value => formatOutputValue(step('elapsed-time', timeFormat), value)), expected[index])
    assert.deepEqual(prepareChartSeries(panel, data, 800, { min: 1, max: 3 })[0].data, pairs)
    assert.deepEqual(Array.from(data.getSeries('Time')), x)
    assert.equal(chartPresentationOptions({ ...panel, type: 'line' }, 1, colors,
      undefined, undefined, undefined, {}, false, timeFormat).xAxis.axisLabel.formatter, undefined)
  })
  assert.equal(formatScatterX(2.857), 2.857)
  assert.equal(chartPresentationOptions(panel, 1, colors).xAxis.axisLabel.formatter, undefined)
  combinations.forEach(([include_date, include_utc_offset], index) => {
    assert.equal(formatScatterX(Date.parse(timestamp), { kind: 'timestamp', include_date, include_utc_offset }), displays[index])
  })
})

test('ECharts renders all four Elapsed X formats and clears the formatter for ordinary X', async () => {
  const { init } = await import('echarts')
  const base = addChartPanel([], 'Results', ['Voltage'])[0]
  const panel = { ...base, type: 'scatter', scatterXOutput: 'Time',
    xAxis: { ...base.xAxis, min: 2.857, max: 4.857, interval: 1 } }
  const expected = ['2.857', '00:02.857', '00:00:02.857', '0.000033067 d']
  const pairs = [[2.857, 12], [4.857, 13]]
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 400 })
  try {
    formats.forEach((format, index) => {
      chart.setOption({ animation: false, ...chartPresentationOptions(panel, 1, colors, undefined,
        undefined, undefined, {}, false, { kind: 'elapsed-time', format }),
      series: [{ name: 'Voltage', type: 'scatter', data: pairs }] }, { notMerge: true })
      assert.ok(chart.renderToSVGString().includes(`>${expected[index]}</text>`), format)
      assert.deepEqual(chart.getOption().series[0].data, pairs)
    })
    chart.setOption({ animation: false, ...chartPresentationOptions({ ...panel, scatterXOutput: 'Voltage' }, 1, colors),
      series: [{ name: 'Voltage', type: 'scatter', data: pairs }] }, { notMerge: true })
    assert.equal(chart.getOption().xAxis[0].axisLabel.formatter, undefined)
    assert.doesNotMatch(chart.renderToSVGString(), /00:02\.857|0\.000033067 d/)
  } finally {
    chart.dispose()
  }
})

test('Scatter hover formats the actual hit X only and retains raw Y and hit logic', async () => {
  const { readFileSync } = await import('node:fs')
  const { stripTypeScriptTypes } = await import('node:module')
  const { nearestScatterHover } = await import('../src/chartData.ts')
  const source = readFileSync(new URL('../src/ChartPlot.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('      const inspect = () => {')
  const end = source.indexOf('      const move =', start)
  const inspectSource = stripTypeScriptTypes(source.slice(start, end))
  const x = new Float64Array([2.857, 4.857])
  const rawSeries = [{ name: 'Voltage', values: new Float64Array([12.3456789, 13]) }]
  const chart = { containPixel: () => true, convertFromPixel: (_finder, point) => point }
  for (const timeFormat of [...formats.map(format => ({ kind: 'elapsed-time', format })), undefined,
    { kind: 'timestamp', include_date: false, include_utc_offset: true }]) {
    if (timeFormat?.kind === 'timestamp') x[0] = Date.parse(timestamp)
    const tip = { textContent: '' }
    const line = { hidden: false }
    let hidden = false
    const inspect = new Function('chart', 'scatterXValues', 'rawSeries', 'rawIteration', 'panel',
      'xTimeFormat', 'tip', 'line', 'nearestScatterHover', 'formatScatterX', 'hide', 'positionTip',
      `let frame = null; let pending = { offsetX: ${x[0]}, offsetY: 12.3456789 };
      const rawRowCount = 2; const bounded = undefined; const yValues = rawSeries.map(series => series.values);
      const SCATTER_HOVER_RADIUS = 12; ${inspectSource}; return inspect;`)(
      chart, x, rawSeries, new Float64Array([1, 2]), { scatterXOutput: 'Time', scatter: { display: 'markers' } },
      timeFormat, tip, line, nearestScatterHover, formatScatterX, () => { hidden = true }, () => {})
    inspect()
    assert.equal(hidden, false)
    assert.equal(tip.textContent, `Iteration 1\nX Time ${formatScatterX(x[0], timeFormat)}\nY Voltage 12.3456789`)
    assert.equal(line.hidden, true)
  }
})
