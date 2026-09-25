import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addChartPanel } from '../src/chartPanels.ts'
import { chartGridLeft, chartGridRight, chartLayout, chartPresentationOptions,
  chartZoomSliderBottom } from '../src/chartOptions.ts'
import { chartTypeAxisTitles, createChartSettingsDraft, validateChartSettingsDraft } from '../src/chartSettingsModel.ts'

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
  assert.equal(options.legend.show, true)
  assert.equal(options.xAxis.axisLabel.hideOverlap, true)
  assert.equal(options.yAxis.axisLabel.hideOverlap, true)
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

test('legend position reserves the matching edge and honors Show legend for one series', () => {
  const titled = { ...panel, title: 'Voltage' }
  const top = chartPresentationOptions(titled, 1, colors)
  assert.equal(top.legend.show, true)
  assert.equal(top.legend.orient, 'horizontal')
  assert.equal(top.legend.type, 'scroll')
  assert.equal(top.legend.top, 40)
  assert.equal(top.grid.top, 88)
  const hidden = chartPresentationOptions({ ...titled, showLegend: false }, 1, colors)
  assert.equal(hidden.legend.show, false)
  assert.equal(hidden.grid.top, 64)
  for (const position of ['bottom', 'left', 'right']) {
    const options = chartPresentationOptions({ ...titled, legendPosition: position }, 1, colors)
    assert.equal(options.legend.show, true)
    assert.equal(options.legend.orient, position === 'bottom' ? 'horizontal' : 'vertical')
    assert.equal(options.grid.top, 64)
    if (position === 'bottom') {
      assert.equal(options.legend.bottom, 8)
      assert.ok(options.grid.bottom > top.grid.bottom)
    } else {
      assert.equal(options.legend[position], 8)
      assert.equal(options.legend.bottom, options.grid.bottom)
      assert.equal(options.legend.textStyle.overflow, 'truncate')
      assert.ok(options.legend.textStyle.width < options.legend.width)
      assert.ok(options.grid[position] > top.grid[position])
    }
  }
  const left = { ...titled, legendPosition: 'left' }
  assert.equal(chartGridLeft(left), chartLayout(left).grid.left)
  const right = { ...titled, legendPosition: 'right' }
  assert.equal(chartGridRight(right), chartLayout(right).grid.right)
})

