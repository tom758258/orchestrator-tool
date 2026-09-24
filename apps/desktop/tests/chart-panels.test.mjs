import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextChartPanelId, reconcileChartPanels, addChartPanel, canRemoveChartPanel, reconcileRunChartPanels } from '../src/chartPanels.ts'

const panel = (id, page, outputs) => ({ ...addChartPanel([], page, outputs)[0], id, outputs })

test('persisted panels allocate a fresh ID after remount and removal', () => {
  const panels = [0, 1, 2].map(id => panel(id, 'A', ['Voltage']))
  const restored = JSON.parse(JSON.stringify(panels))
  assert.equal(nextChartPanelId(restored), 3)
  assert.equal(nextChartPanelId(restored.filter(panel => panel.id !== 1)), 3)
  assert.equal(nextChartPanelId([]), 0)
})

test('Page reconciliation removes stale selections without clearing other Pages', () => {
  const panels = ['Outer', 'Inner', 'Deleted'].map((page, id) => ({
    ...panel(id, page, ['a', 'b', 'old']), title: 'Run result', showLegend: false,
    xAxis: { ...panel(id, page, ['a']).xAxis, min: 1, showLabels: false },
    yAxis: { ...panel(id, page, ['a']).yAxis, title: 'Value', max: 10, interval: 2 },
  }))
  const pages = [{ name: 'Outer', outputs: [{ name: 'a' }] }, { name: 'Inner', outputs: [{ name: 'b' }] }]
  const reconciled = reconcileChartPanels(panels, pages, 'Outer', ['a'])
  assert.notEqual(reconciled, panels)
  assert.deepEqual(reconciled.map(panel => [panel.page, panel.outputs]), [['Outer', ['a']], ['Inner', ['b']]])
  assert.equal(reconciled[1].title, 'Run result')
  assert.equal(reconciled[1].showLegend, false)
  assert.deepEqual(reconciled[1].xAxis, panels[1].xAxis)
  assert.deepEqual(reconciled[1].yAxis, panels[1].yAxis)
  assert.deepEqual(reconciled[1].zoom, panels[1].zoom)
  assert.deepEqual(reconcileChartPanels(reconciled, pages, 'Inner', [] )[1].outputs, [])
  assert.deepEqual(reconcileChartPanels(reconciled, pages, 'Outer', null), reconciled)
})

test('unchanged reconciliation preserves array and panel identity', () => {
  const panels = ['Outer', 'Inner'].map((page, id) => panel(id, page, ['a']))
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

const pages = ['A', 'B'].map(name => ({ name, outputs: [{ name: 'V' }, { name: 'I' }] }))
const metadata = ['A', 'B'].map(name => ({
  name, row_count: 1, revision: 1, numeric_outputs: ['V', 'I'], summaries: [], iteration_rows: false,
}))

test('multiple Charts per Page share a session-wide maximum of eight', () => {
  let panels = []
  for (let index = 0; index < 8; index++) panels = addChartPanel(panels, index < 4 ? 'A' : 'B', ['V', 'I'])
  assert.equal(panels.filter(panel => panel.page === 'A').length, 4)
  assert.equal(panels.filter(panel => panel.page === 'B').length, 4)
  assert.equal(new Set(panels.map(panel => panel.id)).size, 8)
  assert.equal(addChartPanel(panels, 'B', ['V']), panels)
  assert.equal(addChartPanel(panels, 'A', []), panels)
  // Selecting another workspace changes the displayed subset, never the session config.
  for (const selected of ['A', 'B', 'A']) {
    const local = panels.filter(panel => panel.page === selected)
    assert.equal(local.length, 4)
    assert.equal(reconcileChartPanels(panels, pages, selected, ['V', 'I']), panels)
  }
})

test('new Last Run defaults to exactly one Chart on its first Page', () => {
  const panels = reconcileRunChartPanels([], pages, metadata)
  assert.deepEqual(panels, [{ id: 0, page: 'A', title: '', outputs: ['V'], showLegend: true,
    zoom: { enabled: false, showSlider: true },
    xAxis: { title: 'Iteration', min: null, max: null, interval: null,
      showLabels: true, showTicks: true, showMajorGrid: false },
    yAxis: { title: '', min: null, max: null, interval: null,
      showLabels: true, showTicks: true, showMajorGrid: true } }])
  assert.equal(reconcileRunChartPanels(panels, pages, metadata), panels)
  const onlySecond = addChartPanel([], 'B', ['I'])
  assert.equal(reconcileRunChartPanels(onlySecond, pages, metadata), onlySecond)
})

test('first Page without numeric data never falls through to the second Page', () => {
  const nonnumeric = [{ ...metadata[0], numeric_outputs: [] }, metadata[1]]
  assert.deepEqual(reconcileRunChartPanels([], pages, nonnumeric), [])
  assert.deepEqual(reconcileRunChartPanels([], pages, [metadata[1]]), [])
  assert.deepEqual(reconcileRunChartPanels([], [], metadata), [])
})

test('a Page without committed cells retains compatible selections until numeric eligibility is known', () => {
  const panels = addChartPanel([], 'B', ['V'])
  assert.equal(reconcileRunChartPanels(panels, pages, [metadata[0]]), panels)
})

test('new Last Run reconciles every owned Page and preserves unaffected panel identity', () => {
  const panels = [...addChartPanel([], 'A', ['V']),
    { ...panel(1, 'B', ['V', 'I']), title: 'Custom', showLegend: false,
      xAxis: { ...panel(1, 'B', ['V']).xAxis, title: 'Custom' },
      yAxis: { ...panel(1, 'B', ['V']).yAxis, title: 'Value' } },
    panel(2, 'Deleted', ['V'])]
  const changed = [metadata[0], { ...metadata[1], numeric_outputs: ['I'] }]
  const result = reconcileRunChartPanels(panels, pages, changed)
  assert.notEqual(result, panels)
  assert.equal(result.length, 2)
  assert.equal(result[0], panels[0])
  assert.notEqual(result[1], panels[1])
  assert.deepEqual(result[1].outputs, ['I'])
  assert.equal(result[1].title, 'Custom')
  assert.equal(result[1].showLegend, false)
  assert.equal(result[1].xAxis.title, 'Custom')
  assert.equal(reconcileRunChartPanels(result, pages, changed), result)
  const stale = [panels[2]]
  assert.equal(reconcileRunChartPanels(stale, pages, metadata)[0].page, 'A')
})

test('the final Chart panel cannot be removed but either of two panels can be', () => {
  const one = addChartPanel([], 'A', ['V'])
  assert.equal(canRemoveChartPanel(one), false)
  assert.equal(canRemoveChartPanel([...one, { ...one[0], id: 1, page: 'B' }]), true)
})

test('a new run starts from an empty panel configuration and receives one default panel', () => {
  const previous = [
    { ...panel(7, 'A', ['V', 'I']), title: 'Old' },
    { ...panel(8, 'B', ['I']), title: 'Old' },
  ]
  assert.equal(previous.length, 2)
  const next = reconcileRunChartPanels([], pages, metadata)
  assert.deepEqual(next, addChartPanel([], 'A', ['V']))
})
