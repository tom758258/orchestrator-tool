import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canMoveSteps, canRelocateSteps, copySteps, deleteSteps, moveSteps, pasteSteps, reconcileSelection, relocateSteps, selectAllSteps,
  reorderSteps, renameStepId, selectStep, singleSelection, stepClipboardShortcut,
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

test('Nested For and While reorder preserves the destination sibling container', () => {
  const steps = [loop('outer', [whileLoop('inner', ['a', 'b', 'c', 'd'].map(wait)), wait('e')]), wait('root')]
  const nested = reorderSteps(steps, ['a', 'c'], 'd', true)
  assert.deepEqual(ids(nested[0].steps[0].steps), ['b', 'd', 'a', 'c'])
  assert.deepEqual(ids(moveSteps(steps, ['b', 'd'], -1)[0].steps[0].steps), ['b', 'a', 'd', 'c'])
  assert.deepEqual(ids(reorderSteps(steps, ['e'], 'inner', false)[0].steps), ['e', 'inner'])
  assert.deepEqual(ids(reorderSteps(steps, ['a'], 'root', true)), ['outer', 'root', 'a'])
  assert.deepEqual(ids(reorderSteps(steps, ['root'], 'b', true)[0].steps[0].steps), ['a', 'b', 'root', 'c', 'd'])
  assert.equal(reorderSteps(steps, ['a', 'e'], 'b', true), steps)
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
    { type: 'bg-interaction', id: 'send', background_id: 'bg', operation: { kind: 'command', command: 'software-trigger', wait_for_completion: false } },
    { type: 'bg-interaction', id: 'result', background_id: 'bg', operation: { kind: 'get-command-result', source_step: 'send' } },
    { type: 'bg-interaction', id: 'external-result', background_id: 'bg', operation: { kind: 'get-command-result', source_step: 'external-command' } },
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
  assert.equal(byId['result-copy'].operation.source_step, 'send-copy')
  assert.equal(byId['external-result-copy'].operation.source_step, 'external-command')
  assert.equal(snapshot[7].operation.source_step, 'send')
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
  for (const [key, action] of [['x', 'cut'], ['a', 'select-all']]) {
    assert.equal(stepClipboardShortcut({ ...event, key }, true, false), action)
    assert.equal(stepClipboardShortcut({ ...event, key }, true, true), null)
  }
  assert.equal(stepClipboardShortcut({ ...event, key: 'Delete', ctrlKey: false }, true, false), 'delete')
  assert.equal(stepClipboardShortcut({ ...event, key: 'Delete', ctrlKey: false }, false, false), null)

})


test('Cross-level moves preserve non-contiguous order, values and complete subtrees without duplicating ancestors', () => {
  const tool = { type: 'tool-action', id: 'tool', target: 'meter', action: 'measure',
    arguments: { channel: 1 }, bindings: { voltage: ref('external') } }
  const steps = [wait('external'), tool, wait('gap'), output('out', 'Results', 'Reading', ref('tool')),
    loop('for', [whileLoop('while', [])]), wait('tail')]
  const original = structuredClone(steps)
  const moved = relocateSteps(steps, ['out', 'tool'], 'while', 0)
  assert.deepEqual(ids(moved), ['external', 'gap', 'for', 'tail'])
  assert.deepEqual(moved[2].steps[0].steps, [tool, steps[3]])
  assert.deepEqual(reconcileSelection(moved, selection('tool', 'out')), selection('tool', 'out'))
  const root = relocateSteps(moved, ['tool', 'out'], null, 4)
  assert.deepEqual(ids(root), ['external', 'gap', 'for', 'tail', 'tool', 'out'])
  assert.deepEqual(root[2].steps[0].steps, [])
  const forBody = relocateSteps(moved, ['tool', 'out'], 'for', 0)
  assert.deepEqual(ids(forBody[2].steps), ['tool', 'out', 'while'])
  assert.deepEqual(forBody[2].steps[2].steps, [])
  const withLoop = relocateSteps(steps, ['for'], null, 0)
  assert.deepEqual(withLoop[0], steps[4])
  assert.deepEqual(steps, original)
  assert.equal(new Set(ids(allWorkflowSteps(root))).size, allWorkflowSteps(root).length)
})

