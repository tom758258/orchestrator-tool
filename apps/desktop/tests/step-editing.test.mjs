import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  canMoveSteps, copySteps, deleteSteps, moveSteps, pasteSteps, reconcileSelection,
  reorderSteps, selectStep, singleSelection, stepClipboardShortcut,
} from '../src/stepEditing.ts'
import { allWorkflowSteps, loopPath } from '../src/workflow.ts'

const literal = { source: 'literal', value: 1 }
const ref = step_id => ({ source: 'step-output', step_id, pointer: '/value' })
const expression = (left, right) => ({ source: 'expression', left, operator: 'add', right })
const wait = id => ({ type: 'wait', id, duration_ms: 10 })
const output = (id, page = 'Results', name = id, value = literal) => ({ type: 'output', id, name, page, value })
const loop = (id, steps) => ({ type: 'for', id, variable: 'i', range: { start: '0', stop: '2', step: '1' }, steps })
const whileLoop = (id, steps) => ({ type: 'while', id, steps, left: literal, operator: 'equal', right: literal, max_iterations: 2 })
const ids = steps => steps.map(step => step.id)
const selection = (...ids) => ({ ids, active: ids.at(-1) ?? null, anchor: ids[0] ?? null })

test('Click, Ctrl toggle and Shift range preserve sibling display order and an active step', () => {
  const steps = ['a', 'b', 'c', 'd'].map(wait)
  let selected = selectStep(steps, singleSelection(null), 'b')
  selected = selectStep(steps, selected, 'd', { ctrlKey: true })
  selected = selectStep(steps, selected, 'a', { ctrlKey: true })
  assert.deepEqual(selected, { ids: ['a', 'b', 'd'], active: 'a', anchor: 'b' })
  selected = selectStep(steps, selected, 'a', { ctrlKey: true })
  assert.deepEqual(selected, { ids: ['b', 'd'], active: 'd', anchor: 'b' })
  assert.deepEqual(selectStep(steps, selected, 'd', { shiftKey: true }),
    { ids: ['b', 'c', 'd'], active: 'd', anchor: 'b' })
  assert.deepEqual(selectStep(steps, singleSelection('d'), 'b', { shiftKey: true }),
    { ids: ['b', 'c', 'd'], active: 'b', anchor: 'd' })
  assert.deepEqual(selectStep(steps, selected, 'c'), singleSelection('c'))
  assert.deepEqual(selectStep(steps, singleSelection('b'), 'b', { ctrlKey: true }), singleSelection(null))
})

test('Ctrl and Shift across root, For and While containers replace the selection', () => {
  const steps = [wait('a'), loop('for', [wait('b'), wait('c')]), whileLoop('while', [wait('d')])]
  for (const modifiers of [{ ctrlKey: true }, { shiftKey: true }]) {
    assert.deepEqual(selectStep(steps, singleSelection('a'), 'b', modifiers), singleSelection('b'))
    assert.deepEqual(selectStep(steps, selection('b', 'c'), 'd', modifiers), singleSelection('d'))
    assert.deepEqual(selectStep(steps, singleSelection('d'), 'for', modifiers), singleSelection('for'))
  }
})

test('Up and Down move every selected sibling once, preserve order and stop at boundaries', () => {
  const steps = ['a', 'b', 'c', 'd', 'e'].map(wait)
  assert.deepEqual(ids(moveSteps(steps, ['b'], -1)), ['b', 'a', 'c', 'd', 'e'])
  assert.deepEqual(ids(moveSteps(steps, ['b', 'd'], -1)), ['b', 'a', 'd', 'c', 'e'])
  assert.deepEqual(ids(moveSteps(steps, ['b', 'd'], 1)), ['a', 'c', 'b', 'e', 'd'])
  assert.deepEqual(ids(moveSteps(steps, ['b', 'c'], -1)), ['b', 'c', 'a', 'd', 'e'])
  assert.deepEqual(ids(moveSteps(steps, ['b', 'c'], 1)), ['a', 'd', 'b', 'c', 'e'])
  for (const [selected, offset] of [[['a', 'd'], -1], [['b', 'e'], 1]]) {
    assert.equal(canMoveSteps(steps, selected, offset), false)
    assert.equal(moveSteps(steps, selected, offset), steps)
  }
})

