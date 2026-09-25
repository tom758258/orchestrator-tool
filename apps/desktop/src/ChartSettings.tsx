import { useEffect, useRef, useState } from 'react'
import { chartSupportsZoom, comboSeriesSettings, type AxisSettings, type ChartPanel, type ChartType } from './chartPanels'
import { chartTypeAxisTitles, createChartSettingsDraft, validateChartSettingsDraft, type ChartSettingsDraft } from './chartSettingsModel'

type AxisKey = 'xAxis' | 'yAxis' | 'rightAxis'
type NumericKey = 'min' | 'max' | 'interval'

export default function ChartSettings({ panel, numericNames, running, hasRows, onApply, onClose }: {
  panel: ChartPanel
  numericNames: string[]
  running: boolean
  hasRows: boolean
  onApply: (settings: Pick<ChartPanel, 'title' | 'type' | 'scatterXOutput' | 'scatter' | 'showLegend' | 'legendPosition' | 'imageBackground' | 'zoom' | 'xAxis' | 'yAxis' | 'combo' | 'histogram' | 'boxPlot'>) => void
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

  function updateAxis<K extends keyof ChartSettingsDraft['xAxis']>(axis: AxisKey, key: K,
    value: ChartSettingsDraft['xAxis'][K]) {
    setDraft(current => axis === 'rightAxis'
      ? { ...current, combo: { ...current.combo,
        rightAxis: { ...current.combo.rightAxis, [key]: value } } }
      : { ...current, [axis]: { ...current[axis], [key]: value } })
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
    const values = axis === 'rightAxis' ? draft.combo.rightAxis : draft[axis]
    return <fieldset className="chart-settings-axis">
      <legend>{label}</legend>
      <label className="chart-settings-field">Title
        <input type="text" value={values.title} onChange={event => updateAxis(axis, 'title', event.target.value)} />
      </label>
      {(axis !== 'xAxis' || (draft.type !== 'histogram' && draft.type !== 'boxplot')) && <div className="chart-settings-numbers">
        {([['min', 'Minimum'], ['max', 'Maximum'], ['interval', 'Major unit']] as [NumericKey, string][])
          .map(([key, text]) => <label className="chart-settings-field" key={key}>{text}
            <input type="text" inputMode="decimal" placeholder="Auto" value={values[key]}
              onChange={event => updateAxis(axis, key, event.target.value)} />
          </label>)}
      </div>}
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
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
      }
    }}
    onCancel={event => event.preventDefault()}
    onClose={event => {
      if (!event.currentTarget.open && event.currentTarget.isConnected) onClose()
    }}>
    <div className="chart-settings-content">
      <h3>Chart Settings</h3>
      <fieldset className="chart-settings-general">
        <legend>General</legend>
        <label className="chart-settings-field">Chart type
          <select value={draft.type} disabled={running || !hasRows} onChange={event => {
            const type = event.target.value as ChartType
            setDraft(current => {
              const titles = chartTypeAxisTitles(current, type, panel.outputs[0] ?? '')
              return { ...current, type,
                xAxis: { ...current.xAxis, title: titles.x },
                yAxis: { ...current.yAxis, title: titles.y } }
            })
            setError(null)
          }}>
            <option value="line">Line</option>
            <option value="scatter">XY Scatter</option>
            <option value="column">Column</option>
            <option value="area">Area</option>
            <option value="bar">Bar</option>
            <option value="combo">Combo</option>
            <option value="histogram">Histogram</option>
            <option value="boxplot">Box &amp; Whisker</option>
          </select>
        </label>
        <label className="chart-settings-field">Chart title
          <input type="text" autoFocus value={draft.title}
            onChange={event => { setDraft(current => ({ ...current, title: event.target.value })); setError(null) }} />
        </label>
        {draft.type !== 'histogram' && draft.type !== 'boxplot' && <label><input type="checkbox" checked={draft.showLegend}
          onChange={event => setDraft(current => ({ ...current, showLegend: event.target.checked }))} />Show legend</label>}
        {draft.type !== 'histogram' && draft.type !== 'boxplot' && <label className="chart-settings-field">Legend position
          <select value={draft.legendPosition} disabled={!draft.showLegend} onChange={event =>
            setDraft(current => ({ ...current, legendPosition: event.target.value as ChartPanel['legendPosition'] }))}>
            <option value="top">Top</option><option value="bottom">Bottom</option>
            <option value="left">Left</option><option value="right">Right</option>
          </select>
        </label>}
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
        <label className="chart-settings-field">Display
          <select value={draft.scatter.display} onChange={event => setDraft(current => ({ ...current,
            scatter: { ...current.scatter, display: event.target.value as ChartPanel['scatter']['display'] } }))}>
            <option value="markers">Markers</option><option value="lines">Lines</option>
            <option value="lines-markers">Lines + markers</option>
          </select>
        </label>
        {draft.scatter.display !== 'lines' && <label className="chart-settings-field">Marker size
          <input type="text" inputMode="decimal" value={draft.scatter.markerSize}
            onChange={event => { setDraft(current => ({ ...current,
              scatter: { ...current.scatter, markerSize: event.target.value } })); setError(null) }} />
        </label>}
        {draft.scatter.display !== 'markers' && <label className="chart-settings-field">Line width
          <input type="text" inputMode="decimal" value={draft.scatter.lineWidth}
            onChange={event => { setDraft(current => ({ ...current,
              scatter: { ...current.scatter, lineWidth: event.target.value } })); setError(null) }} />
        </label>}
      </fieldset>}
      {axisFields(draft.type === 'bar' ? 'yAxis' : 'xAxis', 'X Axis')}
      {axisFields(draft.type === 'bar' ? 'xAxis' : 'yAxis', draft.type === 'combo' ? 'Left Y Axis' : 'Y Axis')}
      {draft.type === 'combo' && <>
        {axisFields('rightAxis', 'Right Y Axis')}
        <fieldset className="chart-settings-general"><legend>Combo</legend>
          {panel.outputs.filter(name => numericNames.includes(name)).map((name, index) => {
            const series = draft.combo.series[name] ?? comboSeriesSettings(panel, name, index)
            const update = (key: 'kind' | 'axis', value: string) => setDraft(current => ({
              ...current, combo: { ...current.combo, series: { ...current.combo.series,
                [name]: { ...series, [key]: value } } },
            }))
            return <div key={name}><strong>{name}</strong>
              <label className="chart-settings-field">Type<select value={series.kind}
                onChange={event => update('kind', event.target.value)}>
                <option value="column">Column</option><option value="line">Line</option></select></label>
              <label className="chart-settings-field">Axis<select value={series.axis}
                onChange={event => update('axis', event.target.value)}>
                <option value="left">Left Y</option><option value="right">Right Y</option></select></label>
            </div>
          })}
        </fieldset>
      </>}
      {draft.type === 'histogram' && <fieldset className="chart-settings-general"><legend>Histogram</legend>
        <div>Bins</div>
        {(['auto', 'count', 'width'] as const).map(mode => <label key={mode}>
          <input type="radio" name="histogram-mode" checked={draft.histogram.mode === mode}
            onChange={() => setDraft(current => ({ ...current, histogram: {
              mode, value: mode === 'auto' ? '' : mode === 'count' ? '20' : '0.5',
            } }))} />{mode === 'auto' ? 'Auto' : mode === 'count' ? 'Count' : 'Width'}
          {mode !== 'auto' && <input type="text" inputMode="decimal"
            aria-label={`${mode} bins`} disabled={draft.histogram.mode !== mode}
            value={draft.histogram.mode === mode ? draft.histogram.value : ''}
            onChange={event => setDraft(current => ({ ...current,
              histogram: { mode, value: event.target.value } }))} />}
        </label>)}
      </fieldset>}
      {draft.type === 'boxplot' && <fieldset className="chart-settings-general"><legend>Box &amp; Whisker</legend>
        <label><input type="checkbox" checked={draft.boxPlot.showOutliers}
          onChange={event => setDraft(current => ({ ...current,
            boxPlot: { showOutliers: event.target.checked } }))} />Show outliers</label>
      </fieldset>}
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