test('Cross-level drops reject self, descendants, mixed selections and depth beyond eight', () => {
  const deep = loop('one', [whileLoop('two', [loop('three', [whileLoop('four', [loop('five', [])])])])])
  const steps = [deep, loop('moving', [wait('child')])]
  for (const parent of ['moving', 'child', 'missing']) {
    assert.equal(canRelocateSteps(steps, ['moving'], parent), false)
    assert.equal(relocateSteps(steps, ['moving'], parent, 0), steps)
  }
  assert.equal(canRelocateSteps(steps, ['one'], 'two'), false)
  assert.equal(canRelocateSteps(steps, ['moving', 'child'], null), false)
  assert.equal(canRelocateSteps(steps, ['moving'], 'four'), true)
  assert.equal(canRelocateSteps(steps, ['moving'], 'five'), true)
  assert.equal(canRelocateSteps(steps, ['child'], 'five'), true)
})

test('Cut paste preserves IDs and references once, then follows copy conflict rules', () => {
  const source = [wait('tool'), output('out', 'Results', 'Reading', ref('tool'))]
  const clipboard = copySteps(source, selection('tool', 'out'))
  const removed = deleteSteps(source, ['tool', 'out'])
  const moved = pasteSteps(removed, clipboard, singleSelection(null), new Set(['tool', 'out']), true)
  assert.deepEqual(moved.steps, source)
  const repeated = pasteSteps(moved.steps, clipboard, moved.selection)
  assert.deepEqual(ids(repeated.steps), ['tool', 'out', 'tool-copy', 'out-copy'])
  assert.equal(repeated.steps[3].name, 'Reading Copy')
  assert.deepEqual(repeated.steps[3].value, ref('tool-copy'))
  const conflict = pasteSteps([wait('tool'), output('existing', 'Results', 'Reading')], clipboard, singleSelection(null), new Set(), true)
  assert.deepEqual(ids(conflict.steps).slice(2), ['tool-copy', 'out-copy'])
  assert.equal(conflict.steps[3].name, 'Reading Copy')
  assert.deepEqual(conflict.steps[3].value, ref('tool-copy'))
})

test('Select all uses direct siblings and preserves the active step and Shift anchor', () => {
  const steps = [wait('root'), loop('for', [wait('a'), wait('b'), whileLoop('while', [wait('c')])])]
  assert.deepEqual(selectAllSteps(steps, singleSelection(null)), { ids: ['root', 'for'], active: 'root', anchor: 'root' })
  assert.deepEqual(selectAllSteps(steps, selection('a', 'b')), { ids: ['a', 'b', 'while'], active: 'b', anchor: 'a' })
  assert.deepEqual(selectAllSteps(steps, singleSelection('c')), singleSelection('c'))
  assert.deepEqual(selectAllSteps([], singleSelection(null)), singleSelection(null))
})

test('THEN and ELSE are separate editable containers with isolated selection and relocation', () => {
  const ifStep = { type: 'if', id: 'choose', left: literal, operator: 'equal', right: literal,
    then_steps: [wait('yes')], else_steps: [wait('no')] }
  const steps = [ifStep, wait('root')]
  assert.deepEqual(selectStep(steps, singleSelection('yes'), 'no', { ctrlKey: true }), singleSelection('no'))
  assert.equal(canRelocateSteps(steps, ['root'], 'choose', 'else'), true)
  assert.equal(canRelocateSteps(steps, ['root'], 'choose'), false)
  const relocated = relocateSteps(steps, ['root'], 'choose', 1, 'else')
  assert.deepEqual(relocated[0].then_steps.map(step => step.id), ['yes'])
  assert.deepEqual(relocated[0].else_steps.map(step => step.id), ['no', 'root'])
  const selectedIf = pasteSteps(relocated, [wait('new')], singleSelection('choose'), new Set(), false, 'else')
  assert.deepEqual(selectedIf.steps[0].else_steps.map(step => step.id), ['no', 'root', 'new-copy'])
  const copiedIf = copySteps(steps, singleSelection('choose'))
  const pasted = pasteSteps(steps, copiedIf, singleSelection(null))
  assert.deepEqual(pasted.steps[2].then_steps.map(step => step.id), ['yes-copy'])
  assert.deepEqual(pasted.steps[2].else_steps.map(step => step.id), ['no-copy'])
})

