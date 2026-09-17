import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextChartPanelId, reconcileChartPanels } from '../src/chartPanels.ts'

test('persisted panels allocate a fresh ID after remount and removal', () => {
  const panels = [0, 1, 2].map(id => ({ id, outputs: ['Voltage'], xAxisTitle: 'Iteration', yAxisTitle: '' }))
  const restored = JSON.parse(JSON.stringify(panels))
  assert.equal(nextChartPanelId(restored), 3)
  assert.equal(nextChartPanelId(restored.filter(panel => panel.id !== 1)), 3)
  assert.equal(nextChartPanelId([]), 0)
})

test('Page reconciliation removes stale selections without clearing other Pages', () => {
  const panels = ['Outer', 'Inner', 'Deleted'].map((page, id) => ({
    id, page, outputs: ['a', 'b', 'old'], xAxisTitle: 'Iteration', yAxisTitle: 'Value',
  }))
  const pages = [{ name: 'Outer', outputs: [{ name: 'a' }] }, { name: 'Inner', outputs: [{ name: 'b' }] }]
  const reconciled = reconcileChartPanels(panels, pages, 'Outer', ['a'])
  assert.deepEqual(reconciled.map(panel => [panel.page, panel.outputs]), [['Outer', ['a']], ['Inner', ['b']]])
  assert.equal(reconciled[1].yAxisTitle, 'Value')
  assert.deepEqual(reconcileChartPanels(reconciled, pages, 'Inner', [] )[1].outputs, [])
  assert.deepEqual(reconcileChartPanels(reconciled, pages, 'Outer', null), reconciled)
})
