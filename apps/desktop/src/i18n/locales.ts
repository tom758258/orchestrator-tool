export const locales = [
  { id: 'en', name: 'English' },
  { id: 'zh-TW', name: '繁體中文' },
] as const

export type Locale = typeof locales[number]['id']
export const defaultLocale: Locale = 'en'

export function isLocale(value: unknown): value is Locale {
  return locales.some(locale => locale.id === value)
}
