import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { composeMessageText, inputScope, showMessageOutputCandidates,
  MESSAGE_TARGETS } from '../src/workflow.ts'
import { pasteSteps, singleSelection } from '../src/stepEditing.ts'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const editor = readFileSync(new URL('../src/ShowMessageEditor.tsx', import.meta.url), 'utf8')

const output = (id, name) => ({ type: 'output', id, name, page: 'Results',
  value: { source: 'literal', value: 1 } })

test('Show Message is offered in the Workflow palette with its defaults', () => {
  assert.match(source, /\{ value: 'show-message', label: 'Show Message', prefix: 'show-message', category: 'Workflow' \}/)
  assert.match(source, /case 'show-message':\s*\n\s*return \{ type: 'show-message', id, target: 'message-1', fields: \[\{ kind: 'text', text: '', newline: false \}\] \}/)
  assert.match(source, /STEP_HELP|show-message': 'Write a message to the Messages Panel/)
  // The step is summarised in the sequence list, not only in Properties.
  assert.match(source, /step\.type === 'show-message'\) \{\s*\n\s*return 'Show Message'/)
})

test('Show Message Target Message offers exactly three messages defaulting to Message 1', () => {
  assert.deepEqual(MESSAGE_TARGETS, ['message-1', 'message-2', 'message-3'])
  assert.match(editor, /MESSAGE_TARGETS\.map\(target => \(\s*<option key=\{target\} value=\{target\}>\{MESSAGE_TARGET_LABELS\[target\]\}/)
  assert.match(editor, /<option value="text">String<\/option>/)
  assert.match(editor, /<option value="output" disabled=\{outputs\.length === 0\}>Output<\/option>/)
  // 1 to 10 fields: Add is capped and Delete keeps at least one field.
  assert.match(editor, /step\.fields\.length >= MAX_MESSAGE_FIELDS\}\s*\n\s*onClick=\{addField\}>Add Field</)
  assert.match(editor, /disabled=\{disabled \|\| step\.fields\.length <= 1\}\s*\n\s*onClick=\{\(\) => removeField\(index\)\}>Delete Field</)
  // String text is limited to 256 Unicode characters, not 256 UTF-16 units.
  assert.match(editor, /limitMessageText\(event\.target\.value, MAX_MESSAGE_TEXT_CHARS\)/)
  assert.match(editor, /Array\.from\(field\.text\)\.length\} \/ \{MAX_MESSAGE_TEXT_CHARS\} characters/)
})

test('only the last Show Message field omits the Newline checkbox', () => {
  assert.match(editor, /\{index < step\.fields\.length - 1 && \(\s*<label className="step-property-field">\s*\n\s*<input type="checkbox" checked=\{field\.newline\}/)
  // A single field cannot request a newline, so the record cannot gain a blank line.
  assert.match(editor, /const replacesLast = \(field: MessageFieldWire\): MessageFieldWire =>\s*\n\s*step\.fields\.length === 1 \? \{ \.\.\.field, newline: false \} : field/)
})

test('the Message Preview mirrors the Core composition rules', () => {
  assert.match(editor, /<pre>\{composeMessageText\(step\.fields,\s*\n\s*stepId => outputs\.find\(output => output\.id === stepId\)\?\.name\)\}<\/pre>/)
  const fields = [
    { kind: 'text', text: 'Iteration: ', newline: false },
    { kind: 'output', step_id: 'iteration', pointer: '', newline: true },
    { kind: 'text', text: 'Double: ', newline: false },
    { kind: 'output', step_id: 'double', pointer: '', newline: false },
  ]
  const names = { iteration: 'Iteration', double: 'Double' }
  const name = id => names[id]
  // The documented example renders with one newline per flagged field plus the terminator.
  assert.equal(composeMessageText(fields, name),
    'Iteration: {Iteration}\nDouble: {Double}\n')
  // The automatic terminator never doubles up with a flagged last field.
  assert.equal(composeMessageText([{ kind: 'text', text: 'a', newline: true },
    { kind: 'text', text: 'b', newline: true }], name), 'a\nb\n')
  assert.equal(composeMessageText([{ kind: 'text', text: 'only', newline: false }], name), 'only\n')
  // An unknown reference still shows a stable placeholder.
  assert.equal(composeMessageText([{ kind: 'output', step_id: 'gone', pointer: '', newline: false }],
    name), '{gone}\n')
  assert.equal(composeMessageText([], name), '')
})

test('a Show Message Output field may only pick earlier Output steps in scope', () => {
  const steps = [
    output('before', 'Before'),
    { type: 'wait', id: 'wait-1', duration_ms: 0 },
    { type: 'show-message', id: 'show-message-1', target: 'message-1',
      fields: [{ kind: 'text', text: '', newline: false }] },
    output('after', 'After'),
  ]
  const { earlierSteps } = inputScope(steps, 'show-message-1')
  const candidates = showMessageOutputCandidates(earlierSteps)
  // The dropdown shows Output names but stores the stable Step ID.
  assert.deepEqual(candidates.map(step => step.id), ['before'])
  assert.match(editor, /\{outputs\.map\(output => <option key=\{output\.id\} value=\{output\.id\}>\{output\.name\}<\/option>\)\}/)
  // An unresolvable reference is preserved so Validate can report it.
  assert.match(editor, /Reference preserved: \{field\.step_id\} is not an eligible earlier Output\. Validate to check it\./)
})

test('pasting a Show Message remaps Output references and keeps its settings', () => {
  const original = [
    output('iteration', 'Iteration'),
    { type: 'show-message', id: 'show-message-1', target: 'message-3', fields: [
      { kind: 'text', text: 'Value: ', newline: false },
      { kind: 'output', step_id: 'iteration', pointer: '', newline: true },
      { kind: 'output', step_id: 'external', pointer: '', newline: false },
    ] },
  ]
  const result = pasteSteps([], original, singleSelection(null))
  const pasted = result.steps
  const message = pasted[1]
  assert.equal(message.type, 'show-message')
  assert.equal(message.target, 'message-3', 'target is preserved')
  assert.deepEqual(message.fields[0], { kind: 'text', text: 'Value: ', newline: false })
  // The referenced Output is copied, so the field follows its new ID.
  assert.equal(message.fields[1].step_id, 'iteration-copy')
  assert.equal(message.fields[1].newline, true)
  // A reference outside the pasted set keeps its original ID.
  assert.equal(message.fields[2].step_id, 'external')
  assert.equal(pasted[0].id, 'iteration-copy')
  // The destination is empty, so the Output name needs no deduplication.
  assert.equal(pasted[0].name, 'Iteration')
  assert.deepEqual(result.selection.ids, ['iteration-copy', 'show-message-1-copy'])
})

test('pasting into a workflow that already has the Output still renames it', () => {
  const original = [output('iteration', 'Iteration'),
    { type: 'show-message', id: 'show-message-1', target: 'message-1',
      fields: [{ kind: 'output', step_id: 'iteration', pointer: '', newline: false }] }]
  const result = pasteSteps([output('iteration', 'Iteration')], original, singleSelection(null))
  assert.equal(result.steps[1].name, 'Iteration Copy')
  assert.equal(result.steps[2].fields[0].step_id, 'iteration-copy')
})
