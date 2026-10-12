import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('manual export starts as XLSX on every mount without saved preferences', () => {
  assert.match(source, /const \[exportFormat, setExportFormat\] = useState<'csv' \| 'xlsx'>\('xlsx'\)/)
  assert.equal((source.match(/setExportFormat\(/g) ?? []).length, 1)
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)[^\n]*exportFormat|exportFormat[^\n]*(?:localStorage|sessionStorage)/)
})

test('manual format selection controls the dialog, backend, and export label', () => {
  const select = source.match(/<select aria-label="Export format"[\s\S]*?<\/select>/)?.[0]
  assert.ok(select)
  assert.match(select, /value=\{exportFormat\}/)
  assert.match(select, /setExportFormat\(event.target.value as 'csv' \| 'xlsx'\)/)
  assert.match(select, /<option value="csv">CSV<\/option>/)
  assert.match(select, /<option value="xlsx">XLSX<\/option>/)
  const handler = source.slice(source.indexOf('const handleExport'), source.indexOf('const selectedStep'))
  assert.match(handler, /exportAllPages && exportFormat === 'csv'/)
  assert.match(handler, /extensions: \[exportFormat\]/)
  assert.match(handler, /format: exportFormat/)
  assert.match(handler, /exportAllPages, exportFormat/)
  assert.match(source, /exportFormat.toUpperCase\(\)/)
})
