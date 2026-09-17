import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

// Exercise the actual component callback without a WebView runtime.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const start = source.indexOf('  const clearWorkflow = useCallback(')
const end = source.indexOf('\n  const updateStep =', start)
assert.ok(start >= 0 && end > start, 'Clear Workflow callback boundaries exist')
const declaration = source.slice(start, end)
const callback = declaration.slice(declaration.indexOf('async () =>'), declaration.lastIndexOf('}, [') + 1)
const code = stripTypeScriptTypes('(' + callback + ')')

function harness(approved) {
  const original = {
    schema_version: 1,
    name: 'Bench workflow',
    tool_instances: [{
      id: 'meter-1',
      tool: 'meters',
      setup: {
        measurement: 'voltage-dc',
        range_mode: 'auto',
        manual_range: null,
        nplc: 1,
        auto_zero: 'on',
        dcv_input_impedance: null,
        current_terminal: null,
      },
    }],
    workflow: {
      steps: [
        { type: 'set-variable', id: 'set-threshold', variable: 'threshold', value: { source: 'literal', value: 4.5 } },
        {
          type: 'for', id: 'for-1', variable: 'index', range: { start: '0', stop: '2', step: '1' },
          steps: [
            { type: 'tool-action', id: 'measure-1', target: 'meter-1', action: 'measure', arguments: {} },
            { type: 'output', id: 'output-1', name: 'reading', page: 'Results', value: { source: 'step-output', step_id: 'measure-1', pointer: '/value' } },
          ],
        },
        {
          type: 'while', id: 'while-1', left: { source: 'variable', variable: 'threshold' }, operator: 'greater-than',
          right: { source: 'literal', value: 0 }, max_iterations: 2,
          steps: [{ type: 'wait', id: 'wait-1', duration_ms: 10 }],
        },
      ],
    },
  }
  let draft = structuredClone(original)
  let selectedStepId = 'output-1'
  const confirmations = []
  const context = {
    workflowDraft: draft,
    confirm(message, options) {
      confirmations.push({ message, options })
      return Promise.resolve(approved)
    },
    updateSteps(update) {
      draft = { ...draft, workflow: { ...draft.workflow, steps: update(draft.workflow.steps) } }
    },
    setSelectedStepId(value) { selectedStepId = value },
  }
  return {
    clear: runInNewContext(code, context),
    state: () => ({ draft, selectedStepId, confirmations }),
    original,
  }
}

test('Cancel leaves the workflow, tool instances, and their Setup unchanged', async () => {
  const h = harness(false)
  await h.clear()

  assert.deepEqual(h.state().draft, h.original)
  assert.equal(h.state().selectedStepId, 'output-1')
  assert.equal(h.state().confirmations.length, 1)
})

test('Confirm clears all steps including set-variable while preserving tool instances and their Setup', async () => {
  const h = harness(true)
  await h.clear()

  const { draft, selectedStepId, confirmations } = h.state()
  assert.equal(draft.workflow.steps.length, 0)
  assert.deepEqual(draft.tool_instances, h.original.tool_instances)
  assert.equal(draft.name, h.original.name)
  assert.equal(draft.schema_version, h.original.schema_version)
  assert.equal(selectedStepId, null)
  assert.equal(confirmations.length, 1)
  assert.equal(confirmations[0].message, 'Clear all workflow steps?\n\nThis action cannot be undone.')
  assert.equal(JSON.stringify(confirmations[0].options), JSON.stringify({
    title: 'Clear Workflow', kind: 'warning', okLabel: 'Clear', cancelLabel: 'Cancel',
  }))
})
