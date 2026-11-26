import { optionLabel } from '../i18n/presentation'
import { useI18n } from '../i18n/I18nProvider'
import { scopesChannelNumbers, updateScopesAcquisition, updateScopesChannel } from '../scopesSetup'
import type { ScopesCapabilities, ScopesSetup, ScopesChannel } from '../scopesSetup'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { executionModeLabel, type ExecutionMode } from '../executionMode'

export default function ScopesSetupFields({ value, onChange, modelId, executionMode, scopesExecutableKey }: {
  value: ScopesSetup; onChange: (value: ScopesSetup) => void
  modelId: string | null | undefined; executionMode: ExecutionMode; scopesExecutableKey: string
}) {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState<{ key: string; value: ScopesCapabilities | null; error?: string } | null>(null)
  const key = JSON.stringify([executionMode, modelId, scopesExecutableKey])
  useEffect(() => {
    if (executionMode === 'live' && !modelId) return
    let cancelled = false
    invoke<ScopesCapabilities>('get_scopes_capabilities', { modelId, executionMode }).then(
      value => { if (!cancelled) setLoaded({ key, value }) },
      error => { if (!cancelled) setLoaded({ key, value: null, error: String(error) }) },
    )
    return () => { cancelled = true }
  }, [executionMode, modelId, scopesExecutableKey, key])
  const caps = loaded?.key === key ? loaded.value : null
  const acquisition = value.acquisition ?? {}
  const modes = caps?.acquisition_modes ?? []
  const counts = caps?.average_counts ?? []
  const [countDraft, setCountDraft] = useState<string | null>(null)
  useEffect(() => { setCountDraft(null) }, [value.acquisition?.average_count])
  const unsupportedMode = acquisition.acquisition_type !== undefined && !modes.includes(acquisition.acquisition_type)
  const unsupportedCount = acquisition.average_count !== undefined && !counts.includes(acquisition.average_count)
  const [acquisitionExpanded, setAcquisitionExpanded] = useState(false)
  const [channelsExpanded, setChannelsExpanded] = useState(false)
  return <div className="powers-protection-fields">
    <h4 className="powers-section-heading">
      <button type="button" className="action-button tool-setup-toggle" aria-expanded={acquisitionExpanded}
        data-scopes-count-disclosure
        aria-label={t("toolSetupEditor.acquisitionSetup", { value1: acquisitionExpanded ? t("toolSetupEditor.collapse") : t("toolSetupEditor.expand") })} onClick={() => setAcquisitionExpanded(!acquisitionExpanded)}>
        {acquisitionExpanded ? '−' : '+'}
      </button>{t("toolSetupEditor.acquisitionSetup2")}</h4>
    <div hidden={!acquisitionExpanded}>
    <p className="tool-setup-hint">{t("toolSetupEditor.onlyChangedValuesAreStoredUnchangedLeavesTheInstrument")}</p>
    {executionMode === 'live' && !modelId && <p className="tool-setup-hint">{t("toolSetupEditor.capabilityUnavailableSelectOrRefreshASupportedLiveResource")}</p>}
    {(executionMode === 'simulate' || modelId) && loaded?.key !== key && <p className="tool-setup-hint">{t("toolSetupEditor.loadingOfflineScopesCapabilities")}</p>}
    {(executionMode === 'simulate' || modelId) && loaded?.key === key && !caps && <p className="tool-setup-hint">{t("toolSetupEditor.capabilityUnavailable")}{loaded.error}</p>}
    <div className="scopes-acquisition-fields">
      <div>
        <label>{t("toolSetupEditor.acquisitionType")}<select aria-label={t("toolSetupEditor.acquisitionType")} value={acquisition.acquisition_type ?? ''}
          disabled={modes.length === 0} onChange={event => {
            const acquisition_type = (event.target.value || undefined) as typeof acquisition.acquisition_type
            onChange(updateScopesAcquisition(value, { acquisition_type,
              average_count: acquisition_type === 'average' ? acquisition.average_count : undefined }))
          }}>
          <option value="">{t("toolSetupEditor.unchanged")}</option>
          {(['normal', 'average', 'high_resolution', 'peak'] as const).map(mode =>
            <option key={mode} value={mode} disabled={!modes.includes(mode)}>{optionLabel(t, 'capability', mode)}</option>)}
        </select></label>
        {unsupportedMode && <p className="tool-setup-hint">{t("toolSetupEditor.unsupportedByTheCurrentModelExistingAcquisitionTypePreserved")}</p>}
        {caps && caps.acquisition_modes === null && <p className="tool-setup-hint">{t("toolSetupEditor.acquisitionCapabilityInformationIsUnavailable")}</p>}
      </div>
      <div>
        <label>{t("toolSetupEditor.averageCount")}<input aria-label={t("toolSetupEditor.averageCount")} type="number" step={1} min={counts[0]} max={counts.at(-1)} placeholder={t("toolSetupEditor.unchanged")}
          value={countDraft ?? acquisition.average_count ?? ''} disabled={acquisition.acquisition_type !== 'average' || !modes.includes('average') || counts.length === 0}
          onChange={event => {
            setCountDraft(event.target.value)
            const average_count = event.target.value === '' ? undefined : Number(event.target.value)
            if (average_count === undefined || counts.includes(average_count)) onChange(updateScopesAcquisition(value, { ...acquisition, average_count }))
          }} onBlur={event => {
            const next = event.relatedTarget
            // UI navigation and language changes do not abandon an incomplete count.
            if (next && next instanceof HTMLElement && (next.matches('[role="tab"], [data-locale-switch]')
              || (next.matches('[data-scopes-count-disclosure][aria-expanded="true"]')
                && event.currentTarget.closest('fieldset')?.contains(next)))) return
            setCountDraft(null)
          }} /></label>
        <p className="tool-setup-hint">{t("toolSetupEditor.requiresAcquisitionTypeAverage")}</p>
        {counts.length > 0 && <p className="tool-setup-hint">{t("toolSetupEditor.supportedCounts")}{counts.length <= 16 ? counts.join(', ') : t("toolSetupEditor.supportedIntegers", { value1: counts[0], value2: counts.at(-1) ?? 0, value3: counts.length })}.</p>}
        {unsupportedCount && <p className="tool-setup-hint">{t("toolSetupEditor.unsupportedByTheCurrentModelExistingAverageCountPreserved")}</p>}
      </div>
    </div>
    </div>
    <h4 className="powers-section-heading">
      <button type="button" className="action-button tool-setup-toggle" aria-expanded={channelsExpanded}
        aria-label={t("toolSetupEditor.channelConfiguration", { value1: channelsExpanded ? t("toolSetupEditor.collapse") : t("toolSetupEditor.expand") })} onClick={() => setChannelsExpanded(!channelsExpanded)}>
        {channelsExpanded ? '−' : '+'}
      </button>{t("toolSetupEditor.channelConfiguration2")}</h4>
    <div hidden={!channelsExpanded}>
    <div className="powers-table-scroll"><table className="powers-protection-table">
      <thead><tr><th>{t("toolSetupEditor.channel")}</th><th>{t("toolSetupEditor.inputCoupling")}</th><th>{t("toolSetupEditor.probeRatio")}</th><th>{t("toolSetupEditor.bandwidthLimit")}</th><th>{t("toolSetupEditor.waveformInvert")}</th><th>{t("toolSetupEditor.channelUnits")}</th></tr></thead>
      <tbody>{scopesChannelNumbers(caps, value).map(channel => {
        const record = value.channels?.find(item => item.channel === channel) ?? { channel }
        const supported = caps !== null && channel <= caps.analog_channels
        const select = (field: 'coupling' | 'bandwidth_limit' | 'invert' | 'units', label: string, options: [string, string][]) => <>
          <select aria-label={t("toolSetupEditor.channel2", { value1: channel, value2: label })} disabled={!supported}
            value={record[field] === undefined ? '' : String(record[field])} onChange={event => {
              const setting = event.target.value === '' ? undefined : ['bandwidth_limit', 'invert'].includes(field)
                ? event.target.value === 'true' : event.target.value
              onChange(updateScopesChannel(value, channel, field, setting as ScopesChannel[typeof field]))
            }}><option value="">{t("toolSetupEditor.unchanged")}</option>{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          {!supported && record[field] !== undefined && <span className="tool-setup-hint">{t("toolSetupEditor.unavailableExistingValuePreserved")}</span>}
        </>
        return <tr key={channel}><th scope="row">{channel}{!supported && <span className="tool-setup-hint">{t("toolSetupEditor.unavailableExistingSettingsPreserved")}</span>}</th>
          <td>{select('coupling', t("toolSetupEditor.inputCoupling"), [['ac', 'AC'], ['dc', 'DC']])}</td>
          <td><input aria-label={t("toolSetupEditor.channelProbeRatio", { value1: channel })} type="number" min={0} step="any" placeholder={t("toolSetupEditor.unchanged")}
            value={record.probe_ratio ?? ''} disabled={!supported} onChange={event => {
              if (event.target.value === '' || Number.isFinite(Number(event.target.value)))
                onChange(updateScopesChannel(value, channel, 'probe_ratio', event.target.value === '' ? undefined : Number(event.target.value)))
            }} />{!supported && record.probe_ratio !== undefined && <span className="tool-setup-hint">{t("toolSetupEditor.unavailableExistingValuePreserved")}</span>}</td>
          <td>{select('bandwidth_limit', t("toolSetupEditor.bandwidthLimit"), [['true', t("toolSetupEditor.on")], ['false', t("toolSetupEditor.off")]])}</td>
          <td>{select('invert', t("toolSetupEditor.waveformInvert"), [['true', t("toolSetupEditor.on")], ['false', t("toolSetupEditor.off")]])}</td>
          <td>{select('units', t("toolSetupEditor.channelUnits"), [['volt', t("toolSetupEditor.volt")], ['amp', t("toolSetupEditor.amp")]])}</td>
        </tr>
      })}</tbody>
    </table></div>
    </div>
  </div>
}

