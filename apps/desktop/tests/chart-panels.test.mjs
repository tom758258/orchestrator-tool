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
  assert.notEqual(reconciled, panels)
  assert.deepEqual(reconciled.map(panel => [panel.page, panel.outputs]), [['Outer', ['a']], ['Inner', ['b']]])
  assert.equal(reconciled[1].yAxisTitle, 'Value')
  assert.deepEqual(reconcileChartPanels(reconciled, pages, 'Inner', [] )[1].outputs, [])
  assert.deepEqual(reconcileChartPanels(reconciled, pages, 'Outer', null), reconciled)
})

test('unchanged reconciliation preserves array and panel identity', () => {
  const panels = ['Outer', 'Inner'].map((page, id) => ({
    id, page, outputs: ['a'], xAxisTitle: 'Iteration', yAxisTitle: 'Value',
  }))
  const pages = panels.map(panel => ({ name: panel.page, outputs: [{ name: 'a' }] }))
  assert.equal(reconcileChartPanels(panels, pages, 'Outer', ['a']), panels)
  assert.equal(reconcileChartPanels(panels, pages, 'Outer', null), panels)
  const filtered = reconcileChartPanels(panels, pages, 'Outer', [])
  assert.notEqual(filtered, panels)
  assert.notEqual(filtered[0], panels[0])
  assert.equal(filtered[1], panels[1])
  assert.deepEqual(filtered[0].outputs, [])
  const removed = reconcileChartPanels(panels, pages.slice(0, 1), 'Outer', ['a'])
  assert.notEqual(removed, panels)
  assert.deepEqual(removed, [panels[0]])
  assert.equal(removed[0], panels[0])
})
