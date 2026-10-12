import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'

test('Page Result Summary consumes Rust metadata without scanning ResultRows', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const component = readFileSync(new URL('../src/PageResultSummary.tsx', import.meta.url), 'utf8')
  assert.match(app, /<PageResultSummary summaries=\{runPageMetadata\.summaries\} outputs=\{runOutputs\} \/>/)
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
  const summary = { count: 7, min: 2.857, max: 90061.123, avg: 45031.990123456, std_dev: 60.123456789 }
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
  visit(render({ summaries, outputs }))
  const values = rows.map(row => row.props.children[1].map(cell => cell.props.children))
  const rawValues = [summary.min, summary.max, summary.avg, summary.max - summary.min,
    summary.std_dev, summary.std_dev * 2, summary.std_dev * 3]
  formats.forEach((format, index) => {
    assert.equal(values[index][0], 7)
    assert.deepEqual(values[index].slice(1), rawValues.map(value => outputTime.formatOutputValue(outputs[index], value)))
  })
  assert.deepEqual(values[4], [7, ...rawValues])
  assert.deepEqual(values[5], [1, '2.857', '2.857', '2.857', '0.000', '—', '—', '—'])
  assert.deepEqual({ summaries, outputs }, before)
  assert.doesNotMatch(source, /ResultRow|Math\.sqrt|summarizePageResults/)
})