test('Drag reorders single and non-contiguous selections before or after a sibling without changing references', () => {
  const steps = [wait('a'), output('b', 'Results', 'B', ref('a')), wait('c'), wait('d'), wait('e')]
  const before = structuredClone(steps)
  assert.deepEqual(ids(reorderSteps(steps, ['a'], 'c', true)), ['b', 'c', 'a', 'd', 'e'])
  assert.deepEqual(ids(reorderSteps(steps, ['d', 'b'], 'a', false)), ['b', 'd', 'a', 'c', 'e'])
  const reordered = reorderSteps(steps, ['b', 'd'], 'e', true)
  assert.deepEqual(ids(reordered), ['a', 'c', 'e', 'b', 'd'])
  assert.equal(reordered[3], steps[1])
  assert.deepEqual(reordered[3].value, ref('a'))
  assert.deepEqual(steps, before)
  assert.equal(reorderSteps(steps, ['b'], 'b', true), steps)
  for (const target of ['b', 'd']) {
    for (const after of [false, true]) {
      assert.equal(reorderSteps(steps, ['b', 'd'], target, after), steps)
    }
  }
})

test('Nested For and While reorder stays in the exact sibling container', () => {
  const steps = [loop('outer', [whileLoop('inner', ['a', 'b', 'c', 'd'].map(wait)), wait('e')]), wait('root')]
  const nested = reorderSteps(steps, ['a', 'c'], 'd', true)
  assert.deepEqual(ids(nested[0].steps[0].steps), ['b', 'd', 'a', 'c'])
  assert.deepEqual(ids(moveSteps(steps, ['b', 'd'], -1)[0].steps[0].steps), ['b', 'a', 'd', 'c'])
  assert.deepEqual(ids(reorderSteps(steps, ['e'], 'inner', false)[0].steps), ['e', 'inner'])
  for (const [selected, target] of [[['a'], 'root'], [['root'], 'b'], [['a'], 'e'], [['a', 'e'], 'b']]) {
    assert.equal(reorderSteps(steps, selected, target, true), steps)
  }
  assert.equal(moveSteps(steps, ['a', 'e'], 1), steps)
})

test('Copy snapshots are isolated; each Paste creates fresh recursive IDs and selects inserted top-level steps', () => {
  const steps = [loop('for', [whileLoop('while', [wait('child')])]), wait('tail')]
  const snapshot = copySteps(steps, singleSelection('for'))
  steps[0].steps[0].steps[0].duration_ms = 99
  assert.equal(snapshot[0].steps[0].steps[0].duration_ms, 10)
  const first = pasteSteps(steps, snapshot, singleSelection('for'))
  assert.deepEqual(ids(first.steps), ['for', 'for-copy', 'tail'])
  assert.deepEqual(first.selection, singleSelection('for-copy'))
  assert.deepEqual(ids(allWorkflowSteps(first.steps[1].steps)), ['while-copy', 'child-copy'])
  const second = pasteSteps(first.steps, snapshot, first.selection)
  assert.deepEqual(ids(second.steps), ['for', 'for-copy', 'for-copy-2', 'tail'])
  const allIds = ids(allWorkflowSteps(second.steps))
  assert.equal(new Set(allIds).size, allIds.length)
  assert.ok(allIds.every(id => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)))
  const afterDeletion = pasteSteps(steps, snapshot, singleSelection(null), new Set(allIds))
  assert.equal(afterDeletion.selection.active, 'for-copy-3')
  assert.equal(afterDeletion.steps.at(-1).steps[0].steps[0].id, 'child-copy-3')
  second.steps[2].steps[0].steps[0].duration_ms = 200
  assert.equal(snapshot[0].steps[0].steps[0].duration_ms, 10)
})

test('Paste uses the last selected sibling, exact nested container, or root end', () => {
  const steps = [wait('a'), wait('b'), loop('for', [wait('child')]), wait('d')]
  const snapshot = [wait('x'), wait('y')]
  const multiple = pasteSteps(steps, snapshot, selection('a', 'b'))
  assert.deepEqual(ids(multiple.steps), ['a', 'b', 'x-copy', 'y-copy', 'for', 'd'])
  assert.deepEqual(multiple.selection, { ids: ['x-copy', 'y-copy'], active: 'y-copy', anchor: 'x-copy' })
  assert.deepEqual(ids(pasteSteps(steps, snapshot, singleSelection('child')).steps[2].steps), ['child', 'x-copy', 'y-copy'])
  assert.deepEqual(ids(pasteSteps(steps, snapshot, singleSelection(null)).steps), ['a', 'b', 'for', 'd', 'x-copy', 'y-copy'])
})

