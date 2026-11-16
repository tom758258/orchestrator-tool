import { defaultLocale, isLocale, type Locale } from './locales.ts'

export const LOCALE_STORAGE_KEY = 'orchestrator-tool.locale'
type BrowserLanguages = { languages?: readonly string[]; language?: string }

export function detectBrowserLocale(browser?: BrowserLanguages | null): Locale {
  try {
    const language = browser?.languages?.find(value => typeof value === 'string' && value.trim())
      || browser?.language || ''
    const normalized = language.trim().replaceAll('_', '-').toLowerCase()
    if (/^zh-(tw|hant)(-|$)/.test(normalized)) return 'zh-TW'
  } catch { /* Detection is optional. */ }
  return defaultLocale
}

export function resolveInitialLocale(storage?: Pick<Storage, 'getItem'> | null, browser?: BrowserLanguages | null): Locale {
  try {
    const saved = storage?.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(saved)) return saved
  } catch { /* Keep language detection available when storage is blocked. */ }
  return detectBrowserLocale(browser)
}

export function persistLocale(locale: Locale, storage?: Pick<Storage, 'setItem'> | null): void {
  try { storage?.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* Keep the session usable. */ }
}

export function initialLocale(): Locale {
  let storage: Storage | undefined
  try { storage = window.localStorage } catch { /* Storage may be blocked. */ }
  return resolveInitialLocale(storage, typeof navigator === 'undefined' ? null : navigator)
}
