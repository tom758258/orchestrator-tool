import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compatibleOutputPages, hasExportableRows } from '../src/workflow.ts'

const literal = { source: 'literal', value: 1 }
const output = (id, page) => ({ type: 'output', id, name: id, page, value: literal })
const loop = (id, steps) => ({
  type: 'for', id, variable: id, range: { start: '1', stop: '1', step: '1' }, steps,
})

test('compatible Output Pages use the complete loop path', () => {
  const steps = [
    loop('outer', [
      loop('left', [output('selected', 'Page A'), output('same-scope', 'Page B')]),
      loop('right', [output('same-depth', 'Page C')]),
    ]),
  ]

  assert.deepEqual(compatibleOutputPages(steps, 'selected'), ['Page A', 'Page B'])
})

test('export row gating distinguishes Current Page from All Pages', () => {
  const rows = [{ page: 'Outer', outputs: [], for_iteration: null, while_iteration: null }]

  assert.equal(hasExportableRows(rows, 'Inner', false), false)
  assert.equal(hasExportableRows(rows, 'Inner', true), true)
})
