import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { chartLoadGroups, chartNeedsLoad, createPageChartData } from '../src/chartData.ts'
import { addChartPanel, chartRawOutputs, chartRequiredOutputs, chartSupportsLive, reconcileRunChartPanels } from '../src/chartPanels.ts'
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
  '\n return { requestedNames, statistical, waitingForRunData }\n}')

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
      props = { timestampNames: [], outputs: [], ...next }
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

test('Timestamp Scatter X loads numeric milliseconds separately from measurement statistics', async () => {
  const calls = []
  const times = [Date.parse('2026-10-12T23:59:59.900+08:00'), Date.parse('2026-10-13T00:00:00.100+08:00')]
  const harness = loadingHarness(async (command, args) => {
    calls.push({ command, ...args })
    return { run_id: args.runId, page: args.page, start_row: args.startRow,
      series: Object.fromEntries(args.outputs.map(name => [name, name === 'Time' ? times : [12, 13]])) }
  })
  const base = addChartPanel([], 'A', ['Voltage'])[0]
  const chartData = new Map()
  try {
    await harness.update({ runId: 1, revision: 1, rowCount: 2, page: 'A', running: false,
      numericNames: ['Voltage'], timestampNames: ['Time'], chartData,
      panels: [{ ...base, type: 'scatter', scatterXOutput: 'Time' }] })
    assert.deepEqual(calls.map(call => [call.command, call.outputs]),
      [['get_last_run_chart_series', ['Time', 'Voltage']]])
    assert.deepEqual([...chartData.get('A').getSeries('Time')], times)
    assert.equal(chartData.get('A').getSeries('Time')[1] - chartData.get('A').getSeries('Time')[0], 200)
    calls.length = 0
    await harness.update({ runId: 1, revision: 1, rowCount: 2, page: 'A', running: false,
      numericNames: ['Voltage'], timestampNames: ['Time'], chartData,
      panels: [{ ...base, type: 'histogram', outputs: ['Time'] }] })
    assert.deepEqual(calls, [])
  } finally {
    harness.dispose()
  }
})

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

