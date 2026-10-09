import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { claimRunGate, isCurrentRunGeneration, lastRunWorkspaceState, prepareLastRunReplacement, releaseRunGate } from '../src/runLifecycle.ts'

test('a started run keeps the Chart workspace render path before its first metadata', () => {
  assert.deepEqual(lastRunWorkspaceState(false, false, false), { starting: false, visible: false })
  assert.deepEqual(lastRunWorkspaceState(true, false, false), { starting: false, visible: false })
  assert.deepEqual(lastRunWorkspaceState(true, false, true), { starting: false, visible: true })
  assert.deepEqual(lastRunWorkspaceState(true, true, false), { starting: true, visible: true })
  assert.deepEqual(lastRunWorkspaceState(true, true, true), { starting: false, visible: true })
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(source, /lastRunWorkspaceState\(!!runWorkflowSnapshot, runStatus === 'running', !!runMetadata\)/)
  assert.match(source, /\{!runWorkspace.visible \? \([\s\S]*?No run results yet\./)
  assert.match(source, /\(runWorkspace.starting \|\| runPageMetadata\) && <ResultChart/)
  assert.match(source, /runId=\{displayedRun\?\.run_id \?\? null\}/)
})

test('Live and Simulation share one immediate run gate before React state can render', () => {
  const gate = { current: false }
  assert.equal(claimRunGate(gate), true)
  assert.equal(claimRunGate(gate), false)
  releaseRunGate(gate)
  assert.equal(claimRunGate(gate), true)
})

test('stale generations cannot publish progress or completion state', () => {
  assert.equal(isCurrentRunGeneration(4, 4), true)
  assert.equal(isCurrentRunGeneration(3, 4), false)
  assert.equal(isCurrentRunGeneration(null, 4), false)
})

test('both run entry points use the shared gate and preserve Chart configuration', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const live = source.slice(source.indexOf('const runLive'), source.indexOf('const runSimulation'))
  const simulation = source.slice(source.indexOf('const runSimulation'), source.indexOf('const workflowBusy'))
  for (const run of [live, simulation]) {
    assert.match(run, /claimRunGate\(runInFlightRef\)/)
    assert.match(run, /releaseRunGate\(runInFlightRef\)/)
    assert.doesNotMatch(run, /setChartPanels\(/)
  }
})

test('workflow replacement resolves only after the old StoredRun clears', async () => {
  const order = []
  const replacement = await prepareLastRunReplacement(
    async () => { order.push('load'); return { name: 'new' } },
    7,
    async runId => { order.push('clear:' + runId) },
  )
  order.push('commit')
  assert.deepEqual(order, ['load', 'clear:7', 'commit'])
  assert.deepEqual(replacement, { name: 'new' })
})

test('failed StoredRun clearing rejects replacement without reaching the caller commit point', async () => {
  let committed = false
  await assert.rejects(async () => {
    const replacement = await prepareLastRunReplacement(
      async () => ({ name: 'new' }),
      7,
      async () => { throw new Error('clear failed') },
    )
    committed = replacement.name === 'new'
  }, /clear failed/)
  assert.equal(committed, false)
})

test('off-tab Chart cleanup does not preserve an unmounted Page cache', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(source, /activeTab === 'output' \? runPage\?\.name : undefined/)
})

test('template Chart persistence changes only the intended Last Run lifecycle boundaries', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

  const createStart = source.indexOf('const createDraft =')
  const createEnd = source.indexOf('\n  const ', createStart)
  assert.match(source.slice(createStart, createEnd), /setSaveChartsWithTemplate\(false\)/)
  assert.match(source.slice(createStart, createEnd), /setChartPanels\(\[\]\)/)

  const loadStart = source.indexOf('const handleLoadTemplate =')
  const loadEnd = source.indexOf('\n  const ', loadStart)
  const load = source.slice(loadStart, loadEnd)
  assert.match(load, /setSaveChartsWithTemplate\(loadedDraft\.output_views !== undefined\)/)
  assert.match(load, /savedChartsToPanels\(loadedDraft\.output_views\.charts\)/)

  const clearStart = source.indexOf('const handleClearLastRun =')
  const clearEnd = source.indexOf('\n  const ', clearStart)
  const clear = source.slice(clearStart, clearEnd)
  assert.match(clear, /if \(!saveChartsWithTemplate\) setChartPanels\(\[\]\)/)

  assert.match(source, /const chartData = useMemo\(\(\) => new Map<string, PageChartData>\(\), \[runMetadata\?\.run_id\]\)/)
  assert.match(source, /if \(!runWorkflowSnapshot \|\| !displayedRun \|\| saveChartsWithTemplate\) return/)
  assert.match(source, /setChartPanels\(panels => reconcileRunChartPanels\(/)
})
