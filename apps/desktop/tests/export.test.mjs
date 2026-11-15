import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('manual export starts as XLSX on every mount without saved preferences', () => {
  assert.match(source, /const \[exportFormat, setExportFormat\] = useState<'csv' \| 'xlsx'>\('xlsx'\)/)
  assert.equal((source.match(/setExportFormat\(/g) ?? []).length, 1)
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)[^\n]*exportFormat|exportFormat[^\n]*(?:localStorage|sessionStorage)/)
})