test('preserved panels wait through a new run ID until the first committed row starts Line loading', async () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const numericNamesFor = new Function('runStatus', 'runPageMetadata', 'chartPanels', 'runPage',
    'chartRequiredOutputs', 'runOutputs', appSource.slice(appSource.indexOf('  const chartNumericNames ='),
      appSource.indexOf('  // Numeric arrays survive')) + '\nreturn chartNumericNames')
  const calls = []
  const harness = loadingHarness(async (command, args) => {
    calls.push({ command, ...args })
    return { run_id: args.runId, page: args.page, start_row: args.startRow,
      series: Object.fromEntries(args.outputs.map(name => [name, Array(args.limit).fill(args.runId)])) }
  })
  const base = addChartPanel([], 'A', ['V'])[0]
  const oldData = createPageChartData()
  oldData.append('V', 0, [1])
  const props = { runId: 1, revision: 1, rowCount: 1, page: 'A', running: false,
    numericNames: ['V', 'I', 'X'], chartData: new Map([['A', oldData]]), panels: [base] }
  const pages = [{ name: 'A', outputs: ['V', 'I', 'X'].map(name => ({ name })) }]
  const numericNames = (metadata, running, panels) => numericNamesFor(
    running ? 'running' : 'succeeded', metadata, panels, pages[0], chartRequiredOutputs, pages[0].outputs.map(output => ({ ...output, value: { source: 'literal' } })))
  try {
    await harness.update(props)
    assert.equal(calls.length, 0)
    const starting = { ...props, runId: null, running: true, rowCount: 0,
      panels: [base, { ...base, id: 1, type: 'scatter', outputs: ['I'], scatterXOutput: 'X' },
        { ...base, id: 2, type: 'histogram', outputs: ['I'] }] }
    starting.numericNames = numericNames(undefined, true, starting.panels)
    const result = await harness.update(starting)
    assert.deepEqual(calls, [])
    assert.deepEqual(result.requestedNames, [])
    assert.equal(result.waitingForRunData, true)
    const metadata = { name: 'A', row_count: 0, numeric_outputs: [] }
    const progress = { ...starting, runId: 2, chartData: new Map(),
      panels: reconcileRunChartPanels(starting.panels, pages, [metadata]),
      numericNames: numericNames(metadata, true, starting.panels) }
    assert.deepEqual(progress.numericNames, ['V', 'X', 'I'])
    assert.equal(progress.panels, starting.panels)
    const waiting = await harness.update(progress)
    assert.deepEqual(waiting.requestedNames, ['V'])
    assert.equal(waiting.waitingForRunData, true)
    assert.deepEqual(calls, [])
    metadata.row_count = 1
    metadata.numeric_outputs = ['V']
    const committed = { ...progress, revision: 2, rowCount: 1,
      panels: reconcileRunChartPanels(progress.panels, pages, [metadata]),
      numericNames: numericNames(metadata, true, progress.panels) }
    assert.deepEqual(committed.numericNames, ['V'])
    assert.deepEqual(committed.panels.map(panel => panel.outputs), [['V'], [], []])
    const live = await harness.update(committed)
    assert.equal(live.waitingForRunData, false)
    assert.deepEqual(calls.map(call => [call.command, call.runId, call.outputs]),
      [['get_last_run_chart_series', 2, ['V']]])
    assert.deepEqual([...progress.chartData.get('A').getSeries('V')], [2])
    assert.deepEqual(numericNames({ ...metadata, row_count: 0, numeric_outputs: [] }, false,
      progress.panels), [])
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

test('switching to Line and removing panels preserves current-run loading for remaining charts', async () => {
  for (const initialRows of [0, 2]) {
    const calls = []
    const harness = loadingHarness(async (command, args) => {
      calls.push({ command, ...args })
      return { run_id: args.runId, page: args.page, start_row: args.startRow,
        series: Object.fromEntries(args.outputs.map(name => [name, Array(args.limit).fill(args.runId)])) }
    })
    const base = addChartPanel([], 'A', ['V'])[0]
    const panels = [base, { ...base, id: 1, type: 'histogram', outputs: ['I'] },
      { ...base, id: 2, type: 'scatter', outputs: ['X'] }]
    const props = { runId: 77, revision: 1, rowCount: initialRows, page: 'A', panels,
      numericNames: ['V', 'I', 'X'], chartData: new Map(), running: true }
    try {
      await harness.update(props)
      calls.length = 0
      const switched = { ...props, panels: panels.map(panel => panel.id === 1 ? { ...panel, type: 'line' } : panel) }
      const live = await harness.update(switched)
      assert.deepEqual(live.requestedNames, ['V', 'I'])
      if (initialRows === 0) {
        assert.deepEqual(calls, [])
        await harness.update({ ...switched, revision: 2, rowCount: 2 })
      }
      assert.deepEqual(calls.map(call => [call.command, call.runId, call.outputs]),
        [['get_last_run_chart_series', 77, initialRows === 0 ? ['I', 'V'] : ['I']]])
      calls.length = 0
      // Remove a Waiting panel without restarting or losing the live charts' data.
      const removedWaiting = { ...switched, rowCount: 2, panels: switched.panels.filter(panel => panel.id !== 2) }
      await harness.update(removedWaiting)
      assert.deepEqual(calls, [])
      assert.deepEqual([...props.chartData.get('A').getSeries('I')], [77, 77])
      // Removing a live panel drops only its dependency; the remaining chart keeps loading tails.
      const remaining = { ...removedWaiting, panels: [base] }
      const result = await harness.update(remaining)
      assert.deepEqual(result.requestedNames, ['V'])
      assert.equal(props.chartData.get('A').length('I'), 0)
      assert.deepEqual(calls, [])
      await harness.update({ ...remaining, revision: 3, rowCount: 3 })
      assert.deepEqual(calls.map(call => [call.command, call.runId, call.outputs, call.startRow]),
        [['get_last_run_chart_series', 77, ['V'], 2]])
      assert.deepEqual([...props.chartData.get('A').getSeries('V')], [77, 77, 77])
    } finally {
      harness.dispose()
    }
  }
})

test('Waiting keeps Settings and Remove available while locking Export PNG and Outputs', async () => {
  const React = (await import('react')).default
  const { transformWithOxc } = await import('vite')
  const chartDataModule = await import('../src/chartData.ts')
  const chartPanels = await import('../src/chartPanels.ts')
  const chartStatistics = await import('../src/chartStatistics.ts')
  const Plot = () => null
  const Settings = () => null
  let settingsId = null
  let savingId = null
  let stateIndex = 0
  const modules = { react: {
    useMemo: factory => factory(), useRef: value => ({ current: value }), useEffect: () => {},
    useState(initial) {
      const index = stateIndex++
      return [index === 0 ? savingId : index === 2 ? settingsId : initial,
        value => { if (index === 2) settingsId = value }]
    },
  }, './ChartPlot': Plot, './ChartSettings': Settings, './chartData': chartDataModule,
  './chartPanels': chartPanels, './chartStatistics': chartStatistics, './chartPng': { chartPng: () => {} },
  '@tauri-apps/api/core': { invoke: () => assert.fail('Unexpected loading') },
  '@tauri-apps/plugin-dialog': { save: () => {} } }
  const { code } = await transformWithOxc(source, 'ResultChart.tsx', { jsx: { runtime: 'classic' } })
  const body = code.replace(/import (.+?) from "([^"]+)";/g,
    (_, names, path) => `const ${names} = modules[${JSON.stringify(path)}];`).replace(/export default /g, '')
  const component = new Function('React', 'modules', `${body}; return ResultChart`)(React, modules)
  const base = addChartPanel([], 'A', ['V'])[0]
  let panels
  function render(rowCount, backgroundChartCount = 0) {
    stateIndex = 0
    const nodes = []
    function visit(node) {
      if (Array.isArray(node)) node.forEach(visit)
      else if (React.isValidElement(node)) { nodes.push(node); visit(node.props.children) }
    }
    visit(component({ runId: 77, revision: 1, rowCount, numericNames: ['V'], timestampNames: [], outputs: [],
      panels, onPanelsChange: value => { panels = value }, page: 'A', chartData: new Map(), running: true, backgroundChartCount }))
    return nodes
  }
  const button = (nodes, label) => nodes.find(node => node.type === 'button' && node.props.children === label)
  panels = [base]
  assert.equal(button(render(0, 6), '+ Add Chart').props.disabled, false)
  const full = button(render(0, 7), '+ Add Chart')
  assert.equal(full.props.disabled, true)
  full.props.onClick()
  assert.deepEqual(panels, [base])
  for (const type of ['scatter', 'column', 'area', 'bar', 'combo', 'histogram', 'boxplot']) {
    for (const rowCount of [0, 2]) {
      panels = [{ ...base, type }, { ...base, id: 1, page: 'B' }]
      settingsId = null
      const nodes = render(rowCount)
      assert.equal(button(nodes, 'Settings').props.disabled, false)
      assert.equal(button(nodes, 'Remove').props.disabled, false)
      assert.equal(button(nodes, 'Export PNG').props.disabled, true)
      assert.equal(button(nodes, '+ Add Chart').props.disabled, false)
      assert.equal(nodes.find(node => node.type === 'fieldset').props.disabled, true)
      assert.ok(nodes.some(node => node.props.children === 'Waiting for run to finish'))
      assert.equal(nodes.some(node => node.type === Plot), false)
      button(nodes, 'Settings').props.onClick()
      const dialog = render(rowCount).find(node => node.type === Settings)
      assert.equal(dialog.props.panel.type, type)
      assert.equal(dialog.props.running, true)
      assert.equal(dialog.props.hasRows, rowCount > 0)
      savingId = 1
      assert.equal(button(render(rowCount), 'Settings').props.disabled, true)
      assert.equal(button(render(rowCount), 'Remove').props.disabled, true)
      savingId = null
      const remaining = panels[1]
      button(render(rowCount), 'Remove').props.onClick()
      assert.deepEqual(panels, [remaining])
    }
  }
})