test('Two-pass clone remaps every formal value, operand and binding while preserving external and arbitrary JSON references', () => {
  const tool = {
    type: 'tool-action', id: 'tool', target: 'meter', action: 'measure',
    arguments: { step_id: 'tool', nested: ref('tool') },
    bindings: { direct: ref('later'), calculated: expression(ref('tool'), ref('external')), literal },
  }
  const snapshot = [
    tool,
    { type: 'set-variable', id: 'set', variable: 'x', value: ref('tool') },
    { type: 'set-variable', id: 'calc', variable: 'y', value: expression(ref('tool'), ref('external')) },
    { type: 'assert', id: 'assert', left: ref('tool'), operator: 'equal', right: ref('later'), message: 'check' },
    loop('for', [whileLoop('while', [output('out', 'Loop', 'Reading', expression(ref('tool'), ref('external')))])]),
    output('later', 'Results', 'Later', ref('tool')),
  ]
  snapshot[4].steps[0].left = ref('tool')
  snapshot[4].steps[0].right = ref('external')
  const cloned = pasteSteps([wait('external')], snapshot, singleSelection(null)).steps.slice(1)
  const byId = Object.fromEntries(allWorkflowSteps(cloned).map(step => [step.id, step]))
  assert.deepEqual(byId['tool-copy'].arguments, tool.arguments)
  assert.deepEqual(byId['tool-copy'].bindings.direct, ref('later-copy'))
  assert.deepEqual(byId['tool-copy'].bindings.calculated, expression(ref('tool-copy'), ref('external')))
  assert.deepEqual(byId['set-copy'].value, ref('tool-copy'))
  assert.deepEqual(byId['calc-copy'].value, expression(ref('tool-copy'), ref('external')))
  assert.deepEqual(byId['later-copy'].value, ref('tool-copy'))
  assert.deepEqual(byId['out-copy'].value, expression(ref('tool-copy'), ref('external')))
  assert.deepEqual(byId['assert-copy'].left, ref('tool-copy'))
  assert.deepEqual(byId['assert-copy'].right, ref('later-copy'))
  assert.deepEqual(byId['while-copy'].left, ref('tool-copy'))
  assert.deepEqual(byId['while-copy'].right, ref('external'))
  assert.deepEqual(snapshot[0].bindings.direct, ref('later'))
})

test('Output names are unique on repeated Paste and unchanged when no collision exists', () => {
  const steps = [output('out', 'Results', 'Voltage'), output('other', 'Results', 'Voltage Copy')]
  const first = pasteSteps(steps, [steps[0]], singleSelection('out'))
  assert.equal(first.steps[1].name, 'Voltage Copy 2')
  const second = pasteSteps(first.steps, [steps[0]], first.selection)
  assert.equal(second.steps[2].name, 'Voltage Copy 3')
  assert.equal(pasteSteps([], [steps[0]], singleSelection(null)).steps[0].name, 'Voltage')
  assert.equal(first.steps[1].page, 'Results')
})

test('Copied loop Outputs share a new compatible Page; names obey length and case-insensitive uniqueness', () => {
  const page = '測'.repeat(31)
  const steps = [loop('for', [output('one', page), output('two', page)]), output('reserved', 'Results Copy')]
  const first = pasteSteps(steps, [steps[0]], singleSelection('for'))
  const copied = first.steps[1].steps
  const newPage = copied[0].page
  assert.equal(newPage, '測'.repeat(26) + ' Copy')
  assert.equal(copied[1].page, newPage)
  assert.equal(Array.from(newPage).length, 31)
  assert.deepEqual(loopPath(first.steps, copied[0].id).map(step => step.id), ['for-copy'])
  const second = pasteSteps(first.steps, [steps[0]], first.selection)
  assert.equal(second.steps[2].steps[0].page, '測'.repeat(24) + ' Copy 2')
  assert.equal(second.steps[2].steps[1].page, second.steps[2].steps[0].page)
  const caseConflict = pasteSteps([output('existing', 'results')], [output('new', 'Results')], singleSelection(null))
  assert.equal(caseConflict.steps[1].page, 'Results Copy')
  const sameScope = pasteSteps(steps, [steps[0].steps[0]], singleSelection('two'))
  assert.equal(sameScope.steps[0].steps[2].page, page)
  const otherScope = pasteSteps(steps, [steps[0].steps[0], steps[0].steps[1]], singleSelection(null))
  assert.equal(otherScope.steps.at(-2).page, newPage)
  assert.equal(otherScope.steps.at(-1).page, newPage)
})

