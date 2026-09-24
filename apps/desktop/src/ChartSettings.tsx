import { useEffect, useRef, useState } from 'react'
import type { AxisSettings, ChartPanel } from './chartPanels'
import { createChartSettingsDraft, validateChartSettingsDraft, type ChartSettingsDraft } from './chartSettingsModel'

type AxisKey = 'xAxis' | 'yAxis'
type NumericKey = 'min' | 'max' | 'interval'

export default function ChartSettings({ panel, onApply, onClose }: {
  panel: ChartPanel
  onApply: (settings: Pick<ChartPanel, 'title' | 'showLegend' | 'xAxis' | 'yAxis'>) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(() => createChartSettingsDraft(panel))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  function updateAxis<K extends keyof ChartSettingsDraft[AxisKey]>(axis: AxisKey, key: K,
    value: ChartSettingsDraft[AxisKey][K]) {
    setDraft(current => ({ ...current, [axis]: { ...current[axis], [key]: value } }))
    setError(null)
  }

  function apply() {
    const result = validateChartSettingsDraft(draft)
    if (!result.settings) {
      setError(result.error)
      return
    }
    onApply(result.settings)
  }

  function axisFields(axis: AxisKey, label: string) {
    const values = draft[axis]
    return <fieldset className="chart-settings-axis">
      <legend>{label}</legend>
      <label className="chart-settings-field">Title
        <input type="text" value={values.title} onChange={event => updateAxis(axis, 'title', event.target.value)} />
      </label>
      <div className="chart-settings-numbers">
        {([['min', 'Minimum'], ['max', 'Maximum'], ['interval', 'Major unit']] as [NumericKey, string][])
          .map(([key, text]) => <label className="chart-settings-field" key={key}>{text}
            <input type="text" inputMode="decimal" placeholder="Auto" value={values[key]}
              onChange={event => updateAxis(axis, key, event.target.value)} />
          </label>)}
      </div>
      <div className="chart-settings-toggles">
        {([['showLabels', 'Show labels'], ['showTicks', 'Show tick marks'],
          ['showMajorGrid', 'Show major gridlines']] as [keyof Pick<AxisSettings,
            'showLabels' | 'showTicks' | 'showMajorGrid'>, string][])
          .map(([key, text]) => <label key={key}><input type="checkbox" checked={values[key]}
            onChange={event => updateAxis(axis, key, event.target.checked)} />{text}</label>)}
      </div>
    </fieldset>
  }

  return <dialog ref={dialog} className="chart-settings-dialog" aria-label="Chart Settings"
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === dialog.current) onClose() }}>
    <div className="chart-settings-content">
      <h3>Chart Settings</h3>
      <fieldset className="chart-settings-general">
        <legend>General</legend>
        <label className="chart-settings-field">Chart title
          <input type="text" autoFocus value={draft.title}
            onChange={event => { setDraft(current => ({ ...current, title: event.target.value })); setError(null) }} />
        </label>
        <label><input type="checkbox" checked={draft.showLegend}
          onChange={event => setDraft(current => ({ ...current, showLegend: event.target.checked }))} />Show legend</label>
      </fieldset>
      {axisFields('xAxis', 'X Axis')}
      {axisFields('yAxis', 'Y Axis')}
      {error && <p className="chart-settings-error" role="alert">{error}</p>}
      <div className="chart-settings-actions">
        <button className="action-button" type="button" onClick={onClose}>Cancel</button>
        <button className="action-button action-button-primary" type="button" onClick={apply}>Apply</button>
      </div>
    </div>
  </dialog>
}
