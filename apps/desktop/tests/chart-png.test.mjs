import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addChartPanel } from '../src/chartPanels.ts'
import { chartPng } from '../src/chartPng.ts'

const panel = { ...addChartPanel([], 'A', ['V'])[0],
  zoom: { enabled: true, showSlider: true } }

function fakeChart(fail = false) {
  const calls = []
  const chart = {
    isDisposed: () => false,
    setOption(option) { calls.push(['setOption', option]) },
    getDataURL(options) {
      calls.push(['getDataURL', options])
      if (fail) throw new Error('export failed')
      return 'data:image/png;base64,YQ=='
    },
    dispatchAction() { throw new Error('Zoom must not change during export') },
  }
  return { chart, calls }
}

test('PNG uses selected background, hides dataZoom and restores screen presentation', async () => {
  const original = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({ getPropertyValue: name => ({
    '--chart-surface': '#123456', '--ink': '#eeeeee',
    '--chart-axis': '#aaaaaa', '--chart-grid': '#555555',
  })[name] })
  globalThis.document = { documentElement: {} }
  try {
    for (const [background, expected] of [['light', '#ffffff'], ['dark', '#222326']]) {
      const { chart, calls } = fakeChart()
      const bytes = await chartPng(chart, { ...panel, imageBackground: background })
      assert.deepEqual([...bytes], [97])
      assert.deepEqual(calls.map(([name]) => name), ['setOption', 'getDataURL', 'setOption'])
      assert.equal(calls[0][1].backgroundColor, expected)
      assert.equal(calls[0][1].grid.bottom, 64)
      assert.equal(calls[0][1].title.textStyle.color, calls[0][1].textStyle.color)
      assert.equal(calls[0][1].legend.textStyle.color, calls[0][1].textStyle.color)
      assert.equal(calls[0][1].xAxis.axisLine.lineStyle.color,
        calls[0][1].yAxis.axisLabel.color)
      assert.ok(calls[0][1].xAxis.splitLine.lineStyle.color)
      assert.equal(Object.hasOwn(calls[0][1], 'dataZoom'), false)
      assert.equal(Object.hasOwn(calls[0][1], 'series'), false)
      assert.equal(calls[1][1].backgroundColor, expected)
      assert.deepEqual(calls[1][1].excludeComponents, ['dataZoom'])
      assert.equal(calls[2][1].backgroundColor, '#123456')
      assert.equal(calls[2][1].grid.bottom, 112)
      assert.equal(calls[2][1].title.textStyle.color, '#eeeeee')
      assert.equal(calls[2][1].xAxis.axisLine.lineStyle.color, '#aaaaaa')
    }
  } finally {
    globalThis.getComputedStyle = original
    delete globalThis.document
  }
})

test('PNG export restores presentation when capture fails', async () => {
  const original = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#123456' })
  globalThis.document = { documentElement: {} }
  try {
    const { chart, calls } = fakeChart(true)
    await assert.rejects(chartPng(chart, panel), /export failed/)
    assert.deepEqual(calls.map(([name]) => name), ['setOption', 'getDataURL', 'setOption'])
    assert.equal(calls[2][1].grid.bottom, 112)
  } finally {
    globalThis.getComputedStyle = original
    delete globalThis.document
  }
})

test('Combo PNG recolors and restores both Y axes for light and dark export', async () => {
  const original = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({ getPropertyValue: name => ({
    '--chart-surface': '#123456', '--ink': '#eeeeee',
    '--chart-axis': '#aaaaaa', '--chart-grid': '#555555',
  })[name] })
  globalThis.document = { documentElement: {} }
  try {
    for (const background of ['light', 'dark']) {
      const { chart, calls } = fakeChart()
      await chartPng(chart, { ...panel, type: 'combo', outputs: ['V', 'I'], imageBackground: background })
      assert.equal(calls[0][1].yAxis.length, 2)
      assert.equal(calls[0][1].yAxis[0].axisLabel.color, calls[0][1].yAxis[1].axisLabel.color)
      assert.equal(calls[2][1].yAxis.length, 2)
      assert.equal(calls[2][1].yAxis[0].axisLabel.color, '#aaaaaa')
      assert.equal(calls[2][1].yAxis[1].axisLabel.color, '#aaaaaa')
    }
  } finally {
    globalThis.getComputedStyle = original
    delete globalThis.document
  }
})
