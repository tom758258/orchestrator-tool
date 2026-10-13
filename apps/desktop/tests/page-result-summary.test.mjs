import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'

test('Page Result Summary consumes Rust metadata without scanning ResultRows', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const component = readFileSync(new URL('../src/PageResultSummary.tsx', import.meta.url), 'utf8')
  assert.match(app, /<PageResultSummary summaries=\{runPageMetadata\.summaries\} outputs=\{runOutputs\} numericFormat=\{numericFormat\} \/>/)
  assert.match(app, /outputPageContext\(runWorkflowSnapshot\?\.workflow\.steps \?\? \[\], selectedRunPage\)/)
  assert.match(component, /summaries: readonly NumericSummary\[\]/)
  assert.doesNotMatch(component, /ResultRowDto|summarizePageResults/)
})

test('Summary defaults and optional derived columns use metadata and preserve missing sigma', () => {
  const source = readFileSync(new URL('../src/PageResultSummary.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('const columns =')
  const end = source.indexOf('export default', start)
  assert.ok(start >= 0 && end > start)
  const columns = runInNewContext(stripTypeScriptTypes(source.slice(start, end) + '\ncolumns'))
  assert.deepEqual(Array.from(columns.filter(column => column.default), column => column.key),
    ['count', 'min', 'max', 'avg'])
  const summary = { name: 'V', count: 4, min: 1, max: 4, avg: 2.5, std_dev: 1.2909944487358056 }
  const values = Object.fromEntries(columns.map(column => [column.key, column.value(summary)]))
  assert.equal(values.range, 3)
  assert.equal(values.stdDev, summary.std_dev)
  assert.equal(values.twoSigma, summary.std_dev * 2)
  assert.equal(values.threeSigma, summary.std_dev * 3)
  for (const std_dev of [null, 0]) {
    const constant = { ...summary, count: std_dev === null ? 1 : 3, min: 7, max: 7, std_dev }
    const derived = Object.fromEntries(columns.map(column => [column.key, column.value(constant)]))
    assert.equal(derived.range, 0)
    assert.equal(derived.stdDev, std_dev)
    assert.equal(derived.twoSigma, std_dev)
    assert.equal(derived.threeSigma, std_dev)
  }
})

test('actual Summary renders all Elapsed statistics with snapshot formats and preserves metadata', async () => {
  const React = (await import('react')).default
  const { transformWithOxc } = await import('vite')
  const outputTime = await import('../src/outputTime.ts')
  const source = readFileSync(new URL('../src/PageResultSummary.tsx', import.meta.url), 'utf8')
  const { code } = await transformWithOxc(source, 'PageResultSummary.tsx', { jsx: { runtime: 'classic' } })
  const modules = { react: { useState: () => [['count', 'min', 'max', 'avg', 'range', 'stdDev', 'twoSigma', 'threeSigma'], () => {}] },
    './outputTime': outputTime }
  const body = code.replace(/import (.+?) from "([^"]+)";/g,
    (_, names, path) => `const ${names} = modules[${JSON.stringify(path)}];`).replace(/export default /g, '')
  const render = new Function('React', 'modules', `${body}; return PageResultSummary`)(React, modules)
  const formats = ['seconds', 'minutes-seconds', 'hours-minutes-seconds', 'days-decimal']
  const outputs = formats.map(format => ({ type: 'output', id: format, name: format, page: 'Results',
    value: { source: 'elapsed-time' }, time_format: { kind: 'elapsed-time', format } }))
  outputs.push({ type: 'output', id: 'V', name: 'V', page: 'Results', value: { source: 'literal', value: 1 } })
  const summary = { count: 7, min: 10.600000000000001, max: 90061.123, avg: 45031.990123456, std_dev: 60.123456789 }
  const summaries = outputs.map(output => Object.freeze({ name: output.name, ...summary }))
  summaries.push(Object.freeze({ name: 'missing', count: 1, min: 2.857, max: 2.857, avg: 2.857, std_dev: null }))
  outputs.push({ ...outputs[0], name: 'missing' })
  const before = structuredClone({ summaries, outputs })
  const rows = []
  function visit(node) {
    if (Array.isArray(node)) node.forEach(visit)
    else if (React.isValidElement(node)) {
      if (node.type === 'tr' && node.props.children[0]?.props.scope === 'row') rows.push(node)
      visit(node.props.children)
    }
  }
  const rawValues = [summary.min, summary.max, summary.avg, summary.max - summary.min,
    summary.std_dev, summary.std_dev * 2, summary.std_dev * 3]
  for (const numericFormat of [outputTime.DEFAULT_NUMERIC_DISPLAY_FORMAT,
    { mode: 'fixed', decimalPlaces: 0 }, { mode: 'fixed', decimalPlaces: 2 },
    { mode: 'fixed', decimalPlaces: 12 }, { mode: 'raw', decimalPlaces: 2 }]) {
    rows.length = 0
    visit(render({ summaries, outputs, numericFormat }))
    const values = rows.map(row => row.props.children[1].map(cell => cell.props.children))
    formats.forEach((format, index) => {
      assert.equal(values[index][0], 7)
      assert.deepEqual(values[index].slice(1), rawValues.map(value => outputTime.formatOutputValue(outputs[index], value, numericFormat)))
    })
    assert.deepEqual(values[4], [7, ...rawValues.map(value => outputTime.formatOutputValue(outputs[4], value, numericFormat))])
    assert.deepEqual(values[5], [1, '2.857', '2.857', '2.857', '0.000', '—', '—', '—'])
  }
  assert.deepEqual({ summaries, outputs }, before)
  assert.doesNotMatch(source, /ResultRow|Math\.sqrt|summarizePageResults/)
})

