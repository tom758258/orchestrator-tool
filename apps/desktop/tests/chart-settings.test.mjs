import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { addChartPanel, seriesColor } from '../src/chartPanels.ts'
import { chartGridLeft, chartGridRight, chartLayout, chartPresentationOptions,
  chartZoomSliderBottom, lineRendererSeries } from '../src/chartOptions.ts'
import { chartTypeAxisTitles, createChartSettingsDraft, validateChartSettingsDraft } from '../src/chartSettingsModel.ts'
import { init } from 'echarts'

const panel = addChartPanel([], 'A', ['V'])[0]
const colors = { ink: 'ink', axis: 'axis', grid: 'grid' }

const autoPalette = { V: 'rgb(255,0,0)', I: 'rgb(0,0,255)' }
// Mirrors ChartPlot: the Auto palette color, overridden by a Custom series color.
const legendData = (configured) => chartPresentationOptions(configured, configured.outputs.length,
  colors, undefined, undefined, undefined, Object.fromEntries(configured.outputs.map(name =>
    [name, seriesColor(configured, name, autoPalette[name])]))).legend.data
// A marker-free legend line must stay a marker-free line that carries its Output color.
const plainLine = (name, color) => ({ name, icon: 'line',
  itemStyle: { color, borderColor: color, borderWidth: 2 } })

test('Auto axes leave min, max and interval to ECharts', () => {
  const options = chartPresentationOptions(panel, 1, colors)
  for (const axis of [options.xAxis, options.yAxis]) {
    assert.equal(Object.hasOwn(axis, 'min'), false)
    assert.equal(Object.hasOwn(axis, 'max'), false)
    assert.equal(Object.hasOwn(axis, 'interval'), false)
  }
  assert.equal(options.title.text, '')
  assert.equal(options.legend.show, true)
  assert.deepEqual(legendData(panel), [plainLine('V', 'rgb(255,0,0)')])
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

const combo = { ...panel, type: 'combo', outputs: ['V', 'I'], combo: { ...panel.combo,
  series: { V: { kind: 'column', axis: 'left', markers: false },
    I: { kind: 'line', axis: 'right', markers: false } } } }

// Every marker-free line-like chart must keep a marker-free legend line carrying its own color.
const markerFreeCases = [
  { label: 'Line', configured: { ...panel, outputs: ['V', 'I'] } },
  { label: 'Area', configured: { ...panel, type: 'area', outputs: ['V', 'I'] } },
  { label: 'Scatter lines', configured: { ...panel, type: 'scatter', outputs: ['V', 'I'],
    scatter: { ...panel.scatter, display: 'lines' } } },
  { label: 'Combo Line', configured: combo },
]

test('marker-free legend lines keep their own Output color for Line, Area, Scatter and Combo', () => {
  for (const { label, configured } of markerFreeCases) {
    const data = legendData(configured)
    assert.deepEqual(data, label === 'Combo Line'
      ? ['V', plainLine('I', 'rgb(0,0,255)')]
      : [plainLine('V', 'rgb(255,0,0)'), plainLine('I', 'rgb(0,0,255)')], label)
    for (const item of data) {
      if (typeof item === 'string') continue
      assert.equal(item.icon, 'line', label)
      assert.equal(item.itemStyle.color, item.itemStyle.borderColor, label)
    }
  }
})

test('marker-free legend lines follow Auto and Custom series colors alike', () => {
  for (const { label, configured } of markerFreeCases) {
    const data = legendData({ ...configured, seriesColors: { V: '#123456' } })
    for (const item of data) {
      if (typeof item === 'string') continue
      // A Custom color must win for V while every other Output keeps its Auto palette color.
      const expected = item.name === 'V' ? '#123456' : 'rgb(0,0,255)'
      assert.deepEqual(item.itemStyle,
        { color: expected, borderColor: expected, borderWidth: 2 }, label)
    }
  }
})

test('marker-enabled legend entries keep series icons and are never downgraded to plain lines', () => {
  assert.deepEqual(legendData({ ...panel, line: { series: { V: { markers: true } } } }), ['V'])
  assert.deepEqual(legendData({ ...panel, type: 'scatter', outputs: ['V', 'I'],
    scatter: { ...panel.scatter, display: 'lines-markers' } }), ['V', 'I'])
  assert.deepEqual(legendData({ ...panel, type: 'scatter', outputs: ['V', 'I'],
    scatter: { ...panel.scatter, display: 'markers' } }), ['V', 'I'])
  assert.deepEqual(legendData({ ...combo, combo: { ...combo.combo, series: { ...combo.combo.series,
    I: { ...combo.combo.series.I, markers: true } } } }), ['V', 'I'])
})

// A plain legend line is a zero-area path, so it only paints through a stroke.
function legendPaths(configured, series) {
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 640, height: 400 })
  try {
    chart.setOption({ animation: false, ...chartPresentationOptions(configured, series.length, colors,
      undefined, undefined, undefined, Object.fromEntries(series.map(item =>
        [item.name, item.lineStyle.color]))),
    xAxis: { type: 'value' }, yAxis: { type: 'value' }, series })
    return chart.renderToSVGString().replace(/\s+/g, ' ').split('<path ').slice(1)
      .map(part => part.split('>')[0])
  } finally {
    chart.dispose()
  }
}