test('Delete, Clear and replacement reconcile IDs, primary step and Shift anchor', () => {
  const steps = [wait('a'), loop('for', [wait('b'), wait('c')]), wait('d')]
  const remaining = deleteSteps(steps, ['for'])
  assert.deepEqual(reconcileSelection(remaining, selection('b', 'c')), singleSelection(null))
  assert.deepEqual(ids(deleteSteps(steps, ['a', 'd'])), ['for'])
  assert.deepEqual(reconcileSelection(deleteSteps(steps, ['b']), selection('b', 'c')), singleSelection('c'))
  assert.deepEqual(reconcileSelection([], selection('a', 'd')), singleSelection(null))
  assert.deepEqual(reconcileSelection([wait('d')], selection('a', 'd')), singleSelection('d'))
  assert.deepEqual(reconcileSelection(steps, selection('a', 'b', 'd')).ids, ['a', 'd'])
})

test('Clipboard shortcuts are confined to Workflow and preserve native editable controls', () => {
  const event = { ctrlKey: true, altKey: false, shiftKey: false, key: 'c' }
  assert.equal(stepClipboardShortcut(event, true, false), 'copy')
  assert.equal(stepClipboardShortcut({ ...event, key: 'V' }, true, false), 'paste')
  assert.equal(stepClipboardShortcut(event, false, false), null)
  assert.equal(stepClipboardShortcut(event, true, true), null)
  assert.equal(stepClipboardShortcut({ ...event, ctrlKey: false }, true, false), null)
  assert.equal(stepClipboardShortcut({ ...event, key: 'x' }, true, false), null)
  const source = readFileSync(new URL('../src/stepEditing.ts', import.meta.url), 'utf8')
  class Element {
    constructor(control = false, editable = false) { this.control = control; this.isContentEditable = editable }
    closest() { return this.control ? this : null }
  }
  class HTMLElement extends Element {}
  const guard = runInNewContext(stripTypeScriptTypes('(' + source.slice(source.indexOf('export function isEditableTarget') + 7) + ')'), { Element, HTMLElement })
  for (const control of ['input', 'textarea', 'select']) assert.equal(guard(new HTMLElement(control)), true)
  assert.equal(guard(new HTMLElement(false, true)), true)
  const descendant = new Element()
  descendant.parentElement = new HTMLElement(false, true)
  assert.equal(guard(descendant), true)
  assert.equal(guard(new HTMLElement()), false)
  assert.equal(guard(null), false)
})

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
function callback(name, next, context) {
  const start = app.indexOf(`  const ${name} = useCallback(`)
  const declaration = app.slice(start, app.indexOf(`  const ${next} =`, start))
  const body = declaration.slice(declaration.indexOf('\n    (') + 5, declaration.lastIndexOf('\n    },') + 6)
  return runInNewContext(stripTypeScriptTypes('(' + body + ')'), context)
}

test('App Delete acts on the selection only for a selected row; busy mutations are blocked', () => {
  const original = ['a', 'b', 'c', 'd'].map(wait)
  const selected = selection('b', 'd')
  for (const [target, expected] of [['b', ['a', 'c']], ['c', ['a', 'b', 'd']]]) {
    let steps = original
    let current = selected
    const context = {
      workflowDraft: { workflow: { steps } }, selection: selected,
      stepEditingBusyRef: { current: false }, runInFlightRef: { current: false },
      updateSteps: update => { steps = update(steps) },
      setStepSelection: update => { current = update(current) }, deleteSteps, reconcileSelection,
    }
    const remove = callback('deleteStep', 'clearWorkflow', context)
    remove(target)
    assert.deepEqual(ids(steps), expected)
    assert.deepEqual(current.ids, target === 'b' ? [] : selected.ids)
    context.stepEditingBusyRef.current = true
    remove('a')
    assert.deepEqual(ids(steps), expected)
  }
})