test('Eight nested controls are allowed while a ninth is blocked', () => {
  let nested = loop('level-8', [wait('leaf')])
  for (let level = 7; level >= 1; level--) nested = loop(`level-${level}`, [nested])
  const steps = [nested, loop('moving', [wait('other')])]
  assert.equal(canRelocateSteps(steps, ['moving'], 'level-7'), true)
  assert.equal(canRelocateSteps(steps, ['moving'], 'level-8'), false)
})

test('Copying nested Serial commands remaps TX bindings and Get Result sources', () => {
  const source = loop('serial-loop', [
    output('value'),
    { type: 'bg-interaction', id: 'send', background_id: 'serial', timeout_ms: null,
      operation: { kind: 'command', command: 'serial-send', wait_for_completion: false,
        arguments: { tx_format: 'hex-byte' }, bindings: { tx_value: expression(ref('value'), literal) } } },
    { type: 'bg-interaction', id: 'get', background_id: 'serial', timeout_ms: null,
      operation: { kind: 'get-command-result', source_step: 'send' } },
  ])
  const pasted = pasteSteps([source], copySteps([source], selection('serial-loop')), singleSelection(null))
  const body = pasted.steps[1].steps
  assert.deepEqual(body[1].operation.bindings.tx_value, expression(ref('value-copy'), literal))
  assert.equal(body[2].operation.source_step, 'send-copy')
  assert.deepEqual(source.steps[1].operation.bindings.tx_value, expression(ref('value'), literal))
})

test('Step ID rename rejects missing, invalid, or duplicate IDs without changing the draft', () => {
  const steps = [wait('first'), loop('outer', [wait('nested')])]
  const original = structuredClone(steps)
  for (const [oldId, newId, error] of [
    ['absent', 'new-id', 'not-found'], ['first', '', 'invalid'], ['first', 'Bad ID', 'invalid'],
    ['first', 'bad--id', 'invalid'], ['first', 'outer', 'duplicate'], ['first', 'nested', 'duplicate'],
  ]) {
    const result = renameStepId(steps, oldId, newId)
    assert.equal(result.error, error)
    assert.equal(result.steps, steps)
  }
  assert.equal(renameStepId(steps, 'first', 'first').steps, steps)
  assert.deepEqual(steps, original)
})

test('Step ID rename updates nested typed references and leaves other IDs and literals intact', () => {
  const bg = { type: 'bg-interaction', id: 'send', background_id: 'background-1', timeout_ms: null,
    operation: { kind: 'command', command: 'serial-send', wait_for_completion: false,
      arguments: { tx_value: 'send' }, bindings: { tx_value: expression(ref('send'), ref('other')) } } }
  const steps = [
    bg,
    { type: 'bg-interaction', id: 'result', background_id: 'background-1', timeout_ms: null,
      operation: { kind: 'get-command-result', source_step: 'send' } },
    { type: 'tool-action', id: 'tool', target: 'meter', action: 'measure', arguments: { text: 'send' },
      bindings: { direct: ref('send'), calculated: expression(ref('send'), ref('other')) } },
    { type: 'set-variable', id: 'variable', variable: 'send', value: expression(ref('send'), literal) },
    output('published', 'Results', 'send', ref('send')),
    { type: 'assert', id: 'check', left: ref('send'), right: { source: 'literal', value: 'send' },
      operator: 'equal', message: 'send' },
    { type: 'show-message', id: 'message', target: 'message-1', fields: [
      { kind: 'output', step_id: 'send', pointer: '/value', newline: true },
      { kind: 'text', text: 'send', newline: false },
    ] },
    loop('outer', [
      { type: 'while', id: 'while', left: ref('send'), right: ref('other'),
        operator: 'equal', max_iterations: 1, steps: [wait('nested')] },
      { type: 'if', id: 'choose', left: ref('send'), right: ref('other'),
        operator: 'equal', then_steps: [output('in-then', 'Results', 'then', ref('send'))],
        else_steps: [output('in-else', 'Results', 'else', ref('other'))] },
    ]),
  ]
  const snapshot = structuredClone(steps)
  const { steps: renamed, error } = renameStepId(steps, 'send', 'send-new')
  assert.equal(error, null)
  const byId = Object.fromEntries(allWorkflowSteps(renamed).map(step => [step.id, step]))
  assert.equal(byId['send-new'].operation.arguments.tx_value, 'send')
  assert.deepEqual(byId['send-new'].operation.bindings.tx_value, expression(ref('send-new'), ref('other')))
  assert.equal(byId.result.operation.source_step, 'send-new')
  assert.deepEqual(byId.tool.bindings.direct, ref('send-new'))
  assert.deepEqual(byId.tool.bindings.calculated, expression(ref('send-new'), ref('other')))
  assert.equal(byId.tool.arguments.text, 'send')
  assert.equal(byId.variable.variable, 'send')
  assert.deepEqual(byId.variable.value, expression(ref('send-new'), literal))
  assert.equal(byId.published.name, 'send')
  assert.deepEqual(byId.published.value, ref('send-new'))
  assert.deepEqual(byId.check.left, ref('send-new'))
  assert.equal(byId.check.right.value, 'send')
  assert.equal(byId.check.message, 'send')
  assert.equal(byId.message.fields[0].step_id, 'send-new')
  assert.equal(byId.message.fields[1].text, 'send')
  assert.deepEqual(byId.while.left, ref('send-new'))
  assert.deepEqual(byId.choose.left, ref('send-new'))
  assert.deepEqual(byId['in-then'].value, ref('send-new'))
  assert.deepEqual(byId['in-else'].value, ref('other'))
  assert.deepEqual(steps, snapshot, 'input workflow must not be mutated')

  const nested = renameStepId(renamed, 'nested', 'nested-new')
  assert.equal(nested.error, null)
  assert.ok(allWorkflowSteps(nested.steps).some(step => step.id === 'nested-new'))
  assert.ok(!allWorkflowSteps(nested.steps).some(step => step.id === 'nested'))
})

