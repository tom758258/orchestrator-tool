import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useState } from 'react'
import ChartSettings from '../src/ChartSettings'
import ShowMessageEditor from '../src/ShowMessageEditor'
import type { ShowMessageStep } from '../src/workflow'
import { backgroundPlotData } from '../src/backgroundChartData'
import { chartPresentationOptions } from '../src/chartOptions'
import { I18nProvider, useI18n } from '../src/i18n/I18nProvider'
import { catalogues, translate } from '../src/i18n'
import { detectBrowserLocale, LOCALE_STORAGE_KEY, persistLocale, resolveInitialLocale } from '../src/i18n/locale'
import { locales } from '../src/i18n/locales'
import { enumLabel, optionLabel } from '../src/i18n/presentation'
import { uiMessage, useMessage } from '../src/i18n/useMessage'
import FailureDetails from '../src/FailureDetails'
import { curatedResultFields } from '../src/inputValue'
import { addChartPanel } from '../src/chartPanels'
import { createChartSettingsDraft, validateChartSettingsDraft } from '../src/chartSettingsModel'

test('initial language follows the first WebView preference and saved explicit choice', () => {
  for (const language of ['zh-TW', 'ZH_tw', 'zh-Hant', 'zh-Hant-HK', 'zh-TW-x-private']) {
    expect(detectBrowserLocale({ languages: [language, 'en'] })).toBe('zh-TW')
  }
  for (const language of ['en-US', 'zh-CN', 'zh', 'ja-JP', '', 'zh-Hans-TW']) {
    expect(detectBrowserLocale({ language })).toBe('en')
  }
  expect(detectBrowserLocale({ languages: ['ja-JP', 'zh-TW'] })).toBe('en')
  expect(detectBrowserLocale({ languages: [], language: 'zh-Hant' })).toBe('zh-TW')
  expect(detectBrowserLocale({ get languages(): readonly string[] { throw Error('blocked') } })).toBe('en')
  expect(detectBrowserLocale(null)).toBe('en')
  const browser = { language: 'zh-TW' }
  expect(resolveInitialLocale({ getItem: () => 'en' }, browser)).toBe('en')
  expect(resolveInitialLocale({ getItem: () => 'zh-TW' }, { language: 'en' })).toBe('zh-TW')
  expect(resolveInitialLocale({ getItem: () => 'invalid' }, browser)).toBe('zh-TW')
  expect(resolveInitialLocale({ getItem() { throw Error('blocked') } }, browser)).toBe('zh-TW')
  expect(() => persistLocale('en', { setItem() { throw Error('blocked') } })).not.toThrow()
})

test('all registered dictionaries have complete nonempty keys and identical parameters', () => {
  const parameters = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort()
  for (const { id } of locales) {
    expect(Object.keys(catalogues[id]).sort()).toEqual(Object.keys(catalogues.en).sort())
    for (const [key, value] of Object.entries(catalogues[id])) {
      expect(value.trim(), key).not.toBe('')
      expect(parameters(value), key).toEqual(parameters(catalogues.en[key]))
    }
  }
  const modules = import.meta.glob<Record<string, string>>('../src/i18n/en/*.ts', { eager: true, import: 'default' })
  const keys = Object.entries(modules).filter(([path]) => !path.endsWith('/index.ts')).flatMap(([, module]) => Object.keys(module))
  expect(new Set(keys).size).toBe(keys.length)
})

test('translation falls back to English, interpolates data once and retains unknown keys', () => {
  const englishKey = 'app.stop'
  const saved = catalogues['zh-TW']
  catalogues['zh-TW'] = {}
  try { expect(translate('zh-TW', englishKey)).toBe(catalogues.en[englishKey]) }
  finally { catalogues['zh-TW'] = saved }
  expect(translate('zh-TW', 'missing.key')).toBe('missing.key')
  expect(translate('zh-TW', 'app.requireToolInstance', { value1: '<meters>{value2}' })).toContain('<meters>{value2}')
})

