import en from './en/index.ts'
import zhTW from './zh-TW/index.ts'
import type { Locale } from './locales.ts'

export type TranslationParams = Record<string, string | number>
export type Translate = (key: string, params?: TranslationParams) => string
export const catalogues: Record<Locale, Readonly<Record<string, string>>> = { en, 'zh-TW': zhTW }

export function translate(locale: Locale, key: string, params: TranslationParams = {}): string {
  const template = catalogues[locale]?.[key] ?? catalogues.en[key] ?? key
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match)
}

export const english: Translate = (key, params) => translate('en', key, params)