test('actual ResultChart passes snapshot X formats to Plot and snapshot Outputs to Settings', async () => {
  const React = (await import('react')).default
  const { transformWithOxc } = await import('vite')
  const chartDataModule = await import('../src/chartData.ts')
  const chartPanels = await import('../src/chartPanels.ts')
  const chartStatistics = await import('../src/chartStatistics.ts')
  const Plot = () => null
  const Settings = () => null
  let settingsId = null
  let stateIndex = 0
  const modules = { react: {
    useMemo: factory => factory(), useRef: value => ({ current: value }), useEffect: () => {},
    useState(initial) {
      const index = stateIndex++
      return [index === 2 ? settingsId : typeof initial === 'function' ? initial() : initial,
        value => { if (index === 2) settingsId = value }]
    },
  }, './ChartPlot': Plot, './ChartSettings': Settings, './chartData': chartDataModule,
  './chartPanels': chartPanels, './chartStatistics': chartStatistics, './chartPng': { chartPng: () => {} },
  '@tauri-apps/api/core': { invoke: () => assert.fail('Unexpected loading') },
  '@tauri-apps/plugin-dialog': { save: () => {} } }
  const { code } = await transformWithOxc(source, 'ResultChart.tsx', { jsx: { runtime: 'classic' } })
  const body = code.replace(/import (.+?) from "([^"]+)";/g,
    (_, names, path) => `const ${names} = modules[${JSON.stringify(path)}];`).replace(/export default /g, '')
  const component = new Function('React', 'modules', `${body}; return ResultChart`)(React, modules)
  const data = createPageChartData()
  data.append('Elapsed', 0, [2.857, 4.857])
  data.append('Time', 0, [Date.parse('2026-10-12T23:59:59.900+08:00'), Date.parse('2026-10-13T00:00:00.100+08:00')])
  data.append('V', 0, [12, 13])
  const panel = { ...addChartPanel([], 'A', ['V'])[0], type: 'scatter', scatterXOutput: 'Elapsed' }
  const formats = ['seconds', 'minutes-seconds', 'hours-minutes-seconds', 'days-decimal']
  const outputs = [
    { name: 'Elapsed', value: { source: 'elapsed-time' }, time_format: { kind: 'elapsed-time', format: 'seconds' } },
    { name: 'Time', value: { source: 'timestamp' }, time_format: { kind: 'timestamp', include_date: false, include_utc_offset: true } },
    { name: 'V', value: { source: 'literal', value: 1 } },
  ]
  function render() {
    stateIndex = 0
    const nodes = []
    function visit(node) {
      if (Array.isArray(node)) node.forEach(visit)
      else if (React.isValidElement(node)) { nodes.push(node); visit(node.props.children) }
    }
    visit(component({ runId: 1, revision: 1, rowCount: 2, numericNames: ['V', 'Elapsed'], timestampNames: ['Time'], outputs,
      panels: [panel], page: 'A', chartData: new Map([['A', data]]), running: false }))
    return nodes
  }
  for (const format of formats) {
    outputs[0].time_format = { kind: 'elapsed-time', format }
    assert.equal(render().find(node => node.type === Plot).props.xTimeFormat, outputs[0].time_format)
  }
  panel.scatterXOutput = 'Time'
  assert.equal(render().find(node => node.type === Plot).props.xTimeFormat, outputs[1].time_format)
  panel.scatterXOutput = 'V'
  assert.equal(render().find(node => node.type === Plot).props.xTimeFormat, undefined)
  panel.type = 'line'
  panel.scatterXOutput = 'Elapsed'
  assert.equal(render().find(node => node.type === Plot).props.xTimeFormat, undefined)
  render().find(node => node.type === 'button' && node.props.children === 'Settings').props.onClick()
  assert.equal(render().find(node => node.type === Settings).props.outputs, outputs)
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /numericNames=\{chartNumericNames\} page=\{runPage\.name\} outputs=\{runOutputs\}/)
  assert.match(app, /outputPageContext\(runWorkflowSnapshot\?\.workflow\.steps \?\? \[\], selectedRunPage\)/)
})
