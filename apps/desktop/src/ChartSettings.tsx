import { useEffect, useRef, useState } from 'react'
import { chartSupportsZoom, type AxisSettings, type ChartPanel, type ChartType } from './chartPanels'
import { createChartSettingsDraft, validateChartSettingsDraft, type ChartSettingsDraft } from './chartSettingsModel'

type AxisKey = 'xAxis' | 'yAxis'
type NumericKey = 'min' | 'max' | 'interval'

export default function ChartSettings({ panel, numericNames, running, hasRows, onApply, onClose }: {
  panel: ChartPanel
  numericNames: string[]
  running: boolean
  hasRows: boolean
  onApply: (settings: Pick<ChartPanel, 'title' | 'type' | 'scatterXOutput' | 'showLegend' | 'imageBackground' | 'zoom' | 'xAxis' | 'yAxis'>) => void
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

  function changeScatterXOutput(value: string | null) {
    setDraft(current => ({ ...current, scatterXOutput: value,
      xAxis: { ...current.xAxis,
        title: current.xAxis.title === (current.scatterXOutput ?? 'Iteration')
          ? value ?? 'Iteration' : current.xAxis.title } }))
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
    onCancel={event => event.preventDefault()}>
    <div className="chart-settings-content">
      <h3>Chart Settings</h3>
      <fieldset className="chart-settings-general">
        <legend>General</legend>
        <label className="chart-settings-field">Chart type
          <select value={draft.type} disabled={running || !hasRows} onChange={event => {
            setDraft(current => ({ ...current, type: event.target.value as ChartType }))
            setError(null)
          }}>
            <option value="line">Line</option>
            <option value="scatter">XY Scatter</option>
            <option value="column">Column</option>
            <option value="area">Area</option>
            <option value="bar">Bar</option>
          </select>
        </label>
        <label className="chart-settings-field">Chart title
          <input type="text" autoFocus value={draft.title}
            onChange={event => { setDraft(current => ({ ...current, title: event.target.value })); setError(null) }} />
        </label>
        <label><input type="checkbox" checked={draft.showLegend}
          onChange={event => setDraft(current => ({ ...current, showLegend: event.target.checked }))} />Show legend</label>
      </fieldset>
      {draft.type === 'scatter' && <fieldset className="chart-settings-general">
        <legend>Scatter</legend>
        <label className="chart-settings-field">X source
          <select value={draft.scatterXOutput ?? ''} onChange={event =>
            changeScatterXOutput(event.target.value || null)}>
            <option value="">Iteration</option>
            {numericNames.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </fieldset>}
      {axisFields(draft.type === 'bar' ? 'yAxis' : 'xAxis', 'X Axis')}
      {axisFields(draft.type === 'bar' ? 'xAxis' : 'yAxis', 'Y Axis')}
      {chartSupportsZoom(draft.type) && <fieldset className="chart-settings-general">
        <legend>Zoom</legend>
        <label><input type="checkbox" checked={draft.zoom.enabled}
          onChange={event => setDraft(current => ({ ...current,
            zoom: { ...current.zoom, enabled: event.target.checked } }))} />Enable zoom</label>
        <label><input type="checkbox" checked={draft.zoom.showSlider} disabled={!draft.zoom.enabled}
          onChange={event => setDraft(current => ({ ...current,
            zoom: { ...current.zoom, showSlider: event.target.checked } }))} />Show zoom slider</label>
      </fieldset>}
      <fieldset className="chart-settings-general">
        <legend>Save image</legend>
        <label className="chart-settings-field">Background
          <select value={draft.imageBackground} onChange={event => setDraft(current => ({
            ...current, imageBackground: event.target.value as ChartPanel['imageBackground'],
          }))}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </fieldset>
      {error && <p className="chart-settings-error" role="alert">{error}</p>}
      <div className="chart-settings-actions">
        <button className="action-button" type="button" onClick={onClose}>Cancel</button>
        <button className="action-button action-button-primary" type="button" onClick={apply}>Apply</button>
      </div>
    </div>
  </dialog>
}
