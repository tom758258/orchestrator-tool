import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { effectiveTheme, nextThemePreference, readThemePreference, writeThemePreference, THEME_STORAGE_KEY } from '../src/theme.ts'

test('effective theme follows the system only for System preference', () => {
  assert.equal(effectiveTheme('system', true), 'dark')
  assert.equal(effectiveTheme('system', false), 'light')
  for (const dark of [true, false]) {
    assert.equal(effectiveTheme('light', dark), 'light')
    assert.equal(effectiveTheme('dark', dark), 'dark')
  }
})

test('preference cycles System, Light, Dark, System', () => {
  assert.equal(nextThemePreference('system'), 'light')
  assert.equal(nextThemePreference('light'), 'dark')
  assert.equal(nextThemePreference('dark'), 'system')
})

test('storage validates preferences and tolerates read/write exceptions', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => undefined })
  t.after(() => {
    t.mock.restoreAll()
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  })
  let saved = null
  t.mock.getter(globalThis, 'localStorage', () => ({
    getItem(key) { assert.equal(key, THEME_STORAGE_KEY); return saved },
    setItem(key, value) { assert.equal(key, THEME_STORAGE_KEY); saved = value },
  }))
  for (const value of [null, '', 'invalid', 'Dark']) {
    saved = value
    assert.equal(readThemePreference(), 'system')
  }
  for (const value of ['system', 'light', 'dark']) {
    writeThemePreference(value)
    assert.equal(readThemePreference(), value)
  }
  t.mock.getter(globalThis, 'localStorage', () => { throw new Error('Unavailable') })
  assert.equal(readThemePreference(), 'system')
  assert.doesNotThrow(() => writeThemePreference('dark'))
})

test('startup sets effective theme before React and tolerates unavailable browser APIs', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  for (const saved of [null, 'invalid', 'system', 'light', 'dark']) {
    for (const systemDark of [false, true]) {
      const document = { documentElement: { dataset: {} } }
      runInNewContext(script, {
        document,
        localStorage: { getItem: () => saved },
        matchMedia: () => ({ matches: systemDark }),
      })
      const expected = saved === 'light' || saved === 'dark' ? saved : systemDark ? 'dark' : 'light'
      assert.equal(document.documentElement.dataset.theme, expected)
    }
  }
  const document = { documentElement: { dataset: {} } }
  runInNewContext(script, {
    document,
    get localStorage() { throw new Error('Unavailable') },
    matchMedia() { throw new Error('Unavailable') },
  })
  assert.equal(document.documentElement.dataset.theme, 'light')
})
