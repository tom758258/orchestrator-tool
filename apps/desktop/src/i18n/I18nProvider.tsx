import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { english, translate, type Translate } from './index'
import { initialLocale, persistLocale } from './locale'
import { defaultLocale, isLocale, type Locale } from './locales'

type I18n = { locale: Locale; setLocale: (locale: Locale) => void; t: Translate }
const I18nContext = createContext<I18n>({ locale: defaultLocale, setLocale: () => {}, t: english })

export function I18nProvider({ children, initialLanguage }: { children: ReactNode; initialLanguage?: Locale }) {
  const [locale, updateLocale] = useState<Locale>(() => initialLanguage ?? initialLocale())
  const setLocale = useCallback((value: Locale) => {
    if (!isLocale(value)) return
    updateLocale(value)
    try { persistLocale(value, window.localStorage) } catch { /* Keep in-memory selection. */ }
  }, [])
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  const t = useCallback<Translate>((key, params) => translate(locale, key, params), [locale])
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n { return useContext(I18nContext) }
