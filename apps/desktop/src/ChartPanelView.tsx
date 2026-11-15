import { uiMessage, useMessage } from './i18n/useMessage'
import { useI18n } from './i18n/I18nProvider'
import { useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import type { EChartsType } from 'echarts/core'
import type { OutputStep } from './workflow'
import type { ChartPanel } from './chartPanels'
import ChartSettings from './ChartSettings'
import Collapsible from './Collapsible'
import { chartPng } from './chartPng'

export default function ChartPanelView({ panel, panels, onPanelsChange, charts, numericNames, timestampNames = [],
  outputs = [], running, hasRows, canExport, onSavingChange, children, rawLimit, onSourceSettings }: {
  panel: ChartPanel; panels: ChartPanel[]; onPanelsChange: (panels: ChartPanel[]) => void
  charts: Map<number, EChartsType>; numericNames: string[]; timestampNames?: string[]; outputs?: OutputStep[]
  running: boolean; hasRows: boolean; canExport: boolean; onSavingChange: (saving: boolean) => void
  children: ReactNode; rawLimit?: number; onSourceSettings?: () => void
}) {
  const { t } = useI18n()
  const [settings, setSettings] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [feedback, setFeedback] = useMessage()
  const number = panels.findIndex(item => item.id === panel.id) + 1
  async function saveImage() {
    if (savingRef.current) return
    savingRef.current = true; setSaving(true); onSavingChange(true); setFeedback(null)
    try {
      const destinationPath = await save({ defaultPath: `Chart-${number}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] })
      if (!destinationPath) return
      const pngBytes = await chartPng(charts.get(panel.id), panel)
      await invoke('save_chart_png', { destinationPath, pngBytes: Array.from(pngBytes) })
      setFeedback(uiMessage("chartPanelView.chartImageSavedSuccessfully"))
    } catch (reason) { setFeedback(uiMessage("chartPanelView.couldNotSaveChartImageDiagnostic", { error: String(reason) })) }
    finally { savingRef.current = false; setSaving(false); onSavingChange(false) }
  }
  return <Collapsible title={t("chartPanelView.chart", { value1: number })} className="result-chart-panel" actions={<div className="result-chart-panel-actions">
    <button className="action-button" type="button" disabled={saving || !canExport} onClick={() => void saveImage()}>{t("chartPanelView.exportPNG")}</button>
    <button className="action-button" type="button" disabled={saving} onClick={() => setSettings(true)}>{t("chartPanelView.settings")}</button>
    {onSourceSettings && <button className="action-button" type="button" disabled={saving}
      onClick={onSourceSettings}>{t("chartPanelView.sourceSettings")}</button>}
    <button className="action-button action-button-danger" type="button" aria-label={t("chartPanelView.removeChart", { value1: number })}
      disabled={saving}
      onClick={() => onPanelsChange(panels.filter(item => item.id !== panel.id))}>{t("chartPanelView.remove")}</button>
  </div>}>
    <div className="result-chart-source-info">
      <strong>{t("chartPanelView.dataSource")}</strong>
      <span className={`result-chart-source-badge ${panel.source ? 'result-chart-source-background' : 'result-chart-source-foreground'}`}>
        {panel.source ? t("chartPanelView.background") : t("chartPanelView.foreground")}
      </span>
      <span className="result-chart-page-badge">{panel.source ? t("chartPanelView.source", { value1: panel.source.background_id }) : t("chartPanelView.page", { value1: panel.page })}</span>
    </div>
    {feedback && <p role="status">{feedback}</p>}
    <fieldset className="result-chart-controls" disabled={saving}>{children}</fieldset>
    {settings && <ChartSettings panel={panel} numericNames={numericNames} scatterXNames={[...numericNames, ...timestampNames]}
      outputs={outputs} running={running} hasRows={hasRows} rawLimit={rawLimit} onClose={() => setSettings(false)}
      onApply={settings => {
        onPanelsChange(panels.map(item => item.id === panel.id ? { ...item, ...settings,
          outputs: settings.type === 'histogram' ? item.outputs.slice(0, 1) : item.outputs } : item))
        setSettings(false)
      }} />}
  </Collapsible>
}