test('ECharts paints each marker-free legend line in its own Output series color', () => {
  const configured = { ...panel, outputs: ['V', 'I'] }
  const lines = legendPaths(configured, [
    lineRendererSeries(configured, { name: 'V', data: [[0, 1], [1, 2]] }, 'rgb(255,0,0)'),
    lineRendererSeries(configured, { name: 'I', data: [[0, 2], [1, 1]] }, 'rgb(0,0,255)'),
  ]).filter(part => part.includes('d="M0 7L25 7"'))
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('stroke="rgb(255,0,0)"'), lines[0])
  assert.ok(lines[1].includes('stroke="rgb(0,0,255)"'), lines[1])
})

test('a marker-enabled legend still renders its marker beside the line', () => {
  const configured = { ...panel, line: { series: { V: { markers: true } } },
    markerStyles: { V: { shape: 'diamond', size: 8, fillColor: '#ffffff', borderColor: '#000000' } } }
  const paths = legendPaths(configured,
    [lineRendererSeries(configured, { name: 'V', data: [[0, 1], [1, 2]] }, 'rgb(255,0,0)')])
  assert.ok(paths.some(part => part.includes('stroke="rgb(255,0,0)"')), 'line color')
  assert.ok(paths.some(part => part.includes('fill="#ffffff"') && part.includes('stroke="#000000"')),
    'marker fill and border')
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

test('Scatter validates active sizes and repairs only invalid inactive values', () => {
  const draft = createChartSettingsDraft({ ...panel, type: 'scatter' })
  for (const value of ['0', '-1', '', 'Infinity', 'NaN', '1e309']) {
    draft.scatter = { display: 'markers', markerSize: value, lineWidth: '2' }
    assert.match(validateChartSettingsDraft(draft).error, /Marker size/)
    draft.scatter = { display: 'lines', markerSize: '4', lineWidth: value }
    assert.match(validateChartSettingsDraft(draft).error, /Line width/)
  }

  draft.scatter = { display: 'lines', markerSize: '', lineWidth: '3' }
  assert.deepEqual(validateChartSettingsDraft(draft).settings.scatter,
    { display: 'lines', markerSize: 4, lineWidth: 3 })
  draft.scatter = { display: 'markers', markerSize: '5', lineWidth: 'bad' }
  assert.deepEqual(validateChartSettingsDraft(draft).settings.scatter,
    { display: 'markers', markerSize: 5, lineWidth: 2 })

  draft.scatter = { display: 'lines-markers', markerSize: '', lineWidth: '2' }
  assert.match(validateChartSettingsDraft(draft).error, /Marker size/)
  draft.scatter = { display: 'lines-markers', markerSize: '4', lineWidth: '0' }
  assert.match(validateChartSettingsDraft(draft).error, /Line width/)

  draft.type = 'line'
  draft.scatter = { display: 'lines-markers', markerSize: 'bad', lineWidth: 'bad' }
  assert.deepEqual(validateChartSettingsDraft(draft).settings.scatter,
    { display: 'lines-markers', markerSize: 4, lineWidth: 2 })
  draft.scatter = { display: 'markers', markerSize: '7', lineWidth: '3' }
  assert.deepEqual(validateChartSettingsDraft(draft).settings.scatter,
    { display: 'markers', markerSize: 7, lineWidth: 3 })
})

test('chart settings default new marker state for prior in-memory panels', () => {
  const { line: _line, markerStyles: _markerStyles, ...legacy } = panel
  const draft = createChartSettingsDraft(legacy)
  assert.deepEqual(draft.line, { series: {} })
  assert.deepEqual(draft.markerStyles, {})
})

test('Line and Combo marker styles round-trip and validate active per-Output sizes', () => {
  const configured = { ...panel,
    line: { series: { V: { markers: true } } },
    markerStyles: { V: { shape: 'diamond', size: 7, fillColor: '#ffffff', borderColor: '#123456' } } }
  const draft = createChartSettingsDraft(configured)
  assert.deepEqual(draft.line, configured.line)
  assert.deepEqual(draft.markerStyles.V,
    { shape: 'diamond', size: '7', fillColor: '#ffffff', borderColor: '#123456' })
  let result = validateChartSettingsDraft(draft)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.settings.line, configured.line)
  assert.deepEqual(result.settings.markerStyles, configured.markerStyles)

  draft.markerStyles.V.size = '0'
  assert.match(validateChartSettingsDraft(draft).error, /V marker size/)
  draft.line.series.V.markers = false
  result = validateChartSettingsDraft(draft)
  assert.equal(result.error, undefined)
  assert.equal(result.settings.markerStyles.V.size, 4)

  const comboDraft = createChartSettingsDraft({ ...configured, type: 'combo',
    combo: { ...panel.combo, series: { V: { kind: 'line', axis: 'right', markers: true } } } })
  comboDraft.markerStyles.V.size = 'bad'
  assert.match(validateChartSettingsDraft(comboDraft).error, /V marker size/)
  comboDraft.combo.series.V.markers = false
  assert.equal(validateChartSettingsDraft(comboDraft).settings.markerStyles.V.size, 4)

  const scatterDraft = createChartSettingsDraft({ ...configured, type: 'scatter' })
  scatterDraft.markerStyles.V.size = 'bad'
  assert.equal(validateChartSettingsDraft(scatterDraft).error, undefined)
  assert.equal(validateChartSettingsDraft(scatterDraft).settings.markerStyles.V.size, 4)
})

test('inactive axis numerics do not block Apply and preserve valid hidden values', () => {
  const draft = createChartSettingsDraft(panel)
  draft.combo.rightAxis = { ...draft.combo.rightAxis, title: 'Current',
    min: 'bad', max: '10', interval: '0' }
  let result = validateChartSettingsDraft(draft)
  assert.equal(result.error, undefined)
  assert.equal(result.settings.combo.rightAxis.title, 'Current')
  assert.deepEqual([result.settings.combo.rightAxis.min, result.settings.combo.rightAxis.max,
    result.settings.combo.rightAxis.interval], [null, 10, null])

  draft.combo.rightAxis = { ...draft.combo.rightAxis, min: '10', max: '5', interval: '2' }
  result = validateChartSettingsDraft(draft)
  assert.deepEqual([result.settings.combo.rightAxis.min, result.settings.combo.rightAxis.max,
    result.settings.combo.rightAxis.interval], [null, null, 2])

  draft.combo.rightAxis = { ...draft.combo.rightAxis, min: '0', max: '5', interval: '1' }
  result = validateChartSettingsDraft(draft)
  assert.deepEqual([result.settings.combo.rightAxis.min, result.settings.combo.rightAxis.max,
    result.settings.combo.rightAxis.interval], [0, 5, 1])

  draft.type = 'combo'
  draft.combo.rightAxis.min = 'bad'
  assert.match(validateChartSettingsDraft(draft).error, /Right Y Axis min/)
})

test('statistical charts normalize hidden X numerics while active X stays strict', () => {
  const draft = createChartSettingsDraft(panel)
  draft.xAxis.min = 'bad'
  assert.match(validateChartSettingsDraft(draft).error, /X Axis min/)
  for (const type of ['histogram', 'boxplot']) {
    draft.type = type
    draft.xAxis = { ...draft.xAxis, min: 'bad', max: '10', interval: '0' }
    const settings = validateChartSettingsDraft(draft).settings
    assert.deepEqual([settings.xAxis.min, settings.xAxis.max, settings.xAxis.interval],
      [null, 10, null])
  }
  draft.type = 'histogram'
  draft.xAxis = { ...draft.xAxis, min: '0', max: '10', interval: '2' }
  const settings = validateChartSettingsDraft(draft).settings
  assert.deepEqual([settings.xAxis.min, settings.xAxis.max, settings.xAxis.interval], [0, 10, 2])
})

test('inactive Histogram bin values repair to safe defaults without weakening active validation', () => {
  const draft = createChartSettingsDraft(panel)
  draft.histogram = { ...draft.histogram, mode: 'count', value: 'bad' }
  assert.deepEqual(validateChartSettingsDraft(draft).settings.histogram, { ...panel.histogram, mode: 'count', value: 20 })
  draft.histogram = { ...draft.histogram, mode: 'width', value: '0' }
  assert.deepEqual(validateChartSettingsDraft(draft).settings.histogram, { ...panel.histogram, mode: 'width', value: 0.5 })
  draft.type = 'histogram'
  draft.histogram = { ...draft.histogram, mode: 'count', value: 'bad' }
  assert.match(validateChartSettingsDraft(draft).error, /bin count/)
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
    series: { V: { kind: 'line', axis: 'right', markers: true } },
    rightAxis: { ...panel.combo.rightAxis, title: 'Current', max: 10 } } }
  assert.deepEqual(validateChartSettingsDraft(createChartSettingsDraft(combo)).settings.combo, combo.combo)
  const box = { ...panel, type: 'boxplot', boxPlot: { showOutliers: false } }
  assert.deepEqual(validateChartSettingsDraft(createChartSettingsDraft(box)).settings.boxPlot, box.boxPlot)
  const draft = createChartSettingsDraft({ ...panel, type: 'histogram' })
  assert.deepEqual(validateChartSettingsDraft(draft).settings.histogram, panel.histogram)
  draft.histogram = { ...draft.histogram, mode: 'count', value: '20' }
  assert.equal(validateChartSettingsDraft(draft).settings.histogram.value, 20)
  for (const value of ['0', '2.5', '201']) {
    draft.histogram.value = value
    assert.match(validateChartSettingsDraft(draft).error, /bin count/)
  }
  draft.histogram = { ...draft.histogram, mode: 'width', value: '0.5' }
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

test('automatic axis titles follow chart semantics while custom titles remain unchanged', () => {
  const line = createChartSettingsDraft({ ...panel, scatterXOutput: 'Voltage' })
  assert.deepEqual(chartTypeAxisTitles(line, 'histogram', 'V'), { x: 'V', y: 'Count' })
  assert.deepEqual(chartTypeAxisTitles(line, 'scatter', 'V'), { x: 'Voltage', y: '' })

  const scatter = { ...line, type: 'scatter', xAxis: { ...line.xAxis, title: 'Voltage' } }
  assert.deepEqual(chartTypeAxisTitles(scatter, 'line', 'V'), { x: 'Iteration', y: '' })
  assert.deepEqual(chartTypeAxisTitles(scatter, 'histogram', 'V'), { x: 'V', y: 'Count' })
  assert.deepEqual(chartTypeAxisTitles(scatter, 'boxplot', 'V'), { x: '', y: '' })

  const histogram = { ...line, type: 'histogram', xAxis: { ...line.xAxis, title: 'V' },
    yAxis: { ...line.yAxis, title: 'Count' } }
  assert.deepEqual(chartTypeAxisTitles(histogram, 'line', 'V'), { x: 'Iteration', y: '' })
  assert.deepEqual(chartTypeAxisTitles(histogram, 'boxplot', 'V'), { x: '', y: '' })

  const box = { ...line, type: 'boxplot', xAxis: { ...line.xAxis, title: '' } }
  assert.deepEqual(chartTypeAxisTitles(box, 'line', 'V'), { x: 'Iteration', y: '' })

  const custom = { ...scatter, xAxis: { ...scatter.xAxis, title: 'Input Voltage (V)' },
    yAxis: { ...scatter.yAxis, title: 'Output' } }
  assert.deepEqual(chartTypeAxisTitles(custom, 'line', 'V'),
    { x: 'Input Voltage (V)', y: 'Output' })
})

test('Normal overrides and custom colors round-trip without mutating the panel', () => {
  const draft = createChartSettingsDraft({ ...panel, type: 'histogram' })
  draft.histogram.showNormalCurve = true
  draft.histogram.mean = ' -2.5 '
  draft.histogram.stdDev = '1.5'
  draft.seriesColors.V = '#123456'
  const result = validateChartSettingsDraft(draft)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.settings.histogram, { ...panel.histogram,
    showNormalCurve: true, mean: -2.5, stdDev: 1.5 })
  assert.deepEqual(result.settings.seriesColors, { V: '#123456' })
  const roundTrip = createChartSettingsDraft({ ...panel, ...result.settings })
  assert.deepEqual(validateChartSettingsDraft(roundTrip).settings, result.settings)
  assert.deepEqual(panel.seriesColors, {})
  assert.equal(panel.histogram.showNormalCurve, false)
  roundTrip.histogram.mean = ' '
  roundTrip.histogram.stdDev = ''
  delete roundTrip.seriesColors.V
  const automatic = validateChartSettingsDraft(roundTrip).settings
  assert.equal(automatic.histogram.mean, null)
  assert.equal(automatic.histogram.stdDev, null)
  assert.deepEqual(automatic.seriesColors, {})
})