test('choice labels localize and capitalize English without changing enum values', () => {
  const en = (key: string) => translate('en', key)
  const zh = (key: string) => translate('zh-TW', key)
  for (const [value, english, chinese] of [
    ['positive', 'Positive', '正向'],
    ['negative', 'Negative', '負向'],
    ['either', 'Either', '任一方向'],
    ['alternate', 'Alternate', '交替'],
    ['normal', 'Normal', '一般'],
    ['average', 'Average', '平均'],
    ['high_resolution', 'High Resolution', '高解析度'],
    ['peak', 'Peak', '峰值偵測'],
  ]) {
    expect(optionLabel(en, 'capability', value)).toBe(english)
    expect(optionLabel(zh, 'capability', value)).toBe(chinese)
  }
  expect(optionLabel(en, 'capability', 'custom_mode')).toBe('Custom_mode')
  expect(optionLabel(en, 'capability', '10percent')).toBe('10Percent')
  expect(optionLabel(en, 'capability', 'vpp')).toBe('Vp-p')
  expect(optionLabel(zh, 'capability', 'custom_mode')).toBe('Custom_mode')
  expect(enumLabel(en, 'status', 'running')).toBe('running')
  expect(translate('en', 'steps.scope.timebase-scale')).toBe('Scope Horizontal Scale')
  expect(translate('zh-TW', 'steps.scope.timebase-scale')).toBe('示波器水平軸刻度')
  expect(translate('zh-TW', 'steps.scope.timebase-position')).toBe('示波器水平軸位置')
})

