import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addChartPanel } from '../src/chartPanels.ts'
import { chartPresentationOptions } from '../src/chartOptions.ts'
import { createChartSettingsDraft, validateChartSettingsDraft } from '../src/chartSettingsModel.ts'

const panel = addChartPanel([], 'A', ['V'])[0]
const colors = { ink: 'ink', axis: 'axis', grid: 'grid' }

test('Auto axes leave min, max and interval to ECharts', () => {
  const options = chartPresentationOptions(panel, 1, colors)
  for (const axis of [options.xAxis, options.yAxis]) {
    assert.equal(Object.hasOwn(axis, 'min'), false)
    assert.equal(Object.hasOwn(axis, 'max'), false)
    assert.equal(Object.hasOwn(axis, 'interval'), false)
  }
  assert.equal(options.title.text, '')
  assert.equal(options.legend.show, false)
})

test('explicit axes, grid, labels, ticks, title and legend map to ECharts', () => {
  const custom = { ...panel, title: 'Voltage', showLegend: true,
    xAxis: { ...panel.xAxis, min: 1, max: 10, interval: 2,
      showLabels: false, showTicks: false, showMajorGrid: true },
    yAxis: { ...panel.yAxis, title: 'Volts', min: -5, max: 5, interval: 1,
      showLabels: true, showTicks: true, showMajorGrid: false } }
  const options = chartPresentationOptions(custom, 2, colors)
  assert.equal(options.title.text, 'Voltage')
  assert.equal(options.legend.show, true)
  assert.equal(chartPresentationOptions({ ...custom, showLegend: false }, 2, colors).legend.show, false)
  assert.deepEqual([options.xAxis.min, options.xAxis.max, options.xAxis.interval], [1, 10, 2])
  assert.deepEqual([options.yAxis.min, options.yAxis.max, options.yAxis.interval], [-5, 5, 1])
  assert.equal(options.yAxis.name, 'Volts')
  assert.deepEqual([options.xAxis.axisLabel.show, options.xAxis.axisTick.show, options.xAxis.splitLine.show],
    [false, false, true])
  assert.deepEqual([options.yAxis.axisLabel.show, options.yAxis.axisTick.show, options.yAxis.splitLine.show],
    [true, true, false])
})

test('zoom uses the full X domain and reserves slider space only when shown', () => {
  const zoomed = { ...panel, zoom: { enabled: true, showSlider: true } }
  const domain = { min: 0, max: 200_000 }
  const options = chartPresentationOptions(zoomed, 1, colors, domain)
  assert.deepEqual([options.xAxis.min, options.xAxis.max], [0, 200_000])
  assert.ok(options.grid.bottom > chartPresentationOptions(panel, 1, colors).grid.bottom)
  assert.equal(chartPresentationOptions({ ...zoomed, zoom: { ...zoomed.zoom, showSlider: false } },
    1, colors, domain).grid.bottom, chartPresentationOptions(panel, 1, colors).grid.bottom)
})

test('draft validation accepts blank Auto and rejects invalid axes without changing the panel', () => {
  const draft = createChartSettingsDraft(panel)
  draft.title = 'Edited'
  draft.zoom.enabled = true
  draft.zoom.showSlider = false
  draft.xAxis.min = '  '
  draft.yAxis.min = '-2.5'
  draft.yAxis.max = '5'
  draft.yAxis.interval = '0.5'
  const valid = validateChartSettingsDraft(draft)
  assert.equal(valid.error, undefined)
  assert.deepEqual([valid.settings.xAxis.min, valid.settings.yAxis.min,
    valid.settings.yAxis.max, valid.settings.yAxis.interval], [null, -2.5, 5, 0.5])
  assert.deepEqual(valid.settings.zoom, { enabled: true, showSlider: false })
  assert.deepEqual(panel.zoom, { enabled: false, showSlider: true })
  assert.equal(panel.title, '')
  assert.equal(panel.yAxis.min, null)
  draft.yAxis.min = '5'
  assert.match(validateChartSettingsDraft(draft).error, /less than maximum/)
  draft.yAxis.min = '0'
  draft.yAxis.interval = '0'
  assert.match(validateChartSettingsDraft(draft).error, /greater than zero/)
  draft.yAxis.interval = 'Infinity'
  assert.match(validateChartSettingsDraft(draft).error, /finite number/)
  draft.yAxis.interval = '1e309'
  assert.match(validateChartSettingsDraft(draft).error, /finite number/)
  draft.yAxis.interval = '1'
  draft.xAxis.max = 'oops'
  assert.match(validateChartSettingsDraft(draft).error, /finite number/)
})