test('Normal mean must be finite and standard deviation must be finite and positive', () => {
  const draft = createChartSettingsDraft({ ...panel, type: 'histogram' })
  for (const invalid of ['NaN', 'Infinity', '-Infinity', '1e309', 'oops']) {
    draft.histogram.mean = invalid
    assert.match(validateChartSettingsDraft(draft).error, /mean.*finite/)
  }
  draft.histogram.mean = '0'
  for (const invalid of ['0', '-1', 'NaN', 'Infinity', '-Infinity', '1e309', 'oops']) {
    draft.histogram.stdDev = invalid
    assert.match(validateChartSettingsDraft(draft).error, /standard deviation/)
  }
  draft.histogram.stdDev = '2'
  assert.equal(validateChartSettingsDraft(draft).error, undefined)
  draft.type = 'line'
  draft.histogram.mean = 'bad'
  draft.histogram.stdDev = '0'
  assert.deepEqual(validateChartSettingsDraft(draft).settings.histogram,
    { ...panel.histogram, mean: null, stdDev: null })
})

test('Show All Raw Data is off by default and round-trips through Chart Settings', () => {
  assert.equal(panel.showAllRawData, false)
  const oldPanel = { ...panel }
  delete oldPanel.showAllRawData
  assert.equal(createChartSettingsDraft(oldPanel).showAllRawData, false)
  const draft = createChartSettingsDraft(panel)
  assert.equal(draft.showAllRawData, false)
  draft.showAllRawData = true
  const saved = validateChartSettingsDraft(draft).settings
  assert.equal(saved.showAllRawData, true)
  assert.equal(createChartSettingsDraft({ ...panel, ...saved }).showAllRawData, true)
  draft.showAllRawData = false
  assert.equal(validateChartSettingsDraft(draft).settings.showAllRawData, false)
  assert.equal(panel.showAllRawData, false)
})

test('Show All is a Line-only General setting with an explicit Live rendering warning', () => {
  const source = readFileSync(new URL('../src/ChartSettings.tsx', import.meta.url), 'utf8')
  assert.match(source, /draft\.type === 'line' && <>[\s\S]*?Show All Raw Data/)
  assert.match(source, /checked=\{draft\.showAllRawData\}/)
  assert.match(source, /may[\s\S]*?Desktop interface to lag[\s\S]*?Live execution/)
})