test('App move and drag callbacks reject busy, boundary and cross-container mutations', () => {
  const original = [wait('a'), wait('b'), wait('c'), loop('for', [wait('child')])]
  let steps = original
  let updates = 0
  const context = {
    workflowDraft: { workflow: { steps } }, selection: selection('b', 'c'),
    stepEditingBusyRef: { current: false }, runInFlightRef: { current: false },
    canMoveSteps, moveSteps, reorderSteps,
    updateSteps: update => { steps = update(steps); context.workflowDraft.workflow.steps = steps; updates++ },
  }
  const move = callback('moveStep', 'reorderStep', context)
  const start = app.indexOf('  const reorderStep = useCallback(')
  const declaration = app.slice(start, app.indexOf('  function handleStepClipboard', start))
  const body = declaration.slice(declaration.indexOf('useCallback(') + 'useCallback('.length, declaration.lastIndexOf('},') + 1)
  const reorder = runInNewContext(stripTypeScriptTypes('(' + body + ')'), context)
  reorder(['b'], 'child', true)
  reorder(['b'], 'b', false)
  context.selection = singleSelection('a')
  move('a', -1)
  assert.equal(updates, 0)
  for (const guard of [context.stepEditingBusyRef, context.runInFlightRef]) {
    guard.current = true
    move('b', -1)
    reorder(['b'], 'a', false)
    assert.equal(updates, 0)
    guard.current = false
  }
  context.selection = selection('b', 'c')
  move('b', -1)
  assert.deepEqual(ids(steps), ['b', 'c', 'a', 'for'])
  reorder(['b', 'c'], 'for', true)
  assert.deepEqual(ids(steps), ['a', 'for', 'b', 'c'])
})

test('App Copy remains available while busy; Paste is guarded and selects fresh copies', () => {
  const steps = ['a', 'b', 'c'].map(wait)
  const context = {
    workflowDraft: { workflow: { steps } }, selection: selection('a', 'b'), activeTab: 'workflow',
    stepEditingBusyRef: { current: true }, runInFlightRef: { current: false },
    stepClipboardRef: { current: [] }, pastedStepIdsRef: { current: new Set() },
    stepClipboardShortcut, isEditableTarget: target => target === 'input', copySteps, pasteSteps, allWorkflowSteps,
    updateSteps: update => { context.workflowDraft.workflow.steps = update(context.workflowDraft.workflow.steps) },
    setStepSelection: next => { context.selection = next },
  }
  const start = app.indexOf('  function handleStepClipboard(')
  const body = app.slice(start, app.indexOf('  const validateDraft =', start))
  const shortcut = runInNewContext(stripTypeScriptTypes('(' + body + ')'), context)
  const event = key => ({ key, ctrlKey: true, altKey: false, shiftKey: false, target: 'card', preventDefault() { this.prevented = true } })
  const copy = event('c')
  shortcut(copy)
  assert.equal(copy.prevented, true)
  assert.deepEqual(ids(context.stepClipboardRef.current), ['a', 'b'])
  const busyPaste = event('v')
  shortcut(busyPaste)
  assert.deepEqual(ids(context.workflowDraft.workflow.steps), ['a', 'b', 'c'])
  context.stepEditingBusyRef.current = false
  context.runInFlightRef.current = true
  shortcut(event('v'))
  assert.deepEqual(ids(context.workflowDraft.workflow.steps), ['a', 'b', 'c'])
  context.runInFlightRef.current = false
  const nativePaste = { ...event('v'), target: 'input' }
  shortcut(nativePaste)
  assert.equal(nativePaste.prevented, undefined)
  shortcut(event('v'))
  assert.deepEqual(context.selection.ids, ['a-copy', 'b-copy'])
  shortcut(event('v'))
  assert.deepEqual(context.selection.ids, ['a-copy-2', 'b-copy-2'])
  assert.deepEqual(ids(context.workflowDraft.workflow.steps), ['a', 'b', 'a-copy', 'b-copy', 'a-copy-2', 'b-copy-2', 'c'])
})