async function loadComponent(source, name, modules) {
  const React = (await import('react')).default
  const { transformWithOxc } = await import('vite')
  const { code } = await transformWithOxc(source, `${name}.tsx`, { jsx: { runtime: 'classic' } })
  const body = code.replace(/import (.+?) from "([^"]+)";/g,
    (_, names, path) => `const ${names} = modules[${JSON.stringify(path)}];`).replace(/export default /g, '')
  return new Function('React', 'modules', `${body}; return ${name}`)(React, modules)
}

function elements(node, type) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, type))
  if (!node || typeof node !== 'object' || !node.props) return []
  return [...(node.type === type ? [node] : []), ...elements(node.props.children, type)]
}

test('Last Run numeric controls update shared state and restrict Fixed to 0–12', async () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /useState<NumericDisplayFormat>\(DEFAULT_NUMERIC_DISPLAY_FORMAT\)/)
  assert.match(app, /iterationRows=\{runPageMetadata\.iteration_rows\} numericFormat=\{numericFormat\}/)
  assert.equal((app.match(/setNumericFormat\(/g) ?? []).length, 2)
  const start = app.indexOf('{runPageMetadata && runPageMetadata.row_count > 0 && <div className="numeric-display-settings">')
  const end = app.indexOf('{runPageMetadata && runPageMetadata.row_count > 0 && <PageResultSummary', start)
  assert.ok(start >= 0 && end > start)
  const render = await loadComponent(`export default function Controls({ numericFormat, setNumericFormat }) {
    const runPageMetadata = { row_count: 1 }; return <>${app.slice(start, end)}</>;
  }`, 'Controls', {})
  const { DEFAULT_NUMERIC_DISPLAY_FORMAT } = await import('../src/outputTime.ts')
  let numericFormat = DEFAULT_NUMERIC_DISPLAY_FORMAT
  const view = () => render({ numericFormat, setNumericFormat: update => { numericFormat = update(numericFormat) } })
  assert.equal(elements(view(), 'select').length, 1)
  const modeSelect = elements(view(), 'select')[0]
  assert.deepEqual(elements(modeSelect, 'option').map(option => option.props.value), ['auto', 'fixed', 'raw'])
  modeSelect.props.onChange({ target: { value: 'fixed' } })
  assert.equal(numericFormat.mode, 'fixed')
  const placesSelect = elements(view(), 'select')[1]
  assert.deepEqual(elements(placesSelect, 'option').map(option => option.props.value), Array.from({ length: 13 }, (_, i) => i))
  for (let places = 0; places <= 12; places++) {
    placesSelect.props.onChange({ target: { value: String(places) } })
    assert.equal(elements(view(), 'select')[1].props.value, places)
  }
  elements(view(), 'select')[0].props.onChange({ target: { value: 'raw' } })
  assert.equal(numericFormat.mode, 'raw')
  assert.equal(elements(view(), 'select').length, 1)
  assert.equal(numericFormat.decimalPlaces, 12)
  assert.deepEqual(DEFAULT_NUMERIC_DISPLAY_FORMAT, { mode: 'auto', decimalPlaces: 2 })
})