test('bottom legend separates the zoom slider and right legend leaves Combo right axis space', () => {
  const bottom = { ...panel, legendPosition: 'bottom', zoom: { enabled: true, showSlider: true } }
  const options = chartPresentationOptions(bottom, 1, colors)
  assert.ok(options.grid.bottom > 112)
  assert.ok(chartZoomSliderBottom(bottom) > 12)
  assert.equal(chartLayout(bottom, false).grid.bottom, 104)
  const combo = { ...panel, type: 'combo', outputs: ['V', 'I'], legendPosition: 'right' }
  const comboOptions = chartPresentationOptions(combo, 2, colors)
  assert.equal(comboOptions.yAxis.length, 2)
  assert.ok(comboOptions.grid.right > chartGridRight({ ...combo, showLegend: false }))
  assert.equal(comboOptions.legend.right, 8)
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
  draft.imageBackground = 'dark'
  draft.type = 'scatter'
  draft.scatterXOutput = 'V'
  draft.legendPosition = 'right'
  draft.scatter = { display: 'lines-markers', markerSize: '8', lineWidth: '4' }
  draft.xAxis.min = '  '
  draft.yAxis.min = '-2.5'
  draft.yAxis.max = '5'
  draft.yAxis.interval = '0.5'
  const valid = validateChartSettingsDraft(draft)
  assert.equal(valid.error, undefined)
  assert.deepEqual([valid.settings.xAxis.min, valid.settings.yAxis.min,
    valid.settings.yAxis.max, valid.settings.yAxis.interval], [null, -2.5, 5, 0.5])
  assert.deepEqual(valid.settings.zoom, { enabled: true, showSlider: false })
  assert.equal(valid.settings.imageBackground, 'dark')
  assert.equal(valid.settings.type, 'scatter')
  assert.equal(valid.settings.scatterXOutput, 'V')
  assert.equal(valid.settings.legendPosition, 'right')
  assert.deepEqual(valid.settings.scatter, { display: 'lines-markers', markerSize: 8, lineWidth: 4 })
  assert.equal(panel.legendPosition, 'top')
  assert.deepEqual(panel.scatter, { display: 'markers', markerSize: 4, lineWidth: 2 })
  assert.equal(panel.imageBackground, 'light')
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

test('scatter sizes must be positive finite numbers', () => {
  const draft = createChartSettingsDraft({ ...panel, type: 'scatter' })
  for (const [field, label] of [['markerSize', /Marker size/], ['lineWidth', /Line width/]]) {
    for (const value of ['0', '-1', '', 'Infinity', 'NaN', '1e309']) {
      draft.scatter[field] = value
      assert.match(validateChartSettingsDraft(draft).error, label)
    }
    draft.scatter[field] = field === 'markerSize' ? '4' : '2'
  }
  assert.deepEqual(validateChartSettingsDraft(draft).settings.scatter, panel.scatter)
})

test('Bar settings map stored axes to physical X and Y without changing their values', () => {
  const bar = { ...panel, type: 'bar', xAxis: { ...panel.xAxis, title: 'Iteration' },
    yAxis: { ...panel.yAxis, title: 'Value' } }
  const options = chartPresentationOptions(bar, 2, colors, undefined, Float64Array.of(1, 2, 3))
  assert.equal(options.xAxis.name, 'Value')
  assert.equal(options.yAxis.name, 'Iteration')
  assert.equal(options.xAxis.type, 'value')
  assert.equal(options.yAxis.type, 'category')
  assert.deepEqual(options.yAxis.data, ['1', '2', '3'])
  const custom = chartPresentationOptions({ ...bar,
    xAxis: { ...bar.xAxis, interval: 2.5 } }, 2, colors, undefined, Float64Array.of(1, 5, 6))
  assert.equal(custom.yAxis.axisLabel.interval(0, '5'), true)
  assert.equal(custom.yAxis.axisLabel.interval(0, '6'), false)
  assert.equal(createChartSettingsDraft(bar).type, 'bar')
})

test('Combo and Box settings round-trip and histogram modes validate', () => {
  const combo = { ...panel, type: 'combo', combo: { ...panel.combo,
    series: { V: { kind: 'line', axis: 'right' } },
    rightAxis: { ...panel.combo.rightAxis, title: 'Current', max: 10 } } }
  assert.deepEqual(validateChartSettingsDraft(createChartSettingsDraft(combo)).settings.combo, combo.combo)
  const box = { ...panel, type: 'boxplot', boxPlot: { showOutliers: false } }
  assert.deepEqual(validateChartSettingsDraft(createChartSettingsDraft(box)).settings.boxPlot, box.boxPlot)
  const draft = createChartSettingsDraft({ ...panel, type: 'histogram' })
  assert.deepEqual(validateChartSettingsDraft(draft).settings.histogram, { mode: 'auto', value: null })
  draft.histogram = { mode: 'count', value: '20' }
  assert.equal(validateChartSettingsDraft(draft).settings.histogram.value, 20)
  for (const value of ['0', '2.5', '201']) {
    draft.histogram.value = value
    assert.match(validateChartSettingsDraft(draft).error, /bin count/)
  }
  draft.histogram = { mode: 'width', value: '0.5' }
  assert.equal(validateChartSettingsDraft(draft).settings.histogram.value, 0.5)
  draft.histogram.value = '0'
  assert.match(validateChartSettingsDraft(draft).error, /bin width/)
})

test('Combo uses two Y axes and category charts ignore numeric X bounds', () => {
  const combo = { ...panel, type: 'combo', outputs: ['V', 'I'],
    combo: { ...panel.combo, rightAxis: { ...panel.combo.rightAxis, title: 'Current', max: 5 } } }
  const options = chartPresentationOptions(combo, 2, colors)
  assert.equal(options.yAxis.length, 2)
  assert.equal(options.yAxis[1].name, 'Current')
  assert.equal(options.yAxis[1].max, 5)
  assert.ok(options.grid.right > chartPresentationOptions(panel, 1, colors).grid.right)
  const histogram = { ...panel, type: 'histogram', xAxis: { ...panel.xAxis, min: 1, max: 10, interval: 2 } }
  const categories = chartPresentationOptions(histogram, 1, colors, undefined, undefined, ['1–2'])
  assert.equal(categories.xAxis.type, 'category')
  assert.equal(Object.hasOwn(categories.xAxis, 'min'), false)
  assert.equal(Object.hasOwn(categories.xAxis, 'interval'), false)
  assert.equal(categories.legend.show, false)
})

test('statistical type transitions update only recognized automatic axis titles', () => {
  const line = createChartSettingsDraft(panel)
  assert.deepEqual(chartTypeAxisTitles(line, 'histogram', 'V'), { x: 'V', y: 'Count' })
  const histogram = { ...line, type: 'histogram', xAxis: { ...line.xAxis, title: 'V' },
    yAxis: { ...line.yAxis, title: 'Count' } }
  assert.deepEqual(chartTypeAxisTitles(histogram, 'boxplot', 'V'), { x: '', y: '' })
  assert.deepEqual(chartTypeAxisTitles({ ...line, xAxis: { ...line.xAxis, title: 'Voltage' } },
    'boxplot', 'V'), { x: 'Voltage', y: '' })
})
