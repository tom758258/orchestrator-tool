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
  outputs = [], running, hasRows, canExport, onSavingChange, children, rawLimit }: {
  panel: ChartPanel; panels: ChartPanel[]; onPanelsChange: (panels: ChartPanel[]) => void
  charts: Map<number, EChartsType>; numericNames: string[]; timestampNames?: string[]; outputs?: OutputStep[]
  running: boolean; hasRows: boolean; canExport: boolean; onSavingChange: (saving: boolean) => void
  children: ReactNode; rawLimit?: number
}) {
  const [settings, setSettings] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const number = panels.findIndex(item => item.id === panel.id) + 1
  async function saveImage() {
    if (savingRef.current) return
    savingRef.current = true; setSaving(true); onSavingChange(true); setFeedback(null)
    try {
      const destinationPath = await save({ defaultPath: `Chart-${number}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] })
      if (!destinationPath) return
      const pngBytes = await chartPng(charts.get(panel.id), panel)
      await invoke('save_chart_png', { destinationPath, pngBytes: Array.from(pngBytes) })
      setFeedback('Chart image saved successfully.')
    } catch (reason) { setFeedback('Could not save chart image: ' + String(reason)) }
    finally { savingRef.current = false; setSaving(false); onSavingChange(false) }
  }
  return <Collapsible title={`Chart ${number}`} className="result-chart-panel" actions={<div className="result-chart-panel-actions">
    <button className="action-button" type="button" disabled={saving || !canExport} onClick={() => void saveImage()}>Export PNG</button>
    <button className="action-button" type="button" disabled={saving} onClick={() => setSettings(true)}>Settings</button>
    <button className="action-button action-button-danger" type="button" aria-label={`Remove Chart ${number}`}
      disabled={saving}
      onClick={() => onPanelsChange(panels.filter(item => item.id !== panel.id))}>Remove</button>
  </div>}>
    <p>{panel.source ? `Background: ${panel.source.background_id} · Value` : `Foreground: ${panel.page}`}</p>
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
