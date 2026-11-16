import { enumLabel } from './i18n/presentation'
import { useI18n } from './i18n/I18nProvider'
import { useEffect, useRef, useState } from 'react'
import type { OutputStep } from './workflow'
import { chartSupportsZoom, comboSeriesSettings, lineSeriesSettings, markerStyleSettings,
  type AxisSettings, type ChartPanel, type ChartType, type MarkerShape } from './chartPanels'
import { chartTypeAxisTitles, createChartSettingsDraft, validateChartSettingsDraft, type ChartSettingsDraft } from './chartSettingsModel'

type AxisKey = 'xAxis' | 'yAxis' | 'rightAxis'
type NumericKey = 'min' | 'max' | 'interval'
type MarkerDraft = ChartSettingsDraft['markerStyles'][string]
const settingsTabs = ['General', 'Series', 'Axes', 'Analysis', 'Export'] as const

export default function ChartSettings({ panel, numericNames, scatterXNames = numericNames, outputs, running, hasRows, onApply, onClose, rawLimit }: {
  panel: ChartPanel
  numericNames: string[]
  scatterXNames?: string[]
  outputs: readonly OutputStep[]
  running: boolean
  rawLimit?: number
  hasRows: boolean
  onApply: (settings: Pick<ChartPanel, 'title' | 'type' | 'scatterXOutput' | 'scatter' | 'line' | 'markerStyles' | 'seriesColors' | 'showLegend' | 'legendPosition' | 'imageBackground' | 'showAllRawData' | 'zoom' | 'xAxis' | 'yAxis' | 'combo' | 'histogram' | 'boxPlot'>) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(() => createChartSettingsDraft(panel))
  const [tab, setTab] = useState<typeof settingsTabs[number]>('General')
  const [validationAttempted, setValidationAttempted] = useState(false)
  const [typeError, setTypeError] = useState(false)
  const error = typeError ? t("chartSettings.onlyLineOrTheCurrentChartTypeCanBe")
    : validationAttempted ? validateChartSettingsDraft(draft, t).error ?? null : null
  const setError = (value: string | null) => { setValidationAttempted(value !== null); if (value === null) setTypeError(false) }

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
    if (running && draft.type !== panel.type && draft.type !== 'line') {
      setTypeError(true)
      return
    }
    const result = validateChartSettingsDraft(draft, t)
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
          <option value="auto">{t("chartSettings.auto")}</option><option value="custom">{t("chartSettings.customColor")}</option>
        </select>
      </label>
      {marker[key] !== null && <label className="chart-settings-field">{t("chartSettings.custom")}{label.toLowerCase()}
        <input type="color" value={marker[key] ?? ''} onChange={event => updateMarker(name, key, event.target.value)} />
      </label>}
    </>
    return <>
      {includeSize && <label className="chart-settings-field">{t("chartSettings.markerSize")}<input type="text" inputMode="decimal" value={marker.size}
          onChange={event => updateMarker(name, 'size', event.target.value)} />
      </label>}
      <label className="chart-settings-field">{t("chartSettings.markerShape")}<select value={marker.shape} onChange={event =>
          updateMarker(name, 'shape', event.target.value as MarkerShape)}>
          <option value="circle">{t("chartSettings.circle")}</option><option value="square">{t("chartSettings.square")}</option>
          <option value="diamond">{t("chartSettings.diamond")}</option><option value="triangle">{t("chartSettings.triangle")}</option>
        </select>
      </label>
      {colorField('fillColor', t("chartSettings.markerFill"))}
      {colorField('borderColor', t("chartSettings.markerBorder"))}
    </>
  }

  function axisFields(axis: AxisKey, label: string) {
    const values = axis === 'rightAxis' ? draft.combo.rightAxis : draft[axis]
    return <fieldset className="chart-settings-axis">
      <legend>{label}</legend>
      <label className="chart-settings-field">{t("chartSettings.title")}<input type="text" value={values.title} onChange={event => updateAxis(axis, 'title', event.target.value)} />
      </label>
      {(axis !== 'xAxis' || (draft.type !== 'histogram' && draft.type !== 'boxplot')) && <div className="chart-settings-numbers">
        {([['min', t("chartSettings.minimum")], ['max', t("chartSettings.maximum")], ['interval', t("chartSettings.majorUnit")]] as [NumericKey, string][])
          .map(([key, text]) => <label className="chart-settings-field" key={key}>{text}
            <input type="text" inputMode="decimal" placeholder={t("chartSettings.auto")} value={values[key]}
              onChange={event => updateAxis(axis, key, event.target.value)} />
          </label>)}
      </div>}
      {axis === 'xAxis' && draft.type === 'scatter' && outputs.some(output =>
        output.name === draft.scatterXOutput && output.value.source === 'elapsed-time') && <p className="chart-settings-help">
        {t("chartSettings.xAxisMinimumMaximumAndMajorUnitUseRaw")}</p>}
      <div className="chart-settings-toggles">
        {([['showLabels', t("chartSettings.showLabels")], ['showTicks', t("chartSettings.showTickMarks")],
          ['showMajorGrid', t("chartSettings.showMajorGridlines")]] as [keyof Pick<AxisSettings,
            'showLabels' | 'showTicks' | 'showMajorGrid'>, string][])
          .map(([key, text]) => <label key={key}><input type="checkbox" checked={values[key]}
            onChange={event => updateAxis(axis, key, event.target.checked)} />{text}</label>)}
      </div>
    </fieldset>
  }

  return <dialog ref={dialog} className="chart-settings-dialog" aria-label={t("chartSettings.chartSettings")}
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
      <h3>{t("chartSettings.chartSettings")}</h3>
      <div className="chart-settings-tabs" role="tablist" aria-label={t("chartSettings.chartSettingsSections")}>
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
          }}>{t(`chartSettings.tab.${name}`)}</button>)}
      </div>
      <div role="tabpanel" id="chart-settings-panel-General" aria-labelledby="chart-settings-tab-General" hidden={tab !== 'General'}>
      <fieldset className="chart-settings-general">
        <legend>{t("chartSettings.general")}</legend>
        <label className="chart-settings-field">{t("chartSettings.chartType")}<select value={draft.type} disabled={running ? panel.type === 'line' : !hasRows && !panel.source} onChange={event => {
            const type = event.target.value as ChartType
            setDraft(current => {
              const titles = chartTypeAxisTitles(current, type, panel.outputs[0] ?? '')
              return { ...current, type,
                xAxis: { ...current.xAxis, title: titles.x },
                yAxis: { ...current.yAxis, title: titles.y } }
            })
            setError(null)
          }}>
            <option value="line">{t("chartSettings.line")}</option>
            <option value="scatter" disabled={running && panel.type !== 'scatter'}>{t("chartSettings.xYScatter")}</option>
            <option value="column" disabled={running && panel.type !== 'column'}>{t("chartSettings.column")}</option>
            <option value="area" disabled={running && panel.type !== 'area'}>{t("chartSettings.area")}</option>
            <option value="bar" disabled={running && panel.type !== 'bar'}>{t("chartSettings.bar")}</option>
            {!panel.source && <option value="combo" disabled={running && panel.type !== 'combo'}>{t("chartSettings.combo")}</option>}
            {!panel.source && <option value="histogram" disabled={running && panel.type !== 'histogram'}>{t("chartSettings.histogram")}</option>}
            {!panel.source && <option value="boxplot" disabled={running && panel.type !== 'boxplot'}>{t("chartSettings.boxAmpWhisker")}</option>}
          </select>
        </label>
        {draft.type === 'combo' && <p className="chart-settings-help">
          {t("chartSettings.comboRequiresAtLeastTwoSelectedOutputs")}</p>}
        {draft.type === 'histogram' && <p className="chart-settings-help">
          {t("chartSettings.histogramUsesExactlyOneOutputIfMultipleOutputsAre")}</p>}
        {draft.type === 'line' && <>
          <label><input type="checkbox" checked={draft.showAllRawData}
            onChange={event => setDraft(current => ({ ...current, showAllRawData: event.target.checked }))} />
            {t("chartSettings.showAllRawData")}</label>
          <p className="chart-settings-help">{t("chartSettings.displayingAllRawDataBypassesDownsamplingAndMayCause")}</p>
          {panel.source && <p className="chart-settings-help">{t("chartSettings.backgroundLineDisplaysAtMost")}{rawLimit?.toLocaleString() ?? "25,000"} {t("chartSettings.rawSamplesPerVisibleRangeAboveThisLimitNarrow")}</p>}
        </>}
        <label className="chart-settings-field">{t("chartSettings.chartTitle")}<input type="text" autoFocus value={draft.title}
            onChange={event => { setDraft(current => ({ ...current, title: event.target.value })); setError(null) }} />
        </label>
        {draft.type !== 'histogram' && draft.type !== 'boxplot' && <label><input type="checkbox" checked={draft.showLegend}
          onChange={event => setDraft(current => ({ ...current, showLegend: event.target.checked }))} />{t("chartSettings.showLegend")}</label>}
        {draft.type !== 'histogram' && draft.type !== 'boxplot' && <label className="chart-settings-field">{t("chartSettings.legendPosition")}<select value={draft.legendPosition} disabled={!draft.showLegend} onChange={event =>
            setDraft(current => ({ ...current, legendPosition: event.target.value as ChartPanel['legendPosition'] }))}>
            <option value="top">{t("chartSettings.top")}</option><option value="bottom">{t("chartSettings.bottom")}</option>
            <option value="left">{t("chartSettings.left")}</option><option value="right">{t("chartSettings.right")}</option>
          </select>
        </label>}
      </fieldset>
      </div>
      <div role="tabpanel" id="chart-settings-panel-Series" aria-labelledby="chart-settings-tab-Series" hidden={tab !== 'Series'}>
      {draft.type !== 'boxplot' && <fieldset className="chart-settings-general"><legend>{t("chartSettings.seriesColors")}</legend>
        {(draft.type === 'histogram' ? panel.outputs.slice(0, 1) : panel.outputs)
          .filter(name => numericNames.includes(name)).map(name => <div key={name}>
            <strong>{name}</strong>
            <label className="chart-settings-field">{t("chartSettings.color")}<select value={Object.prototype.hasOwnProperty.call(draft.seriesColors, name) ? 'custom' : 'auto'} onChange={event => {
                const custom = event.target.value === 'custom'
                const palette = getComputedStyle(document.documentElement)
                  .getPropertyValue(`--chart-series-${draft.type === 'histogram' ? 1 : numericNames.indexOf(name) % 6 + 1}`).trim()
                setDraft(current => {
                  const seriesColors = custom
                    ? { ...current.seriesColors, [name]: palette } : { ...current.seriesColors }
                  if (!custom) delete seriesColors[name]
                  return { ...current, seriesColors }
                })
              }}><option value="auto">{t("chartSettings.auto")}</option><option value="custom">{t("chartSettings.customColor")}</option></select>
            </label>
            {Object.prototype.hasOwnProperty.call(draft.seriesColors, name) && <label className="chart-settings-field">{t("chartSettings.customColor")}<input type="color" value={draft.seriesColors[name]} onChange={event =>
                setDraft(current => ({ ...current, seriesColors: { ...current.seriesColors, [name]: event.target.value } }))} />
            </label>}
          </div>)}
      </fieldset>}
      {draft.type === 'line' && <fieldset className="chart-settings-general"><legend>{t("chartSettings.line")}</legend>
        {panel.outputs.filter(name => numericNames.includes(name)).map(name => {
          const series = Object.prototype.hasOwnProperty.call(draft.line.series, name)
            ? draft.line.series[name] : lineSeriesSettings(panel, name)
          return <div key={name}><strong>{name}</strong>
            <label className="chart-settings-field">{t("chartSettings.style")}<select value={series.markers ? 'line-markers' : 'line'} onChange={event =>
                setDraft(current => ({ ...current, line: { series: { ...current.line.series,
                  [name]: { markers: event.target.value === 'line-markers' },
                } } }))}>
                <option value="line">{t("chartSettings.line")}</option><option value="line-markers">{t("chartSettings.lineMarkers")}</option>
              </select>
            </label>
            <details className="chart-marker-appearance">
              <summary>{t("chartSettings.markerAppearanceIncludingSignificantChangeMarkers")}</summary>
              {markerFields(name, true)}
            </details>
          </div>
        })}
      </fieldset>}
      {draft.type === 'boxplot' && <p>{t("chartSettings.noSeriesOptionsForThisChartType")}</p>}
      {draft.type === 'scatter' && <fieldset className="chart-settings-general">
        <legend>{t("chartSettings.scatter")}</legend>
        {!panel.source && <label className="chart-settings-field">{t("chartSettings.xSource")}<select value={draft.scatterXOutput ?? ''} onChange={event =>
            changeScatterXOutput(event.target.value || null)}>
            <option value="">{t("chartSettings.iteration")}</option>
            {scatterXNames.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        <label className="chart-settings-field">{t("chartSettings.display")}<select value={draft.scatter.display} onChange={event => {
            setDraft(current => ({ ...current,
              scatter: { ...current.scatter, display: event.target.value as ChartPanel['scatter']['display'] } }))
            setError(null)
          }}>
            <option value="markers">{t("chartSettings.markers")}</option><option value="lines">{t("chartSettings.lines")}</option>
            <option value="lines-markers">{t("chartSettings.linesMarkers")}</option>
          </select>
        </label>
        {draft.scatter.display !== 'lines' && <label className="chart-settings-field">{t("chartSettings.markerSize")}<input type="text" inputMode="decimal" value={draft.scatter.markerSize}
            onChange={event => { setDraft(current => ({ ...current,
              scatter: { ...current.scatter, markerSize: event.target.value } })); setError(null) }} />
        </label>}
        {draft.scatter.display !== 'markers' && <label className="chart-settings-field">{t("chartSettings.lineWidth")}<input type="text" inputMode="decimal" value={draft.scatter.lineWidth}
            onChange={event => { setDraft(current => ({ ...current,
              scatter: { ...current.scatter, lineWidth: event.target.value } })); setError(null) }} />
        </label>}
        {draft.scatter.display !== 'lines' && panel.outputs.filter(name => numericNames.includes(name))
          .map(name => <div key={name}><strong>{name}</strong>{markerFields(name, false)}</div>)}
      </fieldset>}
      {draft.type === 'combo' && <>
        <fieldset className="chart-settings-general"><legend>{t("chartSettings.combo")}</legend>
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
              <label className="chart-settings-field">{t("chartSettings.type")}<select value={type}
                onChange={event => updateType(event.target.value)}>
                <option value="column">{t("chartSettings.column")}</option><option value="line">{t("chartSettings.line")}</option>
                <option value="line-markers">{t("chartSettings.lineMarkers")}</option></select></label>
              <label className="chart-settings-field">{t("chartSettings.axis")}<select value={series.axis}
                onChange={event => updateAxis(event.target.value as 'left' | 'right')}>
                <option value="left">{t("chartSettings.leftY")}</option><option value="right">{t("chartSettings.rightY")}</option></select></label>
              {series.kind === 'line' && series.markers && markerFields(name, true)}
            </div>
          })}
        </fieldset>
      </>}
      </div>
      <div role="tabpanel" id="chart-settings-panel-Axes" aria-labelledby="chart-settings-tab-Axes" hidden={tab !== 'Axes'}>
      {axisFields(draft.type === 'bar' ? 'yAxis' : 'xAxis', t("chartSettings.xAxis"))}
      {axisFields(draft.type === 'bar' ? 'xAxis' : 'yAxis', draft.type === 'combo' ? t("chartSettings.leftYAxis") : t("chartSettings.yAxis"))}
      {draft.type === 'combo' && axisFields('rightAxis', t("chartSettings.rightYAxis"))}
      {chartSupportsZoom(draft.type) && <fieldset className="chart-settings-general">
        <legend>{t("chartSettings.zoom")}</legend>
        <label><input type="checkbox" checked={draft.zoom.enabled}
          onChange={event => setDraft(current => ({ ...current,
            zoom: { ...current.zoom, enabled: event.target.checked } }))} />{t("chartSettings.enableZoom")}</label>
        <label><input type="checkbox" checked={draft.zoom.showSlider} disabled={!draft.zoom.enabled}
          onChange={event => setDraft(current => ({ ...current,
            zoom: { ...current.zoom, showSlider: event.target.checked } }))} />{t("chartSettings.showZoomSlider")}</label>
      </fieldset>}
      </div>
      <div role="tabpanel" id="chart-settings-panel-Analysis" aria-labelledby="chart-settings-tab-Analysis" hidden={tab !== 'Analysis'}>
      {draft.type === 'histogram' && <fieldset className="chart-settings-general"><legend>{t("chartSettings.histogram")}</legend>
        <div>{t("chartSettings.bins")}</div>
        {(['auto', 'count', 'width'] as const).map(mode => <label key={mode}>
          <input type="radio" name="histogram-mode" checked={draft.histogram.mode === mode}
            onChange={() => setDraft(current => ({ ...current, histogram: {
              ...current.histogram, mode, value: mode === 'auto' ? '' : mode === 'count' ? '20' : '0.5',
            } }))} />{mode === 'auto' ? t("chartSettings.auto") : mode === 'count' ? t("chartSettings.count") : t("chartSettings.width")}
          {mode !== 'auto' && <input type="text" inputMode="decimal"
            aria-label={t("chartSettings.bins2", { value1: enumLabel(t, 'capability', mode) })} disabled={draft.histogram.mode !== mode}
            value={draft.histogram.mode === mode ? draft.histogram.value : ''}
            onChange={event => setDraft(current => ({ ...current,
              histogram: { ...current.histogram, mode, value: event.target.value } }))} />}
        </label>)}
      </fieldset>}
      {draft.type === 'histogram' && <fieldset className="chart-settings-general"><legend>{t("chartSettings.normalCurve")}</legend>
        <label><input type="checkbox" checked={draft.histogram.showNormalCurve} onChange={event =>
          setDraft(current => ({ ...current, histogram: { ...current.histogram, showNormalCurve: event.target.checked } }))} />{t("chartSettings.showNormalCurve")}</label>
        {([['mean', t("chartSettings.mean")], ['stdDev', t("chartSettings.stdDev")]] as const).map(([key, label]) =>
          <label className="chart-settings-field" key={key}>{label}
            <input type="text" inputMode="decimal" placeholder={t("chartSettings.auto")} value={draft.histogram[key]}
              onChange={event => { setDraft(current => ({ ...current,
                histogram: { ...current.histogram, [key]: event.target.value } })); setError(null) }} />
          </label>)}
      </fieldset>}
      {draft.type === 'boxplot' && <fieldset className="chart-settings-general"><legend>{t("chartSettings.boxAmpWhisker")}</legend>
        <label><input type="checkbox" checked={draft.boxPlot.showOutliers}
          onChange={event => setDraft(current => ({ ...current,
            boxPlot: { showOutliers: event.target.checked } }))} />{t("chartSettings.showOutliers")}</label>
      </fieldset>}
      {draft.type !== 'histogram' && draft.type !== 'boxplot' && <p>{t("chartSettings.noAnalysisOptionsForThisChartType")}</p>}
      </div>
      <div role="tabpanel" id="chart-settings-panel-Export" aria-labelledby="chart-settings-tab-Export" hidden={tab !== 'Export'}>
      <fieldset className="chart-settings-general">
        <legend>{t("chartSettings.exportPNG")}</legend>
        <label className="chart-settings-field">{t("chartSettings.background")}<select value={draft.imageBackground} onChange={event => setDraft(current => ({
            ...current, imageBackground: event.target.value as ChartPanel['imageBackground'],
          }))}>
            <option value="light">{t("chartSettings.light")}</option>
            <option value="dark">{t("chartSettings.dark")}</option>
          </select>
        </label>
      </fieldset>
      <p>{t("chartSettings.pNGIncludesTheChartTitleLegendAxesPlotAnd")}</p>
      </div>
      {error && <p className="chart-settings-error" role="alert">{error}</p>}
      <div className="chart-settings-actions">
        <button className="action-button" type="button" onClick={onClose}>{t("chartSettings.cancel")}</button>
        <button className="action-button action-button-primary" type="button" onClick={apply}>{t("chartSettings.apply")}</button>
      </div>
    </div>
  </dialog>
}
