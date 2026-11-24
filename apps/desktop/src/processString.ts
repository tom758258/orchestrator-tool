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

export function editProcessString(value: string, edited: string, caret: number): string {
  const displayed = value.replace(/\r\n?/g, '\n')
  if (displayed === edited) return value
  if (displayed === value) return edited

  // A normal textarea edit replaces one contiguous range. Keep the common
  // prefix and suffix in their original form; use the caret to disambiguate
  // insertions/deletions among repeated characters (including line endings).
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
