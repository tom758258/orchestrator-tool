// Keep CR explicit in the editor; a textarea cannot represent it losslessly.
// Real LF remains a line break. Escape literal backslashes before CR.
export function encodeProcessString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r')
}

export function decodeProcessString(value: string): string {
  return value.replace(/\\([\\rn])/g, (_, ch: string) => ch === 'r' ? '\r' : ch === 'n' ? '\n' : '\\')
}

// Preserve the decoded value of each fragment independently. A dangling
// literal backslash must not acquire a new escape partner at a transfer boundary.
function joinDisplayParts(...parts: string[]): string {
  let result = ''
  for (const part of parts) {
    if (/^[\\rn]/.test(part)) {
      let start = result.length
      while (start > 0 && result[start - 1] === '\\') start--
      if ((result.length - start) % 2 === 1) result += '\\'
    }
    result += part
  }
  return result
}

export function processTransferText(displayed: string, start: number, end: number, insertion: string): string {
  const suffix = displayed.slice(end)
  const joined = joinDisplayParts(displayed.slice(0, start), insertion, suffix)
  return joined.slice(start, joined.length - suffix.length)
}

// Replace only the affected span in the browser's native editing history.
function insertText(field: HTMLTextAreaElement, text: string) {
  return text ? field.ownerDocument.execCommand('insertText', false, text)
    : field.ownerDocument.execCommand('delete')
}

export function bindProcessStringTransfers(field: HTMLTextAreaElement): () => void {
  const displayType = 'application/x-orchestrator-process-display'
  let dragSelection: { start: number; end: number } | undefined
  let displayDrop = false
  let sameFieldMove = false
  let droppedText: string | undefined
  let deferredSource: { start: number; end: number; text: string } | undefined

  const replacement = (insertion: string) => processTransferText(field.value, field.selectionStart, field.selectionEnd, insertion)
  const copy = (event: ClipboardEvent) => {
    if (!event.clipboardData || field.selectionStart === field.selectionEnd) return
    const selected = field.value.slice(field.selectionStart, field.selectionEnd)
    const raw = decodeProcessString(selected)
    const cut = event.type === 'cut' ? replacement('') : ''
    if (raw === selected && !cut) return
    event.clipboardData.setData('text/plain', raw)
    event.preventDefault()
    if (event.type === 'cut') insertText(field, cut)
  }
  const paste = (event: ClipboardEvent) => {
    const raw = event.clipboardData?.getData('text/plain')
    if (!raw) return
    const text = replacement(encodeProcessString(raw))
    if (text === raw) return
    event.preventDefault()
    insertText(field, text)
  }
  const markDrag = (event: DragEvent) => {
    if (field.selectionStart === field.selectionEnd) return
    resetDrag()
    deferredSource = undefined
    dragSelection = { start: field.selectionStart, end: field.selectionEnd }
    event.dataTransfer?.setData(displayType, '1')
  }
  const captureDrop = (event: DragEvent) => {
    displayDrop = event.dataTransfer?.types.includes(displayType) ?? false
    droppedText = event.dataTransfer?.getData('text/plain')
  }
  const resetDrag = () => {
    dragSelection = undefined
    displayDrop = false
    sameFieldMove = false
    droppedText = undefined
  }
  const beforeInput = (event: InputEvent) => {
    if (event.inputType === 'deleteByDrag') {
      if (dragSelection && displayDrop) {
        // Defer the source deletion for an in-field move. Both transfer
        // boundaries can then be edited as one native undoable replacement.
        sameFieldMove = true
        event.preventDefault()
      } else {
        const text = replacement('')
        if (text) {
          event.preventDefault()
          // A nested source edit during deleteByDrag may not get its own
          // native undo entry when insertion also needs a boundary repair.
          // Finish it after the browser's drop, before history publication.
          deferredSource = { start: field.selectionStart, end: field.selectionEnd, text }
        }
      }
      return
    }
    if (event.inputType !== 'insertFromDrop') return
    const raw = droppedText ?? event.data ?? ''
    const isDisplay = displayDrop
    const move = sameFieldMove ? dragSelection : undefined
    resetDrag()
    if (!raw) return
    if (move) {
      const { start, end } = move
      const target = field.selectionStart
      event.preventDefault()
      if (target >= start && target <= end) return
      const value = field.value
      const selected = value.slice(start, end)
      const from = Math.min(start, target)
      const to = Math.max(end, target)
      const middle = target < start ? value.slice(target, start) : value.slice(end, target)
      const suffix = value.slice(to)
      const prefix = value.slice(0, from)
      const before = target < start ? prefix : joinDisplayParts(prefix, middle)
      const after = target < start ? joinDisplayParts(middle, suffix) : suffix
      const throughSelection = joinDisplayParts(before, selected)
      const joined = joinDisplayParts(throughSelection, after)
      field.setSelectionRange(from, to)
      if (insertText(field, joined.slice(from, joined.length - suffix.length))) {
        field.setSelectionRange(throughSelection.length - selected.length, joined.length - after.length)
      }
      return
    }
    const insertion = isDisplay ? raw : encodeProcessString(raw)
    const text = replacement(insertion)
    if (text === raw) return
    event.preventDefault()
    const start = field.selectionStart
    const selectedStart = joinDisplayParts(field.value.slice(0, start), insertion).length - insertion.length
    if (insertText(field, text)) field.setSelectionRange(selectedStart, start + text.length)
  }
  const finishSource = () => {
    const repair = deferredSource
    deferredSource = undefined
    if (!repair) return
    const active = field.ownerDocument.activeElement
    field.focus()
    field.setSelectionRange(repair.start, repair.end)
    insertText(field, repair.text)
    if (active instanceof HTMLElement) active.focus()
  }
  // Capture runs before the history coordinator's dragend listener.
  field.addEventListener('dragend', finishSource, true)
  field.addEventListener('copy', copy)
  field.addEventListener('cut', copy)
  field.addEventListener('paste', paste)
  field.addEventListener('dragstart', markDrag)
  field.addEventListener('drop', captureDrop)
  field.addEventListener('dragend', resetDrag)
  field.addEventListener('beforeinput', beforeInput)
  return () => {
    field.removeEventListener('dragend', finishSource, true)
    field.removeEventListener('copy', copy)
    field.removeEventListener('cut', copy)
    field.removeEventListener('paste', paste)
    field.removeEventListener('dragstart', markDrag)
    field.removeEventListener('drop', captureDrop)
    field.removeEventListener('dragend', resetDrag)
    field.removeEventListener('beforeinput', beforeInput)
  }
}
