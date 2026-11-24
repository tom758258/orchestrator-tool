// Textareas normalize CRLF and lone CR to LF. Translate their UTF-16 offsets
// back to the original string so an edit does not rewrite untouched bytes.
function rawProcessOffset(value: string, displayOffset: number): number {
  let offset = 0
  for (let index = 0; index < displayOffset; index++, offset++) {
    if (value[offset] === '\r' && value[offset + 1] === '\n') offset++
  }
  return offset
}

export function replaceProcessStringRange(value: string, start: number, end: number, replacement: string): string {
  return value.slice(0, rawProcessOffset(value, start)) + replacement + value.slice(rawProcessOffset(value, end))
}

export type ProcessEditSelection = { start: number; end: number; inputType: string }

export function editProcessString(value: string, edited: string, caret: number, selection?: ProcessEditSelection): string {
  const displayed = value.replace(/\r\n?/g, '\n')
  if (displayed === value) return edited

  // Prefer the selection captured before the native edit. Equal displayed
  // values can represent different bytes when a CRLF is replaced by LF.
  if (selection) {
    let { start, end } = selection
    const inserting = selection.inputType.startsWith('insert')
    const deleting = selection.inputType.startsWith('delete')
    if (deleting && start === end) {
      start = caret
      end = caret + displayed.length - edited.length
    }
    const replacementEnd = edited.length - (displayed.length - end)
    if ((inserting || deleting) && start >= 0 && end >= start && end <= displayed.length &&
      replacementEnd >= start && edited.startsWith(displayed.slice(0, start)) &&
      edited.endsWith(displayed.slice(end))) {
      return replaceProcessStringRange(value, start, end, edited.slice(start, replacementEnd))
    }
  }

  if (displayed === edited) return value
  // Fallback for input events without an available pre-edit range.
  const shorter = Math.min(displayed.length, edited.length)
  let start = 0
  while (start < shorter && displayed[start] === edited[start]) start++
  let suffix = 0
  while (suffix < shorter && displayed[displayed.length - 1 - suffix] === edited[edited.length - 1 - suffix]) suffix++
  if (start + suffix > shorter) {
    const preferredStart = caret - Math.max(0, edited.length - displayed.length)
    start = Math.max(shorter - suffix, Math.min(start, preferredStart))
    suffix = shorter - start
  }
  return replaceProcessStringRange(value, start, displayed.length - suffix, edited.slice(start, edited.length - suffix))
}
