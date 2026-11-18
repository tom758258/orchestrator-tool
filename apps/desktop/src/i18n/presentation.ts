import type { Translate } from './index.ts'

// Only use this for known UI enum labels; user names, results and raw diagnostics
// bypass this function. Unknown capability values retain their original spelling.
export function enumLabel(t: Translate, group: string, value: string): string {
  const key = `${group}.${value}`
  const label = t(key)
  return label === key ? value : label
}

// Capitalize only labels shown for UI choices; keep enum values and diagnostics intact.
export function optionLabel(t: Translate, group: string, value: string): string {
  return enumLabel(t, group, value).replace(/[a-z]/i, letter => letter.toUpperCase())
}
