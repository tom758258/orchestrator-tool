import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeOutputValue, formatElapsedTime, formatOutputValue, formatTimestamp, formatTimestampMillis } from '../src/outputTime.ts'
import { copySteps, pasteSteps, singleSelection } from '../src/stepEditing.ts'
import { addChartPanel, chartRequiredOutputs, reconcileRunChartPanels } from '../src/chartPanels.ts'
import { createPageChartData, prepareChartSeries } from '../src/chartData.ts'
import { chartPresentationOptions } from '../src/chartOptions.ts'

const step = (source, time_format) => ({ type: 'output', id: 'out', name: 'Time', page: 'Results', value: { source }, time_format })
const formats = ['seconds', 'minutes-seconds', 'hours-minutes-seconds', 'days-decimal']
const combinations = [[true, true], [true, false], [false, true], [false, false]]
const timestamp = '2026-10-12T23:24:10.123+08:00'
const displays = [timestamp, '2026-10-12T23:24:10.123', '23:24:10.123+08:00', '23:24:10.123']
const colors = { ink: '#000', axis: '#000', grid: '#ccc' }

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
