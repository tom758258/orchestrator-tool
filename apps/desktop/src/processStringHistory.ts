// Chromium groups ordinary editing and native drag moves in its own history.
// A corrected cross-field move can consist of two native commands instead.
// Keep a mount-local record of display deltas to recognize those moves, and
// publish a completed native drag or undo/redo before React can overwrite a
// second controlled textarea. Native history remains the source of undo/redo.
type Values = Map<HTMLTextAreaElement, string>
type Delta = { field: HTMLTextAreaElement; offset: number; removed: string; inserted: string }
type Edit = { changes: Delta[]; crossFieldMove: boolean; splitMove: boolean }
type Publish = (displayed: string) => void
type Commit = (update: () => void) => void
type Field = { publish: Publish; remount: Publish }
const histories = new WeakMap<Element, ReturnType<typeof createHistory>>()

function delta(field: HTMLTextAreaElement, before: string, after: string): Delta | undefined {
  if (before === after) return
  let offset = 0
  const common = Math.min(before.length, after.length)
  while (offset < common && before[offset] === after[offset]) offset++
  let suffix = 0
  while (suffix < common - offset && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  return { field, offset, removed: before.slice(offset, before.length - suffix), inserted: after.slice(offset, after.length - suffix) }
}

function sameValues(left: Values, right: Values): boolean {
  return left.size === right.size && [...left].every(([field, value]) => right.get(field) === value)
}

function applyEdit(values: Values, edit: Edit, reverse: boolean): boolean {
  for (const change of edit.changes) {
    const value = values.get(change.field)
    const remove = reverse ? change.inserted : change.removed
    const insert = reverse ? change.removed : change.inserted
    if (value === undefined || value.slice(change.offset, change.offset + remove.length) !== remove) return false
    values.set(change.field, value.slice(0, change.offset) + insert + value.slice(change.offset + remove.length))
  }
  return true
}

function createHistory(commit: Commit) {
  const fields = new Map<HTMLTextAreaElement, Field>()
  let values: Values = new Map()
  const edits: Edit[] = []
  let cursor = 0
  let dragBefore: Values | undefined
  let dragRepaired = false
  let pending: 'historyUndo' | 'historyRedo' | undefined
  let cancelPending: (() => void) | undefined

  const read = (): Values => new Map([...fields.keys()].map(field => [field, field.value]))
  const reset = (current = read()) => {
    cancelPending?.()
    edits.length = 0
    cursor = 0
    values = current
    dragBefore = undefined
    dragRepaired = false
    pending = undefined
  }
  const sync = () => {
    if (dragBefore || pending) return
    const current = read()
    if (!sameValues(values, current)) reset(current)
  }
  const record = (before: Values, after: Values, drag = false, splitMove = false) => {
    const changes = [...before].flatMap(([field, value]) => {
      const next = after.get(field)
      const change = next === undefined ? undefined : delta(field, value, next)
      return change ? [change] : []
    })
    if (changes.length) {
      edits.splice(cursor)
      edits.push({ changes, crossFieldMove: drag && changes.length > 1, splitMove: splitMove && changes.length > 1 })
      cursor = edits.length
    }
    values = after
  }
  const publish = (before: Values, after: Values) => {
    // Read every updated DOM value first. The callbacks may trigger renders.
    commit(() => {
      for (const [field, value] of after) {
        if (before.get(field) !== value) fields.get(field)?.publish(value)
      }
    })
  }
  const finishDrag = () => {
    if (!dragBefore) return
    const before = dragBefore
    dragBefore = undefined
    const after = read()
    record(before, after, true, dragRepaired)
    dragRepaired = false
    publish(before, after)
  }
  const invalidateHistory = (before: Values) => {
    // A half-restored move must never become Template data. Remount the
    // participating fields so the browser cannot replay their stale history.
    reset(before)
    commit(() => {
      for (const [field, value] of before) {
        if (field.value !== value) field.value = value
        fields.get(field)?.remount(value)
      }
    })
  }
  const finishHistory = () => {
    const type = pending
    if (!type) return
    cancelPending?.()
    const reverse = type === 'historyUndo'
    const direction = reverse ? -1 : 1
    const before = values
    let after = read()
    const expected = new Map(before)
    let index = cursor
    let matched = false
    while (reverse ? index > 0 : index < edits.length) {
      const edit = edits[reverse ? index - 1 : index]
      if (!applyEdit(expected, edit, reverse)) break
      index += direction
      if (sameValues(expected, after)) {
        matched = true
        break
      }
      // The nearest recorded edit is a cross-field move. Native history may
      // have restored only one field if a boundary needed an edit command.
      // Consume the other native history entry only for this exact partial move.
      if (edit.splitMove && index === cursor + direction &&
        !sameValues(before, after) && [...after].every(([field, value]) =>
          value === before.get(field) || value === expected.get(field))) {
        const field = edit.changes.find(change => after.get(change.field) !== expected.get(change.field))?.field
        if (field) {
          field.ownerDocument.execCommand(reverse ? 'undo' : 'redo')
          after = read()
          if (sameValues(expected, after)) {
            matched = true
            break
          }
          invalidateHistory(before)
          return
        }
      }
      if (edit.crossFieldMove) break
    }
    if (matched) {
      cursor = index
      values = after
      pending = undefined
    } else {
      // Without a matching native edit, never guess another Undo. If a
      // cross-field transaction is still in the tracked history, discard the
      // invalid native history instead of publishing a potentially partial move.
      if (edits.some(edit => edit.crossFieldMove)) {
        invalidateHistory(before)
        return
      }
      reset(after)
    }
    publish(before, after)
  }
  const scheduleHistory = (document: Document) => {
    // Native drag history can dispatch input on two elements, with a microtask
    // checkpoint between them. Wait for the native command's task to end.
    // Flush before the next user action (including Save or Run) if it comes first.
    const timer = setTimeout(finishHistory, 0)
    const events = ['pointerdown', 'keydown', 'click'] as const
    for (const event of events) document.addEventListener(event, finishHistory, true)
    cancelPending = () => {
      clearTimeout(timer)
      for (const event of events) document.removeEventListener(event, finishHistory, true)
      cancelPending = undefined
    }
  }
  const register = (field: HTMLTextAreaElement, onEdit: Publish, remount: Publish) => {
    fields.set(field, { publish: onEdit, remount })
    reset()
    const beforeInput = (event: InputEvent) => {
      if (pending && cancelPending && event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') finishHistory()
      sync()
    }
    const input = (event: Event) => {
      const type = (event as InputEvent).inputType
      if (type === 'historyUndo' || type === 'historyRedo') {
        event.stopImmediatePropagation()
        if (!pending) {
          pending = type
          scheduleHistory(field.ownerDocument)
        }
        return
      }
      if (dragBefore) {
        // Boundary repairs use native insertText/delete commands instead of
        // the browser's single deleteByDrag + insertFromDrop transaction.
        if (type !== 'deleteByDrag' && type !== 'insertFromDrop') dragRepaired = true
        event.stopImmediatePropagation()
        return
      }
      const after = new Map(values)
      after.set(field, field.value)
      record(values, after)
    }
    const startDrag = () => {
      sync()
      dragBefore = read()
      dragRepaired = false
    }
    field.addEventListener('beforeinput', beforeInput)
    field.addEventListener('input', input)
    field.addEventListener('dragstart', startDrag)
    field.addEventListener('dragend', finishDrag)
    return () => {
      field.removeEventListener('beforeinput', beforeInput)
      field.removeEventListener('input', input)
      field.removeEventListener('dragstart', startDrag)
      field.removeEventListener('dragend', finishDrag)
      fields.delete(field)
      reset()
    }
  }
  return { register, sync }
}

export function bindProcessStringHistory(field: HTMLTextAreaElement, onEdit: Publish, remount: Publish, commit: Commit): () => void {
  const scope = field.closest('[data-process-string-editor]') ?? field
  let history = histories.get(scope)
  if (!history) {
    history = createHistory(commit)
    histories.set(scope, history)
  }
  return history.register(field, onEdit, remount)
}

export function syncProcessStringHistory(field: HTMLTextAreaElement) {
  histories.get(field.closest('[data-process-string-editor]') ?? field)?.sync()
}
