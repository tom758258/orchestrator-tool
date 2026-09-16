import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextChartPanelId } from '../src/chartPanels.ts'

test('persisted panels allocate a fresh ID after remount and removal', () => {
  const panels = [0, 1, 2].map(id => ({ id, outputs: ['Voltage'], xAxisTitle: 'Iteration', yAxisTitle: '' }))
  const restored = JSON.parse(JSON.stringify(panels))
  assert.equal(nextChartPanelId(restored), 3)
  assert.equal(nextChartPanelId(restored.filter(panel => panel.id !== 1)), 3)
  assert.equal(nextChartPanelId([]), 0)
})