test('actual virtualized table reuses rows but refreshes formatted cells on mode and precision changes', async () => {
  const outputTime = await import('../src/outputTime.ts')
  const virtualRows = await import('../src/virtualRows.ts')
  const source = readFileSync(new URL('../src/VirtualizedOutputTable.tsx', import.meta.url), 'utf8')
  const outputs = [
    { type: 'output', id: 'value', name: 'value', value: { source: 'literal' } },
    { type: 'output', id: 'elapsed', name: 'elapsed', value: { source: 'elapsed-time' }, time_format: { kind: 'elapsed-time', format: 'seconds' } },
    { type: 'output', id: 'timestamp', name: 'timestamp', value: { source: 'timestamp' }, time_format: { kind: 'timestamp', include_date: false, include_utc_offset: true } },
    ...['string', 'bool', 'null', 'object', 'array'].map(name => ({ type: 'output', id: name, name, value: { source: 'literal' } })),
  ]
  const values = [10.600000000000001, 2.857, '2026-10-12T23:24:10.123+08:00', '10.600000000000001', true, null,
    { value: 10.600000000000001 }, [10.600000000000001]]
  const rows = [{ outputs: outputs.map((output, index) => ({ name: output.name, value: values[index] })) }]
  const before = structuredClone(rows)
  const response = { run_id: 1, page: 'Results', revision: 1, total_rows: 1, offset: 0, rows }
  let stateIndex = 0
  let memoDependencies
  let memoValue
  let formatCalls = 0
  const render = await loadComponent(source, 'VirtualizedOutputTable', {
    react: {
      useRef: () => ({ current: null }), useEffect: () => {}, useLayoutEffect: () => {},
      useState: () => [[0, 200, response][stateIndex++], () => {}],
      useMemo: (compute, dependencies) => {
        if (!memoDependencies || dependencies.some((value, index) => !Object.is(value, memoDependencies[index]))) {
          memoValue = compute(); memoDependencies = dependencies
        }
        return memoValue
      },
    },
    '@tauri-apps/api/core': { invoke: () => { throw new Error('Display change must not fetch rows') } },
    './outputTime': { formatOutputValue: (...args) => { formatCalls++; return outputTime.formatOutputValue(...args) } },
    './virtualRows': virtualRows,
  })
  const props = { runId: 1, page: 'Results', revision: 1, rowCount: 1, iterationRows: true, outputs }
  for (const numericFormat of [outputTime.DEFAULT_NUMERIC_DISPLAY_FORMAT,
    { mode: 'fixed', decimalPlaces: 2 }, { mode: 'fixed', decimalPlaces: 12 }, { mode: 'raw', decimalPlaces: 2 }]) {
    const view = () => { stateIndex = 0; return render({ ...props, numericFormat }) }
    const callsBefore = formatCalls
    const table = view()
    assert.deepEqual(elements(table, 'td').filter(cell => cell.props.title !== undefined).map(cell => cell.props.children),
      values.map((value, index) => outputTime.formatOutputValue(outputs[index], value, numericFormat)))
    assert.equal(formatCalls, callsBefore + outputs.length)
    view()
    assert.equal(formatCalls, callsBefore + outputs.length, 'unchanged settings retain the memo cache')
    assert.ok(elements(table, 'tr').some(row => row.props['aria-rowindex'] === 2))
  }
  assert.deepEqual(rows, before)
  assert.match(source, /\[displayWindow\?\.rows, outputs, numericFormat\]/)
})
