import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

for (const [locale, suffix] of [['en', ''], ['zh-TW', '.zh-TW']]) {
  const html = readFileSync(new URL(`../public/help/desktop${suffix}.html`, import.meta.url), 'utf8')

  for (const theme of ['system', 'light', 'dark']) {
    test(`Desktop Help ${locale} preserves ${theme} on sidebar and landing chapter links`, () => {
      const dom = new JSDOM(html, {
        url: `http://tauri.localhost/help/desktop${suffix}.html?theme=${theme}`,
        runScripts: 'dangerously',
        beforeParse(window) {
          window.matchMedia = () => ({ matches: false, addEventListener() {} })
          window.requestAnimationFrame = callback => callback()
        },
      })
      try {
        const document = dom.window.document
        assert.equal(document.documentElement.dataset.theme, theme === 'dark' ? 'dark' : 'light')
        const sidebar = [...document.querySelectorAll('.help-page-nav a.help-page')]
        const chapters = [...document.querySelectorAll('#help-content a')]
          .filter(link => new URL(link.href).pathname.endsWith('.html'))
        assert.ok(sidebar.length > 0)
        assert.ok(chapters.length > 0)
        for (const link of [...sidebar, ...chapters]) {
          const target = new URL(link.href)
          assert.equal(target.searchParams.get('theme'), theme)
          assert.equal(target.origin, 'http://tauri.localhost')
          assert.ok(target.pathname.startsWith('/help/'))
        }
      } finally {
        dom.window.close()
      }
    })
  }
}