test('Process arguments retain literal data and remap typed references on rename and copy', () => {
  const steps = [
    { type: 'string-process', id: 'text', operation: 'length', arguments: {
      input: { source: 'literal', value: 'text' },
    } },
    { type: 'byte-process', id: 'byte', operation: { kind: 'get-byte' }, arguments: {
      input: { source: 'literal', value: 'AA01' }, byte_index: ref('text'),
    } },
    { type: 'string-process', id: 'concat', operation: 'concat', arguments: {
      input: { source: 'variable', variable: 'text' }, append: ref('byte'),
    } },
  ]
  const renamed = renameStepId(steps, 'text', 'length').steps
  assert.deepEqual(renamed[1].arguments.byte_index, ref('length'))
  assert.deepEqual(renamed[0].arguments.input, { source: 'literal', value: 'text' })
  assert.deepEqual(renamed[2].arguments.input, { source: 'variable', variable: 'text' })
  const pasted = pasteSteps(renamed, copySteps(renamed, selection('length', 'byte', 'concat')), singleSelection(null)).steps.slice(3)
  assert.deepEqual(pasted[1].arguments.byte_index, ref(pasted[0].id))
  assert.deepEqual(pasted[2].arguments.append, ref(pasted[1].id))
  assert.deepEqual(pasted[0].arguments.input, { source: 'literal', value: 'text' })
})

test('Buffer Count and Array references are remapped with copied and renamed Steps', () => {
  const steps = [
    { type: 'bg-interaction', id: 'status', background_id: 'bg', timeout_ms: null, operation: { kind: 'get-buffer-status' } },
    { type: 'bg-interaction', id: 'batch', background_id: 'bg', timeout_ms: null, operation: { kind: 'get-buffer-data', read_mode: 'pop', selection: { kind: 'count', count: { source: 'step-output', step_id: 'status', pointer: '/count' } } } },
    { type: 'array-process', id: 'item', operation: 'get-item', arguments: { input: { source: 'step-output', step_id: 'batch', pointer: '/data' }, index: literal } },
  ]
  const renamed = renameStepId(steps, 'status', 'buffer-status').steps
  assert.equal(renamed[1].operation.selection.count.step_id, 'buffer-status')
  const pasted = pasteSteps(renamed, copySteps(renamed, selection('buffer-status', 'batch', 'item')), singleSelection(null)).steps.slice(3)
  assert.equal(pasted[1].operation.selection.count.step_id, pasted[0].id)
  assert.equal(pasted[2].arguments.input.step_id, pasted[1].id)
})
