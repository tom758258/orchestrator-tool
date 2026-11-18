import { optionLabel } from './i18n/presentation'
import { useI18n } from './i18n/I18nProvider'
import InputValueEditor from './InputValueEditor'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ExecutionMode } from './executionMode'
import type { ScopesCapabilities } from './scopesSetup'
import type { InputValueWire } from './inputValue'
import type { ToolInstance } from './ToolSetupEditor'
import type { BackgroundConfig, ToolActionStep, WorkflowStep } from './workflow'

export default function ScopesActionEditor({ step, instances, backgrounds, earlierSteps, earlierVariables, disabled, onChange, stepLabel,
  executionMode, modelId, scopesExecutableKey }: {
  step: ToolActionStep; instances: ToolInstance[]; backgrounds?: readonly BackgroundConfig[]; earlierSteps: WorkflowStep[]; earlierVariables: string[]
  disabled: boolean; onChange: (step: ToolActionStep) => void; stepLabel: (step: WorkflowStep) => string
  executionMode: ExecutionMode; modelId: string | null | undefined; scopesExecutableKey: string
}) {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState<{ key: string; value: ScopesCapabilities | null; error?: string } | null>(null)
  const capabilityModelId = executionMode === 'live' ? modelId : undefined
  const key = JSON.stringify([executionMode, capabilityModelId, scopesExecutableKey, step.target])
  const channelAction = ['channel-display', 'channel-scale', 'channel-offset', 'trigger-edge', 'measure', 'capture', 'autoscale'].includes(step.action)
  useEffect(() => {
    if ((!channelAction && step.action !== 'screenshot') || (executionMode === 'live' && !capabilityModelId)) return
    let cancelled = false
    invoke<ScopesCapabilities>('get_scopes_capabilities', { modelId: capabilityModelId, executionMode }).then(
      value => { if (!cancelled) setLoaded({ key, value }) },
      error => { if (!cancelled) setLoaded({ key, value: null, error: String(error) }) },
    )
    return () => { cancelled = true }
  }, [step.action, channelAction, executionMode, capabilityModelId, key])
  const caps = loaded?.key === key ? loaded.value : null
  const channels = Array.from({ length: caps?.analog_channels ?? 0 }, (_, i) => i + 1)
  const capabilityHint = executionMode === 'live' && !capabilityModelId
    ? t("scopesActionEditor.capabilityUnavailableSelectOrRefreshASupportedLiveResource")
    : loaded?.key !== key ? t("scopesActionEditor.loadingOfflineScopesCapabilities")
    : !caps ? t("scopesActionEditor.capabilityUnavailable", { value1: loaded.error ?? '' }) : null
  const formats = caps?.screenshot_formats ?? []
  const format = String(step.arguments.format ?? 'png')
  const change = (key: string, value: unknown) => onChange({ ...step, arguments: { ...step.arguments, [key]: value } })
  const changeFixed = (key: string, value: string | number | number[]) => {
    const bindings = { ...step.bindings }
    delete bindings[key]
    const next: ToolActionStep = { ...step, arguments: { ...step.arguments, [key]: value }, bindings }
    if (!Object.keys(bindings).length) delete next.bindings
    onChange(next)
  }
  const changeOptional = (key: string, value: unknown | undefined) => {
    const arguments_ = { ...step.arguments }
    if (value === undefined) delete arguments_[key]
    else arguments_[key] = value
    const bindings = { ...step.bindings }
    delete bindings[key]
    const next: ToolActionStep = { ...step, arguments: arguments_, bindings }
    if (!Object.keys(bindings).length) delete next.bindings
    onChange(next)
  }
  const channelSelector = (key: string, label: string) => {
    const saved = step.arguments[key]
    const bound = step.bindings?.[key] !== undefined
    const supported = typeof saved === 'number' && channels.includes(saved)
    return <>
      <label className="step-property-field"><span className="step-property-label">{label}</span>
        <select aria-label={label} value={bound || saved === undefined ? '' : String(saved)}
          disabled={disabled || channels.length === 0} onChange={event => {
            const value = Number(event.target.value)
            if (!disabled && channels.includes(value)) changeFixed(key, value)
          }}>
          <option value="" disabled>{bound ? t("scopesActionEditor.boundChannelPreserved") : t("scopesActionEditor.selectAChannel")}</option>
          {!bound && saved !== undefined && !supported && <option value={String(saved)} disabled>
            {t("scopesActionEditor.cH")}{String(saved)} ({caps ? t("scopesActionEditor.notSupported") : t("scopesActionEditor.unconfirmed")})
          </option>}
          {channels.map(channel => <option key={channel} value={channel}>{t("scopesActionEditor.cH")}{channel}</option>)}
        </select></label>
      {bound ? <p className="tool-setup-hint">{t("scopesActionEditor.channelBindingPreservedSelectAFixedChannelToReplace")}</p>
        : saved !== undefined && !supported && <p className="tool-setup-hint">
          {t("scopesActionEditor.savedChannel")}{String(saved)} {t("scopesActionEditor.preserved")}{caps ? t("scopesActionEditor.notSupportedByTheCurrentModel") : t("scopesActionEditor.supportCannotBeConfirmed")}
        </p>}
    </>
  }
  const capabilityChoice = (key: string, label: string, options: readonly (string | number)[]) => {
    const saved = step.arguments[key]
    const supported = options.some(option => option === saved)
    const valid = !step.bindings?.[key] && supported
    return <>
      <label className="step-property-field"><span className="step-property-label">{label}</span>
        <select aria-label={label} value={valid ? String(saved) : ''} disabled={disabled || options.length === 0}
          onChange={event => {
            const value = options.find(option => String(option) === event.target.value)
            if (!disabled && value !== undefined) changeFixed(key, value)
          }}>
          <option value="" disabled>{t("scopesActionEditor.select")}{label.toLowerCase()}...</option>
          {options.map(option => <option key={option} value={option}>
            {typeof option === 'string' ? optionLabel(t, 'capability', option) : option}
          </option>)}
        </select>
      </label>
      {options.length === 0 && <p className="tool-setup-hint">{label} {t("scopesActionEditor.optionsAreUnavailable")}</p>}
      {!valid && <p className="tool-setup-hint">{label} {t("scopesActionEditor.isInvalidOrUnconfirmedSelectASupportedFixedValue")}</p>}
    </>
  }
  const numeric = (key: string, label: string, fallback: number) => <InputValueEditor key={`${step.id}-${key}`}
    value={step.bindings?.[key] ?? { source: 'literal', value: step.arguments[key] as number ?? fallback }}
    numericSetpoint
    sourceLabel={t("inputValueEditor.namedSource", { label })} literalLabel={label} literalDefault={fallback}
    earlierSteps={earlierSteps} earlierVariables={earlierVariables} instances={instances} backgrounds={backgrounds} stepLabel={stepLabel} disabled={disabled}
    onChange={(value: InputValueWire) => {
      const bindings = { ...step.bindings }
      const arguments_ = { ...step.arguments }
      if (value.source === 'literal') { arguments_[key] = value.value; delete bindings[key] }
      else bindings[key] = value
      const next: ToolActionStep = { ...step, arguments: arguments_, bindings }
      if (!Object.keys(bindings).length) delete next.bindings
      onChange(next)
    }} />
  const singleWaitInteger = (key: string, label: string, fallback: number) => {
    const saved = step.arguments[key]
    return <label className="step-property-field">
      <span className="step-property-label">{label}</span>
      <input type="number" min={1} step={1} disabled={disabled}
        aria-label={label}
        value={saved === undefined ? fallback : typeof saved === 'number' || typeof saved === 'string' ? saved : ''}
        onChange={event => {
          const value = event.currentTarget.valueAsNumber
          if (Number.isSafeInteger(value) && value > 0) changeFixed(key, value)
        }} />
    </label>
  }
  const channel = step.action.startsWith('channel-') || step.action === 'measure'
  const autoScaleAvailable = caps?.autoscale_supported === true
  const savedAutoChannels = step.arguments.source_channel
  const autoChannelsValid = Array.isArray(savedAutoChannels) && savedAutoChannels.length > 0
    && savedAutoChannels.every(value => typeof value === 'number' && channels.includes(value))
    && new Set(savedAutoChannels).size === savedAutoChannels.length
  const selectedAutoChannels: number[] = autoChannelsValid ? [...savedAutoChannels] : []
  const savedChannels = step.arguments.channel
  const captureSupported = Array.isArray(savedChannels) && savedChannels.length > 0
    && savedChannels.every(value => typeof value === 'number' && channels.includes(value))
    && new Set(savedChannels).size === savedChannels.length
  const captureBound = step.bindings?.channel !== undefined
  const selectedChannels: number[] = captureSupported && !captureBound ? [...new Set(savedChannels)] : []
  return <>
    {channelAction && capabilityHint && <p className="tool-setup-hint">{capabilityHint}</p>}
    {channelAction && caps && channels.length === 0 && <p className="tool-setup-hint">{t("scopesActionEditor.noSupportedChannelsWereReturnedForTheCurrentModel")}</p>}
    {channel && channelSelector('channel', t("scopesActionEditor.channel"))}
    {step.action === 'channel-display' && <label className="step-property-field"><span className="step-property-label">{t("scopesActionEditor.display")}</span>
      <select value={step.arguments.off === true ? 'off' : 'on'} disabled={disabled} onChange={event => {
        const arguments_ = { ...step.arguments }; delete arguments_.on; delete arguments_.off; delete arguments_.query
        arguments_[event.target.value] = true
        onChange({ ...step, arguments: arguments_ })
      }}><option value="on">{t("scopesActionEditor.on")}</option><option value="off">{t("scopesActionEditor.off")}</option></select></label>}
    {step.action === 'channel-scale' && numeric('volts_per_division', t("scopesActionEditor.voltsPerDivision"), 1)}
    {step.action === 'channel-offset' && numeric('volts', t("scopesActionEditor.offsetV"), 0)}
    {step.action === 'timebase-scale' && numeric('seconds_per_division', t("scopesActionEditor.secondsPerDivision"), 0.001)}
    {step.action === 'timebase-position' && numeric('seconds', t("scopesActionEditor.positionS"), 0)}
    {step.action === 'trigger-edge' && <>
      {channelSelector('source_channel', t("scopesActionEditor.sourceChannel"))}{numeric('level', t("scopesActionEditor.levelV"), 0)}
      {capabilityChoice('slope', t("scopesActionEditor.slope"), caps?.trigger_edge_slopes ?? [])}
    </>}
    {step.action === 'single-wait' && <>
      {singleWaitInteger('trigger_timeout_ms', t("scopesActionEditor.triggerTimeoutMs"), 5000)}
      {singleWaitInteger('trigger_poll_interval_ms', t("scopesActionEditor.pollIntervalMs"), 100)}
      <p className="tool-setup-hint">{t("scopesActionEditor.singleWaitTimeoutHint")}</p>
    </>}
    {step.action === 'measure' && capabilityChoice('item', t("scopesActionEditor.measurementItem"), caps?.direct_measurement_items ?? [])}
    {step.action === 'autoscale' && <>
      <p className="tool-setup-hint">{t("scopesActionEditor.autoScaleIsAForegroundOnlyOperationForSupportedKeysight")}</p>
      {caps && !autoScaleAvailable && <p className="tool-setup-hint">{t("scopesActionEditor.autoScaleIsNotSupportedByThisModelChooseA")}</p>}
      <div className="step-property-field">
        <span className="step-property-label">{t("scopesActionEditor.sourceChannelsOptional")}</span>
        {channels.map(channel => <label key={channel} className="step-property-checkbox">
          <input type="checkbox" aria-label={t("scopesActionEditor.autoScaleCH", { value1: channel })} checked={selectedAutoChannels.includes(channel)}
            disabled={disabled || !autoScaleAvailable} onChange={event => {
              if (disabled || !autoScaleAvailable || !channels.includes(channel)) return
              const next = event.target.checked ? [...new Set([...selectedAutoChannels, channel])]
                : selectedAutoChannels.filter(value => value !== channel)
              changeOptional('source_channel', next.length ? next.sort((a, b) => a - b) : undefined)
            }} />{t("scopesActionEditor.cH")}{channel}
        </label>)}
      </div>
      {savedAutoChannels !== undefined && !autoChannelsValid && <p className="tool-setup-hint">
        {t("scopesActionEditor.savedAutoScaleChannels")}{JSON.stringify(savedAutoChannels)} {t("scopesActionEditor.areUnsupportedOrInvalidTheStoredValueIsPreserved")}</p>}
      <label className="step-property-field"><span className="step-property-label">{t("scopesActionEditor.acquireMode")}</span>
        <select aria-label={t("scopesActionEditor.autoScaleAcquireMode")}
          value={step.arguments.acquire_mode === 'normal' || step.arguments.acquire_mode === 'current'
            ? step.arguments.acquire_mode : ''}
          disabled={disabled || !autoScaleAvailable}
          onChange={event => changeOptional('acquire_mode', event.target.value || undefined)}>
          <option value="">{t("scopesActionEditor.notSpecified")}</option>
          <option value="normal">{t("scopesActionEditor.normal")}</option><option value="current">{t("scopesActionEditor.current")}</option>
        </select>
      </label>
      <label className="step-property-field"><span className="step-property-label">{t("scopesActionEditor.channelsMode")}</span>
        <select aria-label={t("scopesActionEditor.autoScaleChannelsMode")}
          value={step.arguments.channels === 'all' || step.arguments.channels === 'displayed'
            ? step.arguments.channels : ''}
          disabled={disabled || !autoScaleAvailable}
          onChange={event => changeOptional('channels', event.target.value || undefined)}>
          <option value="">{t("scopesActionEditor.notSpecified")}</option>
          <option value="all">{t("scopesActionEditor.all")}</option><option value="displayed">{t("scopesActionEditor.displayed")}</option>
        </select>
      </label>
      {((step.arguments.acquire_mode !== undefined && !['normal', 'current'].includes(String(step.arguments.acquire_mode)))
        || (step.arguments.channels !== undefined && !['all', 'displayed'].includes(String(step.arguments.channels)))) &&
        <p className="tool-setup-hint">{t("scopesActionEditor.unsupportedSavedAutoScaleOptionPreservedSelectAValidValue")}</p>}
    </>}
    {step.action === 'capture' && <>
      <div className="step-property-field"><span className="step-property-label">{t("scopesActionEditor.channels")}</span>
        {channels.map(channel => <label key={channel} className="step-property-checkbox">
          <input type="checkbox" aria-label={t("scopesActionEditor.captureCH", { value1: channel })} checked={selectedChannels.includes(channel)}
            disabled={disabled || (selectedChannels.length === 1 && selectedChannels.includes(channel))} onChange={event => {
              if (disabled || !channels.includes(channel)) return
              const next = event.target.checked ? [...new Set([...selectedChannels, channel])]
                : selectedChannels.filter(value => value !== channel)
              if (next.length) changeFixed('channel', next.sort((a, b) => a - b))
            }} />{t("scopesActionEditor.cH")}{channel}
        </label>)}
      </div>
      {captureBound ? <p className="tool-setup-hint">{t("scopesActionEditor.channelBindingPreservedSelectFixedChannelsToReplaceIt")}</p>
        : !captureSupported && <p className="tool-setup-hint">
          {t("scopesActionEditor.savedCaptureChannels")}{JSON.stringify(savedChannels) ?? t("scopesActionEditor.unset")} {t("scopesActionEditor.preserved")}{caps
            ? t("scopesActionEditor.invalidOrNotSupportedByTheCurrentModelSelect") : t("scopesActionEditor.supportCannotBeConfirmed")}
        </p>}
      {capabilityChoice('points', t("scopesActionEditor.points"), caps?.capture_point_options ?? [])}
      <p className="tool-setup-hint">{t("scopesActionEditor.cSVAndMetadataAreSavedInScopesFileOutput")}</p>
    </>}
    {step.action === 'screenshot' && <>
      <label className="step-property-field"><span className="step-property-label">{t("scopesActionEditor.imageFormat")}</span>
        <select aria-label={t("scopesActionEditor.imageFormat")} value={format} disabled={disabled || formats.length === 0} onChange={event => {
          if (!disabled && formats.includes(event.target.value)) change('format', event.target.value)
        }}>
          <option value="png" disabled={!formats.includes('png')}>{t("scopesActionEditor.pNG")}</option>
          <option value="bmp" disabled={!formats.includes('bmp')}>{t("scopesActionEditor.bMP")}</option>
          <option value="bmp8bit" disabled={!formats.includes('bmp8bit')}>{t("scopesActionEditor.bMP8Bit")}</option>
          {!['png', 'bmp', 'bmp8bit'].includes(format) && <option value={format} disabled>{format.replace(/[a-z]/i, letter => letter.toUpperCase())}</option>}
        </select></label>
      {capabilityHint && <p className="tool-setup-hint">{capabilityHint}</p>}
      {caps && formats.length === 0 && <p className="tool-setup-hint">{t("scopesActionEditor.screenshotFormatsAreUnavailableForTheCurrentModel")}</p>}
      {caps && !formats.includes(format) && <p className="tool-setup-hint">{t("scopesActionEditor.unsupportedByTheCurrentModelExistingImageFormatPreserved")}</p>}
      <p className="tool-setup-hint">{t("scopesActionEditor.theImageIsSavedInScopesFileOutputScopes")}</p>
    </>}
  </>
}
