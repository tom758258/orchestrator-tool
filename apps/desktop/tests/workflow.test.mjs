import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compatibleOutputPages, enclosingForVariables, outputPageContext } from '../src/workflow.ts'

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

test('Last Run Page definitions come from the run snapshot', () => {
  const runSteps = [{ ...output('run-output', 'Results'), name: 'Voltage' }]
  const currentSteps = [{ ...output('current-output', 'Measurements'), name: 'Current' }]
  const runContext = outputPageContext(runSteps, 'Results')
  const currentContext = outputPageContext(currentSteps, 'Measurements')
  assert.deepEqual(runContext.pages.map(page => page.name), ['Results'])
  assert.deepEqual(runContext.outputs.map(item => item.name), ['Voltage'])
  assert.equal(runContext.page.name, 'Results')
  assert.deepEqual(currentContext.pages.map(page => page.name), ['Measurements'])
  assert.deepEqual(currentContext.outputs.map(item => item.name), ['Current'])
})


test('nested Set Variable validation can see every enclosing For variable', () => {
  const steps = [
    loop('outer', [{
      type: 'while', id: 'middle', left: literal, operator: 'less-than', right: literal,
      max_iterations: 2, steps: [loop('inner', [{ type: 'set-variable', id: 'set', variable: 'outer', value: literal }])],
    }]),
  ]
  assert.deepEqual(enclosingForVariables(steps, 'set'), ['outer', 'inner'])
})
