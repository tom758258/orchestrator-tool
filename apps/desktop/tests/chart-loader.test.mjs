import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { chartLoadGroups, chartNeedsLoad, createPageChartData } from '../src/chartData.ts'
import { addChartPanel, chartRawOutputs, chartSupportsLive } from '../src/chartPanels.ts'
import { statisticalRequestKey } from '../src/chartStatistics.ts'

const source = readFileSync(new URL('../src/ResultChart.tsx', import.meta.url), 'utf8')

test('heterogeneous series are planned from their own local lengths with a 25k bound', () => {
  const data = createPageChartData()
  data.append('V', 0, Array.from({ length: 50_000 }, () => 1))
  const groups = chartLoadGroups(data, ['V', 'I'], 75_000, 25_000)
  assert.deepEqual(groups.map(group => [group.startRow, group.names, group.limit]), [
    [50_000, ['V'], 25_000],
    [0, ['I'], 25_000],
  ])
})

test('caught-up detection becomes false again as soon as a new row arrives', () => {
  const data = createPageChartData()
  data.append('V', 0, Array.from({ length: 25_000 }, () => 1))
  assert.equal(chartNeedsLoad(data, ['V'], 25_000), false)
  assert.equal(chartNeedsLoad(data, ['V'], 25_001), true)
})

