// Presentation dependencies for the repository's existing isolated Node harnesses.
// Actual locale changes and React integration are exercised by i18n.test.tsx.
import { english } from '../src/i18n/index.ts'
import { enumLabel, optionLabel } from '../src/i18n/presentation.ts'
export { english }
export const useI18n = () => ({ locale: 'en', setLocale() {}, t: english })
export function presentationModules(getUseState) {
  return {
    './i18n/I18nProvider': { useI18n },
    './i18n/index.ts': { english },
    './i18n/presentation': { enumLabel, optionLabel },
    './i18n/useMessage': {
      uiMessage: (key, params) => ({ key, params }),
      useMessage() {
        const [value, setValue] = getUseState()(null)
        return [value && typeof value === 'object' ? english(value.key, value.params) : value, setValue]
      },
    },
  }
}
