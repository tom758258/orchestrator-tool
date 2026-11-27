import { useI18n } from '../i18n/I18nProvider'
import { useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ExecutionMode } from '../executionMode'
import { protectionChannelNumbers, updatePowersProtectionSetting } from '../powersProtectionSetup'
import type { PowersProtectionChannel, PowersSetup } from './types'

type PowersCapabilities = {
  model_id: string
  model_name: string
  channels: number[]
  protection_features: {
    ovp_voltage: boolean
    ocp: boolean
    ocp_delay: boolean
    ocp_delay_triggers: string[]
  }
}

export default function PowersSetupFields({ value, onChange, modelId, executionMode, powersExecutableKey, children }: {
  value: PowersSetup
  onChange: (value: PowersSetup) => void
  modelId: string | null | undefined
  executionMode: ExecutionMode
  powersExecutableKey: string
  children?: ReactNode
}) {
  const { t } = useI18n()
  const [enabledEmptySetup, setEnabledEmptySetup] = useState<PowersSetup | null>(null)
  const protectionEnabled = value.protection !== undefined || enabledEmptySetup === value
  const changeSetting = (setup: PowersSetup) => {
    setEnabledEmptySetup(null)
    onChange(setup)
  }
  const [loaded, setLoaded] = useState<{ key: string; value: PowersCapabilities | null } | null>(null)
  const key = JSON.stringify([executionMode, modelId, powersExecutableKey])
  useEffect(() => {
    if (executionMode === 'live' && !modelId) return
    let cancelled = false
    invoke<PowersCapabilities>('get_powers_capabilities', { modelId, executionMode }).then(
      value => { if (!cancelled) setLoaded({ key, value }) },
      () => { if (!cancelled) setLoaded({ key, value: null }) },
    )
    return () => { cancelled = true }
  }, [modelId, executionMode, powersExecutableKey, key])
  const capabilities = loaded?.key === key ? loaded.value : null
  const channels = value.protection?.channels ?? []
  const features = capabilities?.protection_features
  const hasConfigurableProtection = Boolean(features && (
    features.ovp_voltage || features.ocp || features.ocp_delay || features.ocp_delay_triggers.length > 0
  ))
  const displayChannels = protectionChannelNumbers(capabilities?.channels ?? [], channels)
  const [expanded, setExpanded] = useState(false)
  return <div className="powers-protection-fields">
    <h4 className="powers-section-heading">
      <button type="button" className="action-button tool-setup-toggle" aria-expanded={expanded}
        aria-label={t("toolSetupEditor.protectionSetup", { value1: expanded ? t("toolSetupEditor.collapse") : t("toolSetupEditor.expand") })} onClick={() => setExpanded(!expanded)}>
        {expanded ? '−' : '+'}
      </button>{t("toolSetupEditor.protectionSetup2")}</h4>
    <div hidden={!expanded}>
    <label className="powers-protection-toggle">
      <input type="checkbox" checked={protectionEnabled} onChange={event => {
        setEnabledEmptySetup(event.target.checked ? value : null)
        if (!event.target.checked) onChange({})
      }} />
      <span>{t("toolSetupEditor.useProtectionSetup")}</span>
    </label>
    <p className="tool-setup-hint">{t("toolSetupEditor.onlyChangedValuesAreStoredUnchangedLeavesTheInstrument")}</p>
    {executionMode === 'live' && !modelId && <p className="tool-setup-hint">{t("toolSetupEditor.capabilityUnavailableSelectOrRefreshASupportedLiveResource")}</p>}
    {(executionMode === 'simulate' || modelId) && loaded?.key !== key && <p className="tool-setup-hint">{t("toolSetupEditor.loadingOfflineProtectionCapabilities")}</p>}
    {(executionMode === 'simulate' || modelId) && loaded?.key === key && !capabilities && <p className="tool-setup-hint">{t("toolSetupEditor.capabilityUnavailableCheckTheConfiguredPowersTool")}</p>}
    {capabilities && !hasConfigurableProtection && <p className="tool-setup-hint">{t("toolSetupEditor.protectionConfigurationIsUnavailableForTheCurrentModel")}</p>}
    <div className="powers-table-scroll">
      <table className="powers-protection-table">
        <thead><tr>
          <th scope="col">{t("toolSetupEditor.channel")}</th><th scope="col">{t("toolSetupEditor.oVPVoltageV")}</th><th scope="col">{t("toolSetupEditor.oCP")}</th>
          <th scope="col">{t("toolSetupEditor.oCPDelayS")}</th><th scope="col">{t("toolSetupEditor.oCPDelayTrigger")}</th>
        </tr></thead>
        <tbody>{displayChannels.map(channel => {
          const record = channels.find(item => item.channel === channel) ?? { channel }
          const supported = (field: 'ovp_voltage' | 'ocp' | 'ocp_delay') =>
            capabilities?.channels.includes(channel) === true && features?.[field] === true
          const triggers = (['setting-change', 'cc-transition'] as const).filter(trigger =>
            capabilities?.channels.includes(channel) && features?.ocp_delay_triggers.includes(trigger))
          const unsupportedTrigger = record.ocp_delay_trigger !== undefined && !triggers.includes(record.ocp_delay_trigger)
          return <tr key={channel}>
            <th scope="row">{channel}
              {capabilities && !capabilities.channels.includes(channel) &&
                <span className="tool-setup-hint">{t("toolSetupEditor.unavailableExistingSettingsPreserved")}</span>}
            </th>
            <td>
              <input aria-label={t("toolSetupEditor.channelOVPVoltageV", { value1: channel })} type="number" min={0} step="any" placeholder={t("toolSetupEditor.unchanged")}
                value={record.ovp_voltage ?? ''} disabled={!protectionEnabled || !supported('ovp_voltage')} onChange={event => {
                  if (event.target.value === '' || Number.isFinite(Number(event.target.value))) {
                    changeSetting(updatePowersProtectionSetting(value, channel, 'ovp_voltage',
                      event.target.value === '' ? undefined : Number(event.target.value)))
                  }
                }} />
              {record.ovp_voltage !== undefined && !supported('ovp_voltage') &&
                <span className="tool-setup-hint">{t("toolSetupEditor.unsupportedByTheCurrentModelExistingValuePreserved")}</span>}
            </td>
            <td>
              <select aria-label={t("toolSetupEditor.channelOCP", { value1: channel })} value={record.ocp ?? ''} disabled={!protectionEnabled || !supported('ocp')}
                onChange={event => changeSetting(updatePowersProtectionSetting(value, channel, 'ocp',
                  (event.target.value || undefined) as PowersProtectionChannel['ocp']))}>
                <option value="">{t("toolSetupEditor.unchanged")}</option><option value="on">{t("toolSetupEditor.on")}</option><option value="off">{t("toolSetupEditor.off")}</option>
              </select>
              {record.ocp !== undefined && !supported('ocp') &&
                <span className="tool-setup-hint">{t("toolSetupEditor.unsupportedByTheCurrentModelExistingValuePreserved")}</span>}
            </td>
            <td>
              <input aria-label={t("toolSetupEditor.channelOCPDelayS", { value1: channel })} type="number" min={0} step="any" placeholder={t("toolSetupEditor.unchanged")}
                value={record.ocp_delay ?? ''} disabled={!protectionEnabled || !supported('ocp_delay')} onChange={event => {
                  if (event.target.value === '' || Number.isFinite(Number(event.target.value))) {
                    changeSetting(updatePowersProtectionSetting(value, channel, 'ocp_delay',
                      event.target.value === '' ? undefined : Number(event.target.value)))
                  }
                }} />
              {record.ocp_delay !== undefined && !supported('ocp_delay') &&
                <span className="tool-setup-hint">{t("toolSetupEditor.unsupportedByTheCurrentModelExistingValuePreserved")}</span>}
            </td>
            <td>
              <select aria-label={t("toolSetupEditor.channelOCPDelayTrigger", { value1: channel })} value={record.ocp_delay_trigger ?? ''}
                disabled={!protectionEnabled || triggers.length === 0 || unsupportedTrigger}
                onChange={event => changeSetting(updatePowersProtectionSetting(value, channel, 'ocp_delay_trigger',
                  (event.target.value || undefined) as PowersProtectionChannel['ocp_delay_trigger']))}>
                <option value="">{t("toolSetupEditor.unchanged")}</option>
                {(['setting-change', 'cc-transition'] as const).map(trigger =>
                  <option key={trigger} value={trigger} disabled={!triggers.includes(trigger)}>
                    {trigger === 'setting-change' ? t("toolSetupEditor.settingChange") : t("toolSetupEditor.cCTransition")}
                  </option>)}
              </select>
              {unsupportedTrigger &&
                <span className="tool-setup-hint">{t("toolSetupEditor.unsupportedByTheCurrentModelExistingValuePreserved")}</span>}
            </td>
          </tr>
        })}</tbody>
      </table>
    </div>
    {value.protection && <p className="tool-setup-hint">{t("toolSetupEditor.protectionSettingsAreConfiguredForThisPowerInstanceAdd")}</p>}
    {children}
    </div>
  </div>
}