test('each successful response still renders once after all response series append', () => {
  const loader = source.slice(source.indexOf('async function runLoader'))
  const appendAt = loader.indexOf('local.append(names[index], startRow, tails[index])')
  const bumpAt = loader.indexOf('setDataVersion(version => version + 1)')
  assert.ok(appendAt !== -1 && bumpAt !== -1 && appendAt < bumpAt)
  assert.equal(loader.match(/setDataVersion\(version => version \+ 1\)/g).length, 1)
  assert.doesNotMatch(source, /Promise\.all\(\[?\.\.\.groups/)
})

test('loader identity remains reversible and content-stable', () => {
  assert.match(source, /JSON\.stringify\(\[\.\.\.requestedNames\]\.sort\(\)\)/)
  assert.match(source, /JSON\.parse\(requestedKey\) as string\[\]/)
  assert.doesNotMatch(source, /join\('\\0'\)|split\('\\0'\)/)
})

test('statistical-only panels request no raw series while Combo still does', () => {
  const base = addChartPanel([], 'A', ['V'])[0]
  const panels = [{ ...base, type: 'histogram' },
    { ...base, id: 1, type: 'boxplot', outputs: ['V', 'I'] }]
  assert.deepEqual([...new Set(panels.flatMap(chartRawOutputs))], [])
  assert.deepEqual(chartLoadGroups(createPageChartData(), panels.flatMap(chartRawOutputs), 500_000, 25_000), [])
  assert.deepEqual(chartRawOutputs({ ...base, type: 'combo', outputs: ['V', 'I'] }), ['V', 'I'])
  assert.deepEqual(chartRawOutputs({ ...base, type: 'scatter', scatterXOutput: 'I' }), ['I', 'V'])
  assert.match(source, /loadingPanels\.flatMap\(chartRawOutputs\)/)
})

test('statistical keys change with run and query parameters', () => {
  const base = { ...addChartPanel([], 'A', ['V'])[0], type: 'histogram' }
  assert.notEqual(statisticalRequestKey(1, base), statisticalRequestKey(2, base))
  assert.notEqual(statisticalRequestKey(1, base), statisticalRequestKey(1,
    { ...base, histogram: { ...base.histogram, mode: 'count', value: 20 } }))
  assert.equal(statisticalRequestKey(1, base), statisticalRequestKey(1, { ...base,
    seriesColors: { V: '#123456' },
    histogram: { ...base.histogram, showNormalCurve: true, mean: 1, stdDev: 2 } }))
})

// Execute the component's actual loading hooks without mounting its Canvas UI.
const loadingSource = stripTypeScriptTypes(source.slice(source.indexOf('export default function ResultChart'),
  source.indexOf('  async function saveImage')).replace('export default ', '') +
  '\n return { requestedNames, statistical }\n}')

function loadingHarness(invoke) {
  const slots = []
  let cursor = 0
  let pending = []
  let dirty = false
  let props
  let result
  const sameDeps = (before, after) => before && before.length === after.length &&
    before.every((value, index) => Object.is(value, after[index]))
  const hooks = {
    useRef(value) {
      const index = cursor++
      return slots[index] ??= { current: value }
    },
    useState(value) {
      const index = cursor++
      slots[index] ??= { value }
      return [slots[index].value, update => {
        slots[index].value = typeof update === 'function' ? update(slots[index].value) : update
        dirty = true
      }]
    },
    useMemo(factory, deps) {
      const index = cursor++
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { deps, value: factory() }
      return slots[index].value
    },
    useEffect(effect, deps) {
      const index = cursor++
      if (!sameDeps(slots[index]?.deps, deps)) pending.push(() => {
        slots[index]?.cleanup?.()
        slots[index] = { deps, cleanup: effect() }
      })
    },
  }
  const dependencies = { ...hooks, invoke, createPageChartData, chartRawOutputs, chartSupportsLive,
    statisticalRequestKey, chartLoadGroups, chartNeedsLoad, CHART_SERIES_CHUNK_ROWS: 25_000 }
  const render = new Function(...Object.keys(dependencies), loadingSource + '\nreturn ResultChart')
    (...Object.values(dependencies))
  function commit() {
    cursor = 0
    dirty = false
    pending = []
    result = render(props)
    pending.forEach(effect => effect())
  }
  return {
    async update(next) {
      props = next
      commit()
      for (let count = 0; count < 20; count++) {
        await new Promise(resolve => setImmediate(resolve))
        if (!dirty) return result
        commit()
      }
      assert.fail('loading hooks did not settle')
    },
    dispose() { slots.forEach(slot => slot.cleanup?.()) },
  }
}

for (const type of ['line', 'scatter', 'column', 'area', 'bar', 'combo', 'histogram', 'boxplot']) {
  test(`${type}: actual requests obey live eligibility and automatically resume after running`, async () => {
    const calls = []
    const harness = loadingHarness(async (command, args) => {
      calls.push({ command, ...args })
      return { run_id: args.runId, page: args.page, start_row: args.startRow,
        series: Object.fromEntries((args.outputs ?? []).map(name => [name, Array(args.limit).fill(args.runId)])) }
    })
    const panel = { ...addChartPanel([], 'A', ['V'])[0], type,
      outputs: type === 'histogram' ? ['V'] : ['V', 'I'], scatterXOutput: type === 'scatter' ? 'X' : null }
    const props = { runId: 2, revision: 1, rowCount: 2, page: 'A', panels: [panel],
      numericNames: ['V', 'I', 'X'], chartData: new Map(), running: true }
    try {
      await harness.update(props)
      const liveRaw = type === 'line' ? ['I', 'V'] : []
      assert.deepEqual(calls.map(call => [call.command, call.outputs]), liveRaw.length
        ? [['get_last_run_chart_series', liveRaw]] : [])
      calls.length = 0
      await harness.update({ ...props, revision: 2, rowCount: 3 })
      assert.equal(calls.length, type === 'line' ? 1 : 0)
      if (type === 'line') assert.equal(calls[0].startRow, 2)
      calls.length = 0
      const completed = { ...props, revision: 3, rowCount: 4, running: false }
      const result = await harness.update(completed)
      assert.equal(calls.length, 1)
      const command = type === 'histogram' ? 'get_last_run_histogram'
        : type === 'boxplot' ? 'get_last_run_box_plot' : 'get_last_run_chart_series'
      assert.equal(calls[0].command, command)
      assert.equal(calls[0].runId, 2)
      if (type === 'histogram' || type === 'boxplot') {
        assert.equal(result.statistical[panel.id].response.run_id, 2)
      } else {
        assert.equal(calls[0].startRow, type === 'line' ? 3 : 0)
        assert.deepEqual([...props.chartData.get('A').getSeries('V')], [2, 2, 2, 2])
      }
      calls.length = 0
      // App creates a fresh Page cache for each run ID.
      const rerun = { ...props, runId: 3, chartData: new Map() }
      await harness.update(rerun)
      assert.equal(calls.length, type === 'line' ? 1 : 0)
      calls.length = 0
      const third = await harness.update({ ...rerun, running: false, rowCount: 4 })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].runId, 3)
      if (type === 'histogram' || type === 'boxplot') {
        assert.equal(third.statistical[panel.id].response.run_id, 3)
      } else {
        assert.deepEqual([...rerun.chartData.get('A').getSeries('V')], [3, 3, 3, 3])
      }
    } finally {
      harness.dispose()
    }
  })
}

