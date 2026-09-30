import { useEffect, useRef, useState } from 'react'
import { chartSupportsZoom, comboSeriesSettings, lineSeriesSettings, markerStyleSettings,
  type AxisSettings, type ChartPanel, type ChartType, type MarkerShape } from './chartPanels'
import { chartTypeAxisTitles, createChartSettingsDraft, validateChartSettingsDraft, type ChartSettingsDraft } from './chartSettingsModel'

type AxisKey = 'xAxis' | 'yAxis' | 'rightAxis'
type NumericKey = 'min' | 'max' | 'interval'
type MarkerDraft = ChartSettingsDraft['markerStyles'][string]
const settingsTabs = ['General', 'Series', 'Axes', 'Analysis', 'Export'] as const

export default function ChartSettings({ panel, numericNames, running, hasRows, onApply, onClose }: {
  panel: ChartPanel
  numericNames: string[]
  running: boolean
  hasRows: boolean
  onApply: (settings: Pick<ChartPanel, 'title' | 'type' | 'scatterXOutput' | 'scatter' | 'line' | 'markerStyles' | 'seriesColors' | 'showLegend' | 'legendPosition' | 'imageBackground' | 'showAllRawData' | 'zoom' | 'xAxis' | 'yAxis' | 'combo' | 'histogram' | 'boxPlot'>) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(() => createChartSettingsDraft(panel))
  const [tab, setTab] = useState<typeof settingsTabs[number]>('General')
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

  function defaultMarkerDraft(name: string): MarkerDraft {
    const marker = markerStyleSettings(panel, name)
    return { ...marker, size: String(marker.size) }
  }

  function markerDraft(name: string): MarkerDraft {
    return Object.prototype.hasOwnProperty.call(draft.markerStyles, name)
      ? draft.markerStyles[name] : defaultMarkerDraft(name)
  }

  function updateMarker<K extends keyof MarkerDraft>(name: string, key: K, value: MarkerDraft[K]) {
    setDraft(current => {
      const marker = Object.prototype.hasOwnProperty.call(current.markerStyles, name)
        ? current.markerStyles[name] : defaultMarkerDraft(name)
      return { ...current, markerStyles: {
        ...current.markerStyles, [name]: { ...marker, [key]: value },
      } }
    })
    setError(null)
  }

  function automaticSeriesColor(name: string): string {
    if (Object.prototype.hasOwnProperty.call(draft.seriesColors, name)) return draft.seriesColors[name]
    return getComputedStyle(document.documentElement)
      .getPropertyValue(`--chart-series-${numericNames.indexOf(name) % 6 + 1}`).trim()
  }

  function markerFields(name: string, includeSize: boolean) {
    const marker = markerDraft(name)
    const colorField = (key: 'fillColor' | 'borderColor', label: string) => <>
      <label className="chart-settings-field">{label}
        <select value={marker[key] === null ? 'auto' : 'custom'} onChange={event =>
          updateMarker(name, key, event.target.value === 'custom' ? automaticSeriesColor(name) : null)}>
          <option value="auto">Auto</option><option value="custom">Custom color</option>
        </select>
      </label>
      {marker[key] !== null && <label className="chart-settings-field">Custom {label.toLowerCase()}
        <input type="color" value={marker[key] ?? ''} onChange={event => updateMarker(name, key, event.target.value)} />
      </label>}
    </>
    return <>
      {includeSize && <label className="chart-settings-field">Marker size
        <input type="text" inputMode="decimal" value={marker.size}
          onChange={event => updateMarker(name, 'size', event.target.value)} />
      </label>}
      <label className="chart-settings-field">Marker shape
        <select value={marker.shape} onChange={event =>
          updateMarker(name, 'shape', event.target.value as MarkerShape)}>
          <option value="circle">Circle</option><option value="square">Square</option>
          <option value="diamond">Diamond</option><option value="triangle">Triangle</option>
        </select>
      </label>
      {colorField('fillColor', 'Marker fill')}
      {colorField('borderColor', 'Marker border')}
    </>
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
      <div className="chart-settings-tabs" role="tablist" aria-label="Chart settings sections">
        {settingsTabs.map(name => <button key={name}
          type="button" role="tab" id={`chart-settings-tab-${name}`} aria-selected={tab === name}
          aria-controls={`chart-settings-panel-${name}`} tabIndex={tab === name ? 0 : -1}
          onClick={() => setTab(name)} onKeyDown={event => {
            const names = settingsTabs
            const index = names.indexOf(name)
            const next = event.key === 'ArrowRight' ? names[(index + 1) % names.length]
              : event.key === 'ArrowLeft' ? names[(index + names.length - 1) % names.length]
              : event.key === 'Home' ? names[0] : event.key === 'End' ? names[names.length - 1] : null
            if (next) {
              event.preventDefault()
              setTab(next)
              document.getElementById(`chart-settings-tab-${next}`)?.focus()
            }
          }}>{name}</button>)}
      </div>
      <div role="tabpanel" id="chart-settings-panel-General" aria-labelledby="chart-settings-tab-General" hidden={tab !== 'General'}>
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
        {draft.type === 'combo' && <p className="chart-settings-help">
          Combo requires at least two selected Outputs.
        </p>}
        {draft.type === 'histogram' && <p className="chart-settings-help">
          Histogram uses exactly one Output. If multiple Outputs are currently selected,
          Apply keeps the first selected Output.
        </p>}
        {draft.type === 'line' && <>
          <label><input type="checkbox" checked={draft.showAllRawData}
            onChange={event => setDraft(current => ({ ...current, showAllRawData: event.target.checked }))} />
            Show All Raw Data</label>
          <p className="chart-settings-help">Displaying all raw data bypasses downsampling and may
            cause the Desktop interface to lag, especially during Live execution. Line markers
            remain separately configurable in Series.</p>
        </>}
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
      </div>
      <div role="tabpanel" id="chart-settings-panel-Series" aria-labelledby="chart-settings-tab-Series" hidden={tab !== 'Series'}>
      {draft.type !== 'boxplot' && <fieldset className="chart-settings-general"><legend>Series colors</legend>
        {(draft.type === 'histogram' ? panel.outputs.slice(0, 1) : panel.outputs)
          .filter(name => numericNames.includes(name)).map(name => <div key={name}>
            <strong>{name}</strong>
            <label className="chart-settings-field">Color
              <select value={Object.prototype.hasOwnProperty.call(draft.seriesColors, name) ? 'custom' : 'auto'} onChange={event => {
                const custom = event.target.value === 'custom'
                const palette = getComputedStyle(document.documentElement)
                  .getPropertyValue(`--chart-series-${draft.type === 'histogram' ? 1 : numericNames.indexOf(name) % 6 + 1}`).trim()
                setDraft(current => {
                  const seriesColors = custom
                    ? { ...current.seriesColors, [name]: palette } : { ...current.seriesColors }
                  if (!custom) delete seriesColors[name]
                  return { ...current, seriesColors }
                })
              }}><option value="auto">Auto</option><option value="custom">Custom color</option></select>
            </label>
            {Object.prototype.hasOwnProperty.call(draft.seriesColors, name) && <label className="chart-settings-field">Custom color
              <input type="color" value={draft.seriesColors[name]} onChange={event =>
                setDraft(current => ({ ...current, seriesColors: { ...current.seriesColors, [name]: event.target.value } }))} />
            </label>}
          </div>)}
      </fieldset>}
      {draft.type === 'line' && <fieldset className="chart-settings-general"><legend>Line</legend>
        {panel.outputs.filter(name => numericNames.includes(name)).map(name => {
          const series = Object.prototype.hasOwnProperty.call(draft.line.series, name)
            ? draft.line.series[name] : lineSeriesSettings(panel, name)
          return <div key={name}><strong>{name}</strong>
            <label className="chart-settings-field">Style
              <select value={series.markers ? 'line-markers' : 'line'} onChange={event =>
                setDraft(current => ({ ...current, line: { series: { ...current.line.series,
                  [name]: { markers: event.target.value === 'line-markers' },
                } } }))}>
                <option value="line">Line</option><option value="line-markers">Line + markers</option>
              </select>
            </label>
            <details className="chart-marker-appearance">
              <summary>Marker appearance (including Significant Change Markers)</summary>
              {markerFields(name, true)}
            </details>
          </div>
        })}
      </fieldset>}
      {draft.type === 'boxplot' && <p>No series options for this chart type.</p>}
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
          <select value={draft.scatter.display} onChange={event => {
            setDraft(current => ({ ...current,
              scatter: { ...current.scatter, display: event.target.value as ChartPanel['scatter']['display'] } }))
            setError(null)
          }}>
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
        {draft.scatter.display !== 'lines' && panel.outputs.filter(name => numericNames.includes(name))
          .map(name => <div key={name}><strong>{name}</strong>{markerFields(name, false)}</div>)}
      </fieldset>}
      {draft.type === 'combo' && <>
        <fieldset className="chart-settings-general"><legend>Combo</legend>
          {panel.outputs.filter(name => numericNames.includes(name)).map((name, index) => {
            const series = Object.prototype.hasOwnProperty.call(draft.combo.series, name)
              ? draft.combo.series[name] : comboSeriesSettings(panel, name, index)
            const type = series.kind === 'column' ? 'column' : series.markers ? 'line-markers' : 'line'
            const updateAxis = (axis: 'left' | 'right') => setDraft(current => ({
              ...current, combo: { ...current.combo, series: { ...current.combo.series,
                [name]: { ...series, axis } } },
            }))
            const updateType = (value: string) => setDraft(current => ({
              ...current,
              combo: {
                ...current.combo,
                series: {
                  ...current.combo.series,
                  [name]: value === 'column'
                    ? { ...series, kind: 'column', markers: false }
                    : { ...series, kind: 'line', markers: value === 'line-markers' },
                },
              },
            }))
            return <div key={name}><strong>{name}</strong>
              <label className="chart-settings-field">Type<select value={type}
                onChange={event => updateType(event.target.value)}>
                <option value="column">Column</option><option value="line">Line</option>
                <option value="line-markers">Line + markers</option></select></label>
              <label className="chart-settings-field">Axis<select value={series.axis}
                onChange={event => updateAxis(event.target.value as 'left' | 'right')}>
                <option value="left">Left Y</option><option value="right">Right Y</option></select></label>
              {series.kind === 'line' && series.markers && markerFields(name, true)}
            </div>
          })}
        </fieldset>
      </>}
      </div>
      <div role="tabpanel" id="chart-settings-panel-Axes" aria-labelledby="chart-settings-tab-Axes" hidden={tab !== 'Axes'}>
      {axisFields(draft.type === 'bar' ? 'yAxis' : 'xAxis', 'X Axis')}
      {axisFields(draft.type === 'bar' ? 'xAxis' : 'yAxis', draft.type === 'combo' ? 'Left Y Axis' : 'Y Axis')}
      {draft.type === 'combo' && axisFields('rightAxis', 'Right Y Axis')}
      {chartSupportsZoom(draft.type) && <fieldset className="chart-settings-general">
        <legend>Zoom</legend>
        <label><input type="checkbox" checked={draft.zoom.enabled}
          onChange={event => setDraft(current => ({ ...current,
            zoom: { ...current.zoom, enabled: event.target.checked } }))} />Enable zoom</label>
        <label><input type="checkbox" checked={draft.zoom.showSlider} disabled={!draft.zoom.enabled}
          onChange={event => setDraft(current => ({ ...current,
            zoom: { ...current.zoom, showSlider: event.target.checked } }))} />Show zoom slider</label>
      </fieldset>}
      </div>
      <div role="tabpanel" id="chart-settings-panel-Analysis" aria-labelledby="chart-settings-tab-Analysis" hidden={tab !== 'Analysis'}>
      {draft.type === 'histogram' && <fieldset className="chart-settings-general"><legend>Histogram</legend>
        <div>Bins</div>
        {(['auto', 'count', 'width'] as const).map(mode => <label key={mode}>
          <input type="radio" name="histogram-mode" checked={draft.histogram.mode === mode}
            onChange={() => setDraft(current => ({ ...current, histogram: {
              ...current.histogram, mode, value: mode === 'auto' ? '' : mode === 'count' ? '20' : '0.5',
            } }))} />{mode === 'auto' ? 'Auto' : mode === 'count' ? 'Count' : 'Width'}
          {mode !== 'auto' && <input type="text" inputMode="decimal"
            aria-label={`${mode} bins`} disabled={draft.histogram.mode !== mode}
            value={draft.histogram.mode === mode ? draft.histogram.value : ''}
            onChange={event => setDraft(current => ({ ...current,
              histogram: { ...current.histogram, mode, value: event.target.value } }))} />}
        </label>)}
      </fieldset>}
      {draft.type === 'histogram' && <fieldset className="chart-settings-general"><legend>Normal curve</legend>
        <label><input type="checkbox" checked={draft.histogram.showNormalCurve} onChange={event =>
          setDraft(current => ({ ...current, histogram: { ...current.histogram, showNormalCurve: event.target.checked } }))} />Show normal curve</label>
        {([['mean', 'Mean'], ['stdDev', 'Std Dev']] as const).map(([key, label]) =>
          <label className="chart-settings-field" key={key}>{label}
            <input type="text" inputMode="decimal" placeholder="Auto" value={draft.histogram[key]}
              onChange={event => { setDraft(current => ({ ...current,
                histogram: { ...current.histogram, [key]: event.target.value } })); setError(null) }} />
          </label>)}
      </fieldset>}
      {draft.type === 'boxplot' && <fieldset className="chart-settings-general"><legend>Box &amp; Whisker</legend>
        <label><input type="checkbox" checked={draft.boxPlot.showOutliers}
          onChange={event => setDraft(current => ({ ...current,
            boxPlot: { showOutliers: event.target.checked } }))} />Show outliers</label>
      </fieldset>}
      {draft.type !== 'histogram' && draft.type !== 'boxplot' && <p>No analysis options for this chart type.</p>}
      </div>
      <div role="tabpanel" id="chart-settings-panel-Export" aria-labelledby="chart-settings-tab-Export" hidden={tab !== 'Export'}>
      <fieldset className="chart-settings-general">
        <legend>Export PNG</legend>
        <label className="chart-settings-field">Background
          <select value={draft.imageBackground} onChange={event => setDraft(current => ({
            ...current, imageBackground: event.target.value as ChartPanel['imageBackground'],
          }))}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </fieldset>
      <p>PNG includes the chart title, legend, axes, plot, and current zoom range.
        Output selection controls, chart action buttons, the zoom slider, and Reset Zoom are excluded.</p>
      </div>
      {error && <p className="chart-settings-error" role="alert">{error}</p>}
      <div className="chart-settings-actions">
        <button className="action-button" type="button" onClick={onClose}>Cancel</button>
        <button className="action-button action-button-primary" type="button" onClick={apply}>Apply</button>
      </div>
    </div>
  </dialog>
}
