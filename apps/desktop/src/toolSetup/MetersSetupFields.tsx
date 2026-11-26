import { useI18n } from '../i18n/I18nProvider'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ExecutionMode } from '../executionMode'
import type { BackgroundConfig } from '../workflow'
import type { MetersSetup } from './types'

const METERS_NPLC_OPTIONS = [0.02, 0.2, 1, 10, 100] as const

type MetersCapabilities = {
  model: string
  model_id: string
  reading_memory_limit: number
  trigger_modes: string[]
  limits: {
    buffer_drain_size: { min: number; max: number }
    sample_count: { min: number; max: number }
    trigger_count: { min: number; max: number }
  }
  measurements: { measurement_name: string; range_values: number[]; nplc_values: number[] }[]
}

function isCustomTriggerMode(mode: NonNullable<MetersSetup['trigger_mode']>): boolean {
  return mode.endsWith('-custom')
}

function formatInteger(value: bigint | number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatRange(value: number, unit: string): string {
  const magnitude = Math.abs(value)
  const exponent = magnitude === 0 ? 0 : Math.max(-12, Math.min(12, Math.floor(Math.log10(magnitude) / 3) * 3))
  const prefix: Record<number, string> = { '-12': 'p', '-9': 'n', '-6': '\u00b5', '-3': 'm', 0: '', 3: 'k', 6: 'M', 9: 'G', 12: 'T' }
  return `${Number((value / 10 ** exponent).toPrecision(12))} ${prefix[exponent]}${unit}`
}

export default function MetersSetupFields({ value, onChange, model, executionMode, metersExecutableKey, background }: {
  value: { meters: MetersSetup }
  onChange: (value: { meters: MetersSetup }) => void
  model?: string | null
  executionMode: ExecutionMode
  metersExecutableKey: string
  background?: BackgroundConfig
}) {
  const { t } = useI18n()
  const [capabilities, setCapabilities] = useState<{
    requestedModel: string | null | undefined
    metersExecutableKey: string
    value: MetersCapabilities | null
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    setCapabilities(null)
    invoke<MetersCapabilities>(
      'get_meters_capabilities',
      { ...(model == null ? {} : { model }), executionMode },
    ).then(
      value => { if (!cancelled) setCapabilities({ requestedModel: model, metersExecutableKey, value }) },
      () => { if (!cancelled) setCapabilities({ requestedModel: model, metersExecutableKey, value: null }) },
    )
    return () => { cancelled = true }
  }, [model, executionMode, metersExecutableKey])

  const meters = value.meters
  const [expanded, setExpanded] = useState(true)
  const triggerMode = meters.trigger_mode ?? 'software'
  const customMode = isCustomTriggerMode(triggerMode)
  const currentCapabilities = capabilities?.requestedModel === model
    && capabilities?.metersExecutableKey === metersExecutableKey ? capabilities : null
  const meterCapabilities = currentCapabilities?.value ?? null
  const measurementCapabilities = meterCapabilities?.measurements
    .find(option => option.measurement_name === meters.measurement)
  const ranges = measurementCapabilities?.range_values

  const unit = meters.measurement === 'voltage-dc' ? 'V' : 'A'
  const hasStandardNplc = METERS_NPLC_OPTIONS.some((option) => option === meters.nplc)
  const sampleCountMax = meterCapabilities?.limits.sample_count.max ?? 1000000
  const bufferDrainMax = meterCapabilities?.limits.buffer_drain_size.max ?? 10000
  const sampleCount = meters.sample_count ?? 1
  const plannedTriggerCount = background?.limit_count != null && Number.isSafeInteger(background.limit_count)
    ? BigInt(background.limit_count) : null
  const externalMode = triggerMode === 'external' || triggerMode === 'external-custom'
  const expectedReadings = plannedTriggerCount !== null
    && Number.isInteger(sampleCount) && sampleCount >= 0
    ? plannedTriggerCount * BigInt(sampleCount)
    : null
  const memoryOverflow = meterCapabilities !== null && expectedReadings !== null
    && expectedReadings > BigInt(meterCapabilities.reading_memory_limit)
  const triggerCountOverflow = meterCapabilities !== null && plannedTriggerCount !== null
    && plannedTriggerCount > BigInt(meterCapabilities.limits.trigger_count.max)
  const selectedModeSupported = meterCapabilities === null
    || meterCapabilities.trigger_modes.includes(triggerMode)

  const triggerOptions: { value: NonNullable<MetersSetup['trigger_mode']>; label: string }[] = [
    { value: 'software', label: background ? t("toolSetupEditor.software") : t("toolSetupEditor.single") },
    { value: 'immediate', label: t("toolSetupEditor.immediate") },
    { value: 'external', label: t("toolSetupEditor.external") },
    { value: 'software-custom', label: t("toolSetupEditor.softwareCustom") },
    { value: 'immediate-custom', label: t("toolSetupEditor.immediateCustom") },
    { value: 'external-custom', label: t("toolSetupEditor.externalCustom") },
  ]

  return (
    <>
      <h4 className="powers-section-heading">
        <button type="button" className="action-button tool-setup-toggle" aria-expanded={expanded}
          aria-label={t("toolSetupEditor.measurementSetup", { value1: expanded ? t("toolSetupEditor.collapse") : t("toolSetupEditor.expand") })} onClick={() => setExpanded(!expanded)}>
          {expanded ? '−' : '+'}
        </button>{t("toolSetupEditor.measurementSetup2")}</h4>
      <div hidden={!expanded}>
      <p className="tool-setup-hint">{t("toolSetupEditor.appliedBeforeTheRunStarts")}</p>
      <div className="meters-setup-fields">
        <label className="step-property-field meters-setup-trigger-mode">
          <span className="step-property-label">{t("toolSetupEditor.triggerMode")}</span>
          <select aria-label={t("toolSetupEditor.triggerMode")} value={triggerMode} onChange={(event) => {
            const trigger_mode = event.target.value as NonNullable<MetersSetup['trigger_mode']>
            onChange({
              ...value,
              meters: { ...meters, trigger_mode },
            })
          }}>
            {triggerOptions.filter(option => background || option.value === 'software').map(option => {
              const supported = meterCapabilities === null || meterCapabilities.trigger_modes.includes(option.value)
              return <option key={option.value} value={option.value} disabled={!supported}>
                {option.label}{supported ? '' : t("toolSetupEditor.unsupportedBy", { value1: meterCapabilities?.model })}
              </option>
            })}
            {!background && triggerMode !== 'software' && <option value={triggerMode} disabled>{triggerOptions.find(option => option.value === triggerMode)?.label ?? triggerMode.replace(/^[a-z]/, letter => letter.toUpperCase())} {t("toolSetupEditor.requiresBackground")}</option>}
          </select>
          {!background && triggerMode !== 'software' && <>
            <span role="alert">{t("toolSetupEditor.foregroundMetersRequiresSingleSelectSingleOrEnableBackground")}</span>
          </>}
          {!selectedModeSupported && (
            <span className="tool-setup-hint">{t("toolSetupEditor.theSelectedModelDoesNotSupportThisTriggerMode")}</span>
          )}
        </label>

        {externalMode && background && <>
          <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.hardwareTriggerSlope")}</span>
            <select value={meters.hw_trigger_slope ?? ''} onChange={event => onChange({ ...value, meters: {
              ...meters, hw_trigger_slope: event.target.value === '' ? null : event.target.value as 'pos' | 'neg',
            } })}><option value="">{t("toolSetupEditor.toolDefault")}</option><option value="pos">{t("toolSetupEditor.positive")}</option><option value="neg">{t("toolSetupEditor.negative")}</option></select>
          </label>
          <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.hardwareTriggerDelayS")}</span>
            <input type="number" min={0} step="any" value={meters.hw_trigger_delay_s ?? ''} onChange={event => onChange({ ...value, meters: {
              ...meters, hw_trigger_delay_s: event.target.value === '' ? null : Number(event.target.value),
            } })} />
          </label>
        </>}
        {background && customMode && <><label className="step-property-field">
          <span className="step-property-label">{t("toolSetupEditor.sampleCount")}</span>
          <input type="number" required min={1} max={sampleCountMax} step={1} value={sampleCount}
            onChange={event => onChange({ ...value, meters: { ...meters, sample_count: Number(event.target.value) } })} />
        </label>
        <label className="step-property-field">
          <span className="step-property-label">{t("toolSetupEditor.bufferDrainSizeOptional")}</span>
          <input type="number" min={1} max={bufferDrainMax} step={1} value={meters.buffer_drain_size ?? ''}
            onChange={event => onChange({ ...value, meters: {
              ...meters, buffer_drain_size: event.target.value === '' ? null : Number(event.target.value),
            } })} />
        </label>
        <label className="step-property-field step-property-checkbox meters-setup-overflow-risk">
          <input type="checkbox" checked={meters.allow_buffer_overflow_risk ?? false}
            onChange={event => onChange({ ...value, meters: { ...meters, allow_buffer_overflow_risk: event.target.checked } })} />
          <span>{t("toolSetupEditor.allowBufferOverflowRisk")}</span>
        </label></>}

        {background && customMode && <>
          {meterCapabilities && (
            <p className="meters-setup-summary">
              {meterCapabilities.model} {t("toolSetupEditor.memory")}{formatInteger(meterCapabilities.reading_memory_limit)} {t("toolSetupEditor.plannedTriggers")}{plannedTriggerCount === null
                ? t("toolSetupEditor.unboundedTriggerCount")
                : formatInteger(plannedTriggerCount)}
              {plannedTriggerCount === null && t("toolSetupEditor.infiniteAcquisitionRequiresAllowBufferOverflowRisk")}
            </p>
          )}
          {triggerCountOverflow && meterCapabilities && plannedTriggerCount !== null && (
            <div className="meters-setup-feedback meters-setup-feedback-blocking" role="alert">
              <strong>{t("toolSetupEditor.triggerCountExceedsLimit")}</strong>
              <span>{formatInteger(plannedTriggerCount)} {t("toolSetupEditor.planned")}{formatInteger(meterCapabilities.limits.trigger_count.max)} {t("toolSetupEditor.maximum")}</span>
            </div>
          )}
          {meters.allow_buffer_overflow_risk
              ? <div className="meters-setup-feedback meters-setup-feedback-warning" role="status">
                  <strong>{t("toolSetupEditor.highBufferOverflowRiskAccepted")}</strong>
                  {memoryOverflow && meterCapabilities && expectedReadings !== null && (
                    <span>{formatInteger(expectedReadings)} {t("toolSetupEditor.planned")}{formatInteger(meterCapabilities.reading_memory_limit)} {t("toolSetupEditor.capacityTimelyDrainingMayStillPreserveAllReadings")}</span>
                  )}
                  <span>{t("toolSetupEditor.youAcceptPossibleUnrecoverableDataLossIfAcquisitionOutpaces")}</span>
                  <span>{t("toolSetupEditor.ifSamplesAreLostAFiniteCustomAcquisitionMay")}</span>
                  <span>{t("toolSetupEditor.aSuccessfulFinishDoesNotGuaranteeCompleteDataCheck")}</span>
                  <span>{t("toolSetupEditor.allowRiskDoesNotEnsureOverflowMonitoringIsActive")}</span>
                </div>
              : memoryOverflow && meterCapabilities && expectedReadings !== null && <div className="meters-setup-feedback meters-setup-feedback-blocking" role="alert">
                  <strong>{t("toolSetupEditor.readingMemoryExceeded")}</strong>
                  <span>{formatInteger(expectedReadings)} {t("toolSetupEditor.planned")}{formatInteger(meterCapabilities.reading_memory_limit)} {t("toolSetupEditor.capacity")}</span>
                  <span>{t("toolSetupEditor.enableAllowBufferOverflowRiskToProceed")}</span>
                </div>
          }
        </>}

        <label className="step-property-field">
          <span className="step-property-label">{t("toolSetupEditor.measurement")}</span>
          <select value={meters.measurement} onChange={(event) => {
            const measurement = event.target.value as MetersSetup['measurement']
            onChange({ ...value, meters: {
              ...meters,
              measurement,
              manual_range: null,
              dcv_input_impedance: measurement === 'voltage-dc' ? meters.dcv_input_impedance : null,
              current_terminal: measurement === 'current-dc' ? meters.current_terminal : null,
            } })
          }}>
            <option value="voltage-dc">{t("toolSetupEditor.dCVoltage")}</option>
            <option value="current-dc">{t("toolSetupEditor.dCCurrent")}</option>
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">{t("toolSetupEditor.rangeMode")}</span>
          <select value={meters.range_mode} onChange={(event) => onChange({
            ...value, meters: { ...meters, range_mode: event.target.value as MetersSetup['range_mode'] },
          })}>
            <option value="auto">{t("toolSetupEditor.auto")}</option>
            <option value="manual">{t("toolSetupEditor.manual")}</option>
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">{t("toolSetupEditor.manualRange")}{meters.measurement === 'voltage-dc' ? 'V' : 'A'})</span>
          {ranges !== undefined ? (
            <select required disabled={meters.range_mode !== 'manual'} value={meters.manual_range ?? ''}
              onChange={event => onChange({ ...value, meters: { ...meters, manual_range: Number(event.target.value) } })}>
              {meters.manual_range === null && <option value="" disabled>{t("toolSetupEditor.selectARange")}</option>}
              {meters.manual_range !== null && !ranges.includes(meters.manual_range) && (
                <option value={meters.manual_range} disabled>{formatRange(meters.manual_range, unit)} {t("toolSetupEditor.unsupportedPreserved")}</option>
              )}
              {ranges.map(range => <option key={range} value={range}>{formatRange(range, unit)}</option>)}
            </select>
          ) : (
            <select disabled value="">
              <option value="">{currentCapabilities ? t("toolSetupEditor.rangeOptionsUnavailable") : t("toolSetupEditor.loadingRangeOptions")}</option>
            </select>
          )}
          {currentCapabilities && ranges === undefined && (
            <span className="tool-setup-hint">{t("toolSetupEditor.supportedRangeOptionsCouldNotBeLoaded")}</span>
          )}
        </label>
        <label className="step-property-field">
          <span className="step-property-label">{t("toolSetupEditor.nPLC")}</span>
          <select required value={meters.nplc} onChange={(event) => onChange({
            ...value, meters: { ...meters, nplc: Number(event.target.value) },
          })}>
            {!hasStandardNplc && <option value={meters.nplc}>{meters.nplc} {t("toolSetupEditor.current")}</option>}
            {METERS_NPLC_OPTIONS.map((nplc) => <option key={nplc} value={nplc}>{nplc}</option>)}
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">{t("toolSetupEditor.autoZero")}</span>
          <select value={meters.auto_zero} onChange={(event) => onChange({
            ...value, meters: { ...meters, auto_zero: event.target.value as MetersSetup['auto_zero'] },
          })}>
            <option value="on">{t("toolSetupEditor.on")}</option>
            <option value="off">{t("toolSetupEditor.off")}</option>
            <option value="once">{t("toolSetupEditor.once")}</option>
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">{t("toolSetupEditor.inputImpedance")}</span>
          <select disabled={meters.measurement !== 'voltage-dc'} value={meters.dcv_input_impedance ?? ''} onChange={(event) => onChange({
            ...value, meters: { ...meters, dcv_input_impedance: (event.target.value || null) as MetersSetup['dcv_input_impedance'] },
          })}>
            <option value="">{t("toolSetupEditor.notSpecified")}</option>
            <option value="default">{t("toolSetupEditor.default")}</option>
            <option value="ten-megohm">{t("toolSetupEditor.10M")}</option>
            <option value="auto">{t("toolSetupEditor.auto")}</option>
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">{t("toolSetupEditor.currentTerminalOptional")}</span>
          <select disabled={meters.measurement !== 'current-dc'} value={meters.current_terminal ?? ''} onChange={(event) => onChange({
            ...value, meters: { ...meters, current_terminal: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) },
          })}>
            <option value="">{t("toolSetupEditor.notSpecified")}</option>
            <option value="3">{t("toolSetupEditor.3ATerminal")}</option>
            <option value="10">{t("toolSetupEditor.10ATerminal")}</option>
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">{t("toolSetupEditor.vMCompSlope")}</span>
          <select value={meters.vm_comp_slope ?? ''} onChange={(event) => onChange({
            ...value, meters: { ...meters, vm_comp_slope: (event.target.value || null) as MetersSetup['vm_comp_slope'] },
          })}>
            <option value="">{t("toolSetupEditor.notSpecified")}</option>
            <option value="pos">{t("toolSetupEditor.positive")}</option>
            <option value="neg">{t("toolSetupEditor.negative")}</option>
          </select>
        </label>
      </div>
      </div>
    </>
  )
}