test('a mixed Page only loads Line dependencies during running', async () => {
  const calls = []
  const harness = loadingHarness(async (command, args) => {
    calls.push({ command, ...args })
    return { run_id: args.runId, page: args.page, start_row: args.startRow,
      series: Object.fromEntries(args.outputs.map(name => [name, Array(args.limit).fill(1)])) }
  })
  const base = addChartPanel([], 'A', ['V'])[0]
  try {
    await harness.update({ runId: 2, revision: 1, rowCount: 1, page: 'A', running: true,
      numericNames: ['V', 'I', 'X'], chartData: new Map(),
      panels: [base, { ...base, id: 1, type: 'scatter', outputs: ['I'], scatterXOutput: 'X' },
        { ...base, id: 2, type: 'histogram', outputs: ['I'] }] })
    assert.deepEqual(calls.map(call => [call.command, call.outputs]), [['get_last_run_chart_series', ['V']]])
  } finally {
    harness.dispose()
  }
})

for (const type of ['scatter', 'histogram', 'boxplot']) {
  test(`${type}: an old pending response is cancelled when a new run starts`, async () => {
    let completeOld
    const calls = []
    const harness = loadingHarness((command, args) => {
      calls.push({ command, ...args })
      const response = { run_id: args.runId, page: args.page, start_row: args.startRow,
        series: { V: [args.runId] } }
      return args.runId === 1 ? new Promise(resolve => { completeOld = () => resolve(response) })
        : Promise.resolve(response)
    })
    const panel = { ...addChartPanel([], 'A', ['V'])[0], type }
    const oldCache = new Map()
    const props = { runId: 1, revision: 1, rowCount: 1, page: 'A', panels: [panel],
      numericNames: ['V'], chartData: oldCache, running: false }
    try {
      await harness.update(props)
      assert.equal(calls.length, 1)
      const next = { ...props, runId: 2, chartData: new Map(), running: true }
      await harness.update(next)
      completeOld()
      const waiting = await harness.update(next)
      assert.equal(calls.length, 1)
      assert.equal(waiting.statistical[panel.id]?.response, undefined)
      assert.equal(oldCache.get('A')?.length('V') ?? 0, 0)
      const finished = await harness.update({ ...next, running: false })
      assert.equal(calls.length, 2)
      assert.equal(calls[1].runId, 2)
      if (type === 'scatter') assert.deepEqual([...next.chartData.get('A').getSeries('V')], [2])
      else assert.equal(finished.statistical[panel.id].response.run_id, 2)
    } finally {
      harness.dispose()
    }
  })
}

test('Waiting precedes plot rendering and locks every panel action without locking Add Chart', () => {
  assert.match(source, /const waiting = running && !chartSupportsLive\(panel.type\)/)
  for (const label of ['Export PNG', 'Settings', 'Remove']) {
    const action = source.slice(source.lastIndexOf('<button', source.indexOf(`>${label}</button>`)),
      source.indexOf(`>${label}</button>`))
    assert.match(action, /disabled=\{waiting \|\|/)
  }
  assert.match(source, /<fieldset className="result-chart-outputs" disabled=\{waiting \|\|/)
  assert.match(source, /\{!waiting && settingsId === panel.id && <ChartSettings/)
  const plotBranch = source.slice(source.indexOf('{waiting ? <div'), source.indexOf('<ChartPlot'))
  assert.match(plotBranch, /Waiting for run to finish/)
  assert.match(plotBranch, /This chart does not support live updates\. It will update automatically when the run finishes\./)
  assert.match(plotBranch, /<\/div> : selectedOutputs/)
  const addAction = source.slice(source.indexOf('<button'), source.indexOf('>+ Add Chart</button>'))
  assert.doesNotMatch(addAction, /waiting|running/)
})
