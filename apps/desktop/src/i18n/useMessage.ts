import { useState } from 'react'
import { useI18n } from './I18nProvider'
import type { TranslationParams } from './index'

type Message = string | { key: string; params?: TranslationParams } | null
export const uiMessage = (key: string, params?: TranslationParams): Message => ({ key, params })

// Store the message identity so completed feedback also follows a language change.
// Raw Core/Worker diagnostics remain strings and are never translated here.
export function useMessage() {
  const { t } = useI18n()
  const [message, setMessage] = useState<Message>(null)
  const text = message === null || typeof message === 'string' ? message : t(message.key, message.params)
  return [text, setMessage] as const
}