test('switching retains editor state and feedback, updates html language, and remembers the choice', () => {
  function Editor() {
    const { locale, setLocale, t } = useI18n()
    const [message, setMessage] = useMessage()
    return <>
      <button onClick={() => setLocale(locale === 'en' ? 'zh-TW' : 'en')}>language</button>
      <input aria-label="draft" defaultValue="custom title" />
      <button onClick={() => setMessage(uiMessage('app.templateSaved'))}>{t('app.saveTemplate')}</button>
      <p>{message}</p>
    </>
  }
  const view = render(<I18nProvider initialLanguage="en"><Editor /></I18nProvider>)
  const input = screen.getByRole('textbox') as HTMLInputElement
  fireEvent.change(input, { target: { value: '使用者資料' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Template' }))
  fireEvent.click(screen.getByRole('button', { name: 'language' }))
  expect(screen.getByText('已儲存範本。')).toBeTruthy()
  expect(input.value).toBe('使用者資料')
  expect(document.documentElement.lang).toBe('zh-TW')
  expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-TW')
  view.unmount()
  render(<I18nProvider><Editor /></I18nProvider>)
  expect(screen.getByRole('button', { name: '儲存範本' })).toBeTruthy()
  localStorage.removeItem(LOCALE_STORAGE_KEY)
})

test('localized failures retain original diagnostics and display helpers retain data contracts', () => {
  const raw = 'worker fatal error: <device> raw evidence'
  render(<I18nProvider initialLanguage="zh-TW"><FailureDetails message={raw} /></I18nProvider>)
  expect(screen.getByText('外部工具在執行此操作時回報錯誤。')).toBeTruthy()
  expect(screen.getByText(raw)).toBeTruthy()
  const t = (key: string, params?: Record<string, string | number>) => translate('zh-TW', key, params)
  const step = { id: 'send', type: 'tool-action', target: 'serial-1', action: 'send' }
  const instances = [{ id: 'serial-1', tool: 'serial' }]
  const en = curatedResultFields(step, instances)
  const zh = curatedResultFields(step, instances, t)
  expect(zh.map(field => field.pointer)).toEqual(en.map(field => field.pointer))
  expect(zh[0].label).toBe('TX 資料（Hex 字串）')
  const draft = createChartSettingsDraft(addChartPanel([], 'custom Page', ['custom Output'])[0])
  expect(validateChartSettingsDraft(draft, t).settings).toEqual(validateChartSettingsDraft(draft).settings)
  draft.scatter.markerSize = 'invalid'
  draft.type = 'scatter'
  expect(validateChartSettingsDraft(draft, t).error).toContain('標記大小')
})

function LanguageButton() {
  const { locale, setLocale } = useI18n()
  return <button onClick={() => setLocale(locale === 'en' ? 'zh-TW' : 'en')}>language</button>
}

test('an open Chart Settings dialog keeps its draft and validation when labels change', () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const panel = addChartPanel([], 'Custom page', ['Voltage'])[0]
  const onApply = vi.fn()
  render(<I18nProvider initialLanguage="en"><LanguageButton /><ChartSettings
    panel={panel} numericNames={['Voltage']} outputs={[]} running={false} hasRows
    onApply={onApply} onClose={() => {}} /></I18nProvider>)
  fireEvent.change(screen.getByLabelText('Chart title'), { target: { value: '自訂 title' } })
  expect(screen.getByText(/Displaying all raw data bypasses downsampling/)).toBeTruthy()
  fireEvent.click(screen.getByLabelText('Show All Raw Data'))
  fireEvent.click(screen.getByRole('tab', { name: 'Axes' }))
  const xAxis = within(screen.getByRole('group', { name: 'X Axis' }))
  fireEvent.change(xAxis.getByLabelText('Minimum'), { target: { value: 'bad' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(screen.getByRole('alert').textContent).toContain('finite')
  fireEvent.click(screen.getByRole('button', { name: 'language' }))
  expect(screen.getByRole('dialog', { name: '圖表設定' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: '座標軸' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('alert').textContent).toContain('有限數值')
  const translatedAxis = within(screen.getByRole('group', { name: 'X 軸' }))
  expect((translatedAxis.getByLabelText('最小值') as HTMLInputElement).value).toBe('bad')
  fireEvent.change(translatedAxis.getByLabelText('最小值'), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: '套用' }))
  expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ title: '自訂 title', showAllRawData: true,
    xAxis: expect.objectContaining({ min: 0, title: 'Iteration' }) }))
  localStorage.removeItem(LOCALE_STORAGE_KEY)
})

test('Message editor translates choices while preserving text, targets and Output references', () => {
  function Editor() {
    const [step, setStep] = useState<ShowMessageStep>({ type: 'show-message', id: 'message', target: 'message-2',
      fields: [{ kind: 'text', text: 'User text 使用者內容', newline: false }] })
    return <ShowMessageEditor step={step} outputs={[{ id: 'result', type: 'output', name: 'My result',
      page: 'Custom', value: { source: 'literal', value: 1 } }]} disabled={false} onChange={setStep} />
  }
  render(<I18nProvider initialLanguage="en"><LanguageButton /><Editor /></I18nProvider>)
  const target = screen.getByLabelText('Target Message') as HTMLSelectElement
  expect([...target.options].map(option => option.value)).toEqual(['message-1', 'message-2', 'message-3'])
  fireEvent.click(screen.getByRole('button', { name: 'language' }))
  expect((screen.getByLabelText('目標訊息') as HTMLSelectElement).value).toBe('message-2')
  expect((screen.getByLabelText(/^文字/) as HTMLInputElement).value).toBe('User text 使用者內容')
  fireEvent.change(screen.getByLabelText('類型'), { target: { value: 'output' } })
  expect((screen.getByLabelText('輸出') as HTMLSelectElement).value).toBe('result')
  expect(screen.getByRole('option', { name: 'My result' })).toBeTruthy()
  localStorage.removeItem(LOCALE_STORAGE_KEY)
})

test('chart defaults and hover labels localize without changing chart settings or sample data', () => {
  const t = (key: string, params?: Record<string, string | number>) => translate('zh-TW', key, params)
  const panel = addChartPanel([], 'Page', ['User Output'])[0]
  panel.title = 'My Chart'
  const before = JSON.stringify(panel)
  const options = chartPresentationOptions(panel, 1, { ink: '', axis: '', grid: '' },
    undefined, undefined, undefined, {}, false, undefined, t)
  expect(options.title.text).toBe('My Chart')
  expect(options.xAxis.name).toBe('迭代')
  expect(JSON.stringify(panel)).toBe(before)
  panel.xAxis.title = 'My axis'
  expect(chartPresentationOptions(panel, 1, { ink: '', axis: '', grid: '' },
    undefined, undefined, undefined, {}, false, undefined, t).xAxis.name).toBe('My axis')
  const points = [{ x: 0, value: 3, sample_index: 2, elapsed_s: 1, timestamp_utc: '2026-11-15T00:00:00Z', unit: 'V' }]
  const en = backgroundPlotData(points, null)
  const zh = backgroundPlotData(points, null, t)
  expect(zh.x).toEqual(en.x)
  expect(zh.values).toEqual(en.values)
  expect(zh.hoverLabels[0]).toBe('樣本 2\n2026-11-15T00:00:00Z\n經過 1 秒 · V')
})
