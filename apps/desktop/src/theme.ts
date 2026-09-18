export const SUPPORTED_THEME_PREFERENCES = ['system', 'light', 'dark'] as const
export type ThemePreference = typeof SUPPORTED_THEME_PREFERENCES[number]
export const THEME_STORAGE_KEY = 'orchestrator-tool.theme'

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function effectiveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  return SUPPORTED_THEME_PREFERENCES[(SUPPORTED_THEME_PREFERENCES.indexOf(preference) + 1) % 3]
}

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Keep the current session usable when storage is unavailable.
  }
}
