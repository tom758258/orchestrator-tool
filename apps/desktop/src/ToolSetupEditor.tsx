import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ReactNode } from 'react'
import type { WorkflowStep } from './App'

// Mirrors per-instance setup serialization in Template schema v1.
export type MetersSetup = {
  measurement: 'voltage-dc' | 'current-dc'
  range_mode: 'auto' | 'manual'
  manual_range: number | null
  nplc: number
  auto_zero: 'on' | 'off' | 'once'
  dcv_input_impedance: 'default' | 'ten-megohm' | 'auto' | null
  current_terminal: number | null
  vm_comp_slope?: 'pos' | 'neg' | null
  trigger_mode?: 'software' | 'software-custom' | 'immediate-custom' | 'external-custom'
  sample_count?: number
  buffer_drain_size?: number | null
  allow_buffer_overflow_risk?: boolean
}

export type ToolInstance =
  | { id: string; tool: 'meters'; setup: MetersSetup }
  | { id: string; tool: 'powers'; setup: PowersSetup }
  | { id: string; tool: 'scopes' | 'wavegen'; setup: Record<string, never> }

export type PowersProtectionChannel = {
  channel: number
  ovp_voltage?: number
  ocp?: 'on' | 'off'
  ocp_delay?: number
  ocp_delay_trigger?: 'setting-change' | 'cc-transition'
}
export type PowersSetup = { protection?: { channels: PowersProtectionChannel[] } }

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
  return mode !== 'software'
}

function parseDecimal(value: string): { coefficient: bigint; scale: number } | null {
  const match = value.trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/)
  if (!match) return null
  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? '0')
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 28) return null
  let coefficient = BigInt(`${match[2]}${fraction}`)
  if (match[1] === '-') coefficient = -coefficient
  let scale = fraction.length - exponent
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale)
    scale = 0
  }
  return { coefficient, scale }
}

function rangeIterationCount(range: { start: string; stop: string; step: string }): bigint | null {
  const start = parseDecimal(range.start)
  const stop = parseDecimal(range.stop)
  const step = parseDecimal(range.step)
  if (!start || !stop || !step) return null
  const scale = Math.max(start.scale, stop.scale, step.scale)
  const scaled = (value: { coefficient: bigint; scale: number }) =>
    value.coefficient * 10n ** BigInt(scale - value.scale)
  const a = scaled(start)
  const b = scaled(stop)
  const delta = scaled(step)
  if (delta === 0n) return null
  if ((b > a && delta < 0n) || (b < a && delta > 0n)) return null
  const span = b >= a ? b - a : a - b
  const magnitude = delta >= 0n ? delta : -delta
  return span / magnitude + 1n
}

function plannedMeterMeasureCount(steps: readonly WorkflowStep[], target: string): bigint | null {
  let total = 0n
  for (const step of steps) {
    if (step.type === 'tool-action' && step.target === target && step.action === 'measure') {
      total += 1n
    } else if (step.type === 'for') {
      const body = plannedMeterMeasureCount(step.steps, target)
      const iterations = rangeIterationCount(step.range)
      if (body === null || iterations === null) return null
      total += body * iterations
    } else if (step.type === 'while') {
      const body = plannedMeterMeasureCount(step.steps, target)
      if (body === null) return null
      if (body === 0n) continue
      if (step.max_iterations === null
        || !Number.isSafeInteger(step.max_iterations)
        || step.max_iterations < 0) return null
      total += body * BigInt(step.max_iterations)
    }
  }
  return total
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

function MetersSetupFields({ value, onChange, model, metersExecutableKey, plannedTriggerCount }: {
  value: { meters: MetersSetup }
  onChange: (value: { meters: MetersSetup }) => void
  model?: string | null
  metersExecutableKey: string
  plannedTriggerCount: bigint | null
}) {
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
      model == null ? {} : { model },
    ).then(
      value => { if (!cancelled) setCapabilities({ requestedModel: model, metersExecutableKey, value }) },
      () => { if (!cancelled) setCapabilities({ requestedModel: model, metersExecutableKey, value: null }) },
    )
    return () => { cancelled = true }
  }, [model, metersExecutableKey])

  const meters = value.meters
  const triggerMode = meters.trigger_mode ?? 'software'
  const customMode = isCustomTriggerMode(triggerMode)
  const currentCapabilities = capabilities?.requestedModel === model
    && capabilities?.metersExecutableKey === metersExecutableKey ? capabilities : null
  const meterCapabilities = currentCapabilities?.value ?? null
  const measurementCapabilities = meterCapabilities?.measurements
    .find(option => option.measurement_name === meters.measurement)
  const ranges = measurementCapabilities?.range_values

  useEffect(() => {
    if (ranges !== undefined && meters.manual_range !== null && !ranges.includes(meters.manual_range)) {
      onChange({ ...value, meters: { ...meters, manual_range: null } })
    }
  }, [ranges, meters.measurement, meters.manual_range])

  const unit = meters.measurement === 'voltage-dc' ? 'V' : 'A'
  const hasStandardNplc = METERS_NPLC_OPTIONS.some((option) => option === meters.nplc)
  const sampleCountMax = meterCapabilities?.limits.sample_count.max ?? 1000000
  const bufferDrainMax = meterCapabilities?.limits.buffer_drain_size.max ?? 10000
  const sampleCount = meters.sample_count ?? 1
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
    { value: 'software', label: 'Single' },
    { value: 'software-custom', label: 'Software Custom' },
    { value: 'immediate-custom', label: 'Immediate Custom' },
    { value: 'external-custom', label: 'External Custom' },
  ]

  return (
    <>
      <p className="tool-setup-hint">Applied before the run starts.</p>
      <div className="meters-setup-fields">
        <label className="step-property-field meters-setup-trigger-mode">
          <span className="step-property-label">Trigger Mode</span>
          <select value={triggerMode} onChange={(event) => {
            const trigger_mode = event.target.value as NonNullable<MetersSetup['trigger_mode']>
            onChange({
              ...value,
              meters: trigger_mode === 'software'
                ? {
                    ...meters,
                    trigger_mode,
                    sample_count: 1,
                    buffer_drain_size: null,
                    allow_buffer_overflow_risk: false,
                  }
                : { ...meters, trigger_mode },
            })
          }}>
            {triggerOptions.map(option => {
              const supported = meterCapabilities === null || meterCapabilities.trigger_modes.includes(option.value)
              return <option key={option.value} value={option.value} disabled={!supported}>
                {option.label}{supported ? '' : ` (unsupported by ${meterCapabilities?.model})`}
              </option>
            })}
          </select>
          {!selectedModeSupported && (
            <span className="tool-setup-hint">The selected model does not support this trigger mode.</span>
          )}
        </label>

        <label className="step-property-field">
          <span className="step-property-label">Sample Count</span>
          <input type="number" required disabled={!customMode} min={1} max={sampleCountMax} step={1} value={sampleCount}
            onChange={event => onChange({ ...value, meters: { ...meters, sample_count: Number(event.target.value) } })} />
        </label>
        <label className="step-property-field">
          <span className="step-property-label">Buffer Drain Size (optional)</span>
          <input type="number" disabled={!customMode} min={1} max={bufferDrainMax} step={1} value={meters.buffer_drain_size ?? ''}
            onChange={event => onChange({ ...value, meters: {
              ...meters, buffer_drain_size: event.target.value === '' ? null : Number(event.target.value),
            } })} />
        </label>
        <label className="step-property-field step-property-checkbox meters-setup-overflow-risk">
          <input type="checkbox" disabled={!customMode} checked={meters.allow_buffer_overflow_risk ?? false}
            onChange={event => onChange({ ...value, meters: { ...meters, allow_buffer_overflow_risk: event.target.checked } })} />
          <span>Allow Buffer Overflow Risk</span>
        </label>

        {customMode && <>
          {meterCapabilities && (
            <p className="meters-setup-summary">
              {meterCapabilities.model} · Memory {formatInteger(meterCapabilities.reading_memory_limit)} · Planned triggers {plannedTriggerCount === null
                ? 'unbounded'
                : formatInteger(plannedTriggerCount)}
              {plannedTriggerCount === null && '. Custom mode requires finite loop bounds.'}
            </p>
          )}
          {triggerCountOverflow && meterCapabilities && plannedTriggerCount !== null && (
            <div className="meters-setup-feedback meters-setup-feedback-blocking" role="alert">
              <strong>Trigger count exceeds limit</strong>
              <span>{formatInteger(plannedTriggerCount)} planned / {formatInteger(meterCapabilities.limits.trigger_count.max)} maximum.</span>
            </div>
          )}
          {memoryOverflow && meterCapabilities && expectedReadings !== null && (
            meters.allow_buffer_overflow_risk
              ? <div className="meters-setup-feedback meters-setup-feedback-warning" role="status">
                  <strong>Buffer overflow risk allowed</strong>
                  <span>{formatInteger(expectedReadings)} planned / {formatInteger(meterCapabilities.reading_memory_limit)} capacity.</span>
                  <span>Continuous draining must keep up; lower NPLC increases data-loss risk.</span>
                </div>
              : <div className="meters-setup-feedback meters-setup-feedback-blocking" role="alert">
                  <strong>Reading memory exceeded</strong>
                  <span>{formatInteger(expectedReadings)} planned / {formatInteger(meterCapabilities.reading_memory_limit)} capacity.</span>
                  <span>Enable “Allow Buffer Overflow Risk” to proceed.</span>
                </div>
          )}
        </>}

        <label className="step-property-field">
          <span className="step-property-label">Measurement</span>
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
            <option value="voltage-dc">DC Voltage</option>
            <option value="current-dc">DC Current</option>
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">Range Mode</span>
          <select value={meters.range_mode} onChange={(event) => onChange({
            ...value, meters: { ...meters, range_mode: event.target.value as MetersSetup['range_mode'] },
          })}>
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">Manual Range ({meters.measurement === 'voltage-dc' ? 'V' : 'A'})</span>
          {ranges !== undefined ? (
            <select required disabled={meters.range_mode !== 'manual'} value={meters.manual_range ?? ''}
              onChange={event => onChange({ ...value, meters: { ...meters, manual_range: Number(event.target.value) } })}>
              {meters.manual_range === null && <option value="" disabled>Select a range...</option>}
              {ranges.map(range => <option key={range} value={range}>{formatRange(range, unit)}</option>)}
            </select>
          ) : (
            <select disabled value="">
              <option value="">{currentCapabilities ? 'Range options unavailable' : 'Loading range options...'}</option>
            </select>
          )}
          {currentCapabilities && ranges === undefined && (
            <span className="tool-setup-hint">Supported range options could not be loaded.</span>
          )}
        </label>
        <label className="step-property-field">
          <span className="step-property-label">NPLC</span>
          <select required value={meters.nplc} onChange={(event) => onChange({
            ...value, meters: { ...meters, nplc: Number(event.target.value) },
          })}>
            {!hasStandardNplc && <option value={meters.nplc}>{meters.nplc} (current)</option>}
            {METERS_NPLC_OPTIONS.map((nplc) => <option key={nplc} value={nplc}>{nplc}</option>)}
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">Auto Zero</span>
          <select value={meters.auto_zero} onChange={(event) => onChange({
            ...value, meters: { ...meters, auto_zero: event.target.value as MetersSetup['auto_zero'] },
          })}>
            <option value="on">On</option>
            <option value="off">Off</option>
            <option value="once">Once</option>
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">Input Impedance</span>
          <select disabled={meters.measurement !== 'voltage-dc'} value={meters.dcv_input_impedance ?? ''} onChange={(event) => onChange({
            ...value, meters: { ...meters, dcv_input_impedance: (event.target.value || null) as MetersSetup['dcv_input_impedance'] },
          })}>
            <option value="">Not specified</option>
            <option value="default">Default</option>
            <option value="ten-megohm">10 MΩ</option>
            <option value="auto">Auto</option>
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">Current Terminal (optional)</span>
          <select disabled={meters.measurement !== 'current-dc'} value={meters.current_terminal ?? ''} onChange={(event) => onChange({
            ...value, meters: { ...meters, current_terminal: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) },
          })}>
            <option value="">Not specified</option>
            <option value="3">3 A terminal</option>
            <option value="10">10 A terminal</option>
          </select>
        </label>
        <label className="step-property-field">
          <span className="step-property-label">VM Comp Slope</span>
          <select value={meters.vm_comp_slope ?? ''} onChange={(event) => onChange({
            ...value, meters: { ...meters, vm_comp_slope: (event.target.value || null) as MetersSetup['vm_comp_slope'] },
          })}>
            <option value="">Not specified</option>
            <option value="pos">Positive</option>
            <option value="neg">Negative</option>
          </select>
        </label>
      </div>
    </>
  )
}

function PowersSetupFields({ value, onChange, modelId, powersExecutableKey }: {
  value: PowersSetup
  onChange: (value: PowersSetup) => void
  modelId: string | null | undefined
  powersExecutableKey: string
}) {
  const [loaded, setLoaded] = useState<{ key: string; value: PowersCapabilities | null } | null>(null)
  const [addChannel, setAddChannel] = useState('')
  const key = JSON.stringify([modelId, powersExecutableKey])
  useEffect(() => {
    if (!modelId) return
    let cancelled = false
    invoke<PowersCapabilities>('get_powers_capabilities', { modelId }).then(
      value => { if (!cancelled) setLoaded({ key, value }) },
      () => { if (!cancelled) setLoaded({ key, value: null }) },
    )
    return () => { cancelled = true }
  }, [modelId, powersExecutableKey, key])
  const capabilities = loaded?.key === key ? loaded.value : null
  const channels = value.protection?.channels ?? []
  const features = capabilities?.protection_features
  const available = capabilities?.channels.filter(channel => !channels.some(record => record.channel === channel)) ?? []
  const selected = available.some(channel => String(channel) === addChannel) ? addChannel : String(available[0] ?? '')
  const setChannels = (next: PowersProtectionChannel[]) => onChange(next.length ? { protection: { channels: next } } : {})
  const update = (channel: number, patch: Partial<PowersProtectionChannel>) => {
    setChannels(channels.map(record => record.channel === channel ? { ...record, ...patch } : record))
  }
  const omit = (channel: number, field: keyof Omit<PowersProtectionChannel, 'channel'>) => {
    const next = channels.map(record => {
      if (record.channel !== channel) return record
      const copy = { ...record }
      delete copy[field]
      return copy
    }).filter(record => record.channel !== channel || Object.keys(record).length > 1)
    setChannels(next)
  }
  return <div className="meters-setup-fields">
    <h4>Protection Setup</h4>
    {!modelId && <p className="tool-setup-hint">Capability unavailable. Select or refresh a supported Live Resource.</p>}
    {modelId && loaded?.key !== key && <p className="tool-setup-hint">Loading offline protection capabilities...</p>}
    {modelId && loaded?.key === key && !capabilities && <p className="tool-setup-hint">Capability unavailable. Check the configured powers-tool and refresh the Live Resource.</p>}
    {channels.length === 0 && <p>No protection settings configured.</p>}
    {channels.map(record => {
      const supported = (field: 'ovp_voltage' | 'ocp' | 'ocp_delay') =>
        capabilities?.channels.includes(record.channel) === true && features?.[field] === true
      const triggers = (['setting-change', 'cc-transition'] as const).filter(trigger =>
        capabilities?.channels.includes(record.channel) && features?.ocp_delay_triggers.includes(trigger))
      return <div key={record.channel} className="meters-setup-fields">
        <strong>CH{record.channel}</strong>
        {capabilities && !capabilities.channels.includes(record.channel) &&
          <p className="tool-setup-hint">This channel is unavailable on the current model; existing settings are preserved.</p>}
        {(['ovp_voltage', 'ocp_delay'] as const).map(field => <label key={field} className="step-property-field">
          <span className="step-property-label">{field === 'ovp_voltage' ? 'OVP Voltage (V)' : 'OCP Delay (s)'}</span>
          <input type="number" min={0} step="any" placeholder="Unchanged" value={record[field] ?? ''}
            disabled={!supported(field)} onChange={event => {
              if (event.target.value === '') omit(record.channel, field)
              else if (Number.isFinite(Number(event.target.value))) update(record.channel, { [field]: Number(event.target.value) })
            }} />
          {record[field] !== undefined && <button type="button" className="action-button" onClick={() => omit(record.channel, field)}>Remove setting</button>}
          {record[field] !== undefined && !supported(field) && <span className="tool-setup-hint">Unsupported by the current model; existing value preserved.</span>}
        </label>)}
        <label className="step-property-field">
          <span className="step-property-label">OCP</span>
          <select value={record.ocp ?? ''} onChange={event => event.target.value === '' ? omit(record.channel, 'ocp')
            : update(record.channel, { ocp: event.target.value as 'on' | 'off' })}>
            <option value="">Unchanged</option>
            <option value="on" disabled={!supported('ocp')}>On</option>
            <option value="off" disabled={!supported('ocp')}>Off</option>
          </select>
          {record.ocp !== undefined && !supported('ocp') && <span className="tool-setup-hint">Unsupported by the current model; choose Unchanged to remove.</span>}
        </label>
        <label className="step-property-field">
          <span className="step-property-label">OCP Delay Trigger</span>
          <select value={record.ocp_delay_trigger ?? ''} onChange={event => event.target.value === '' ? omit(record.channel, 'ocp_delay_trigger')
            : update(record.channel, { ocp_delay_trigger: event.target.value as PowersProtectionChannel['ocp_delay_trigger'] })}>
            <option value="">Unchanged</option>
            {record.ocp_delay_trigger && !triggers.includes(record.ocp_delay_trigger) &&
              <option value={record.ocp_delay_trigger} disabled>{record.ocp_delay_trigger} (unsupported)</option>}
            {triggers.map(trigger => <option key={trigger} value={trigger}>{trigger === 'setting-change' ? 'Setting Change' : 'CC Transition'}</option>)}
          </select>
          {record.ocp_delay_trigger !== undefined && !triggers.includes(record.ocp_delay_trigger) &&
            <span className="tool-setup-hint">Unsupported by the current model; choose Unchanged to remove.</span>}
        </label>
        <button type="button" className="action-button action-button-danger" onClick={() => setChannels(channels.filter(item => item.channel !== record.channel))}>Remove Channel</button>
      </div>
    })}
    <label className="step-property-field">
      <span className="step-property-label">Add Protection Channel</span>
      <select value={selected} disabled={available.length === 0} onChange={event => setAddChannel(event.target.value)}>
        {available.length === 0 && <option value="">No available channels</option>}
        {available.map(channel => <option key={channel} value={channel}>CH{channel}</option>)}
      </select>
      <button type="button" className="action-button" disabled={!selected} onClick={() => {
        const channel = Number(selected)
        if (!channels.some(record => record.channel === channel)) setChannels([...channels, { channel }])
      }}>Add Protection Channel</button>
    </label>
  </div>
}

function setupSummary(instance: ToolInstance): string {
  const type = instance.tool[0].toUpperCase() + instance.tool.slice(1)
  if (instance.tool === 'powers') return `${type} · ${instance.setup.protection ? 'Protection Setup' : 'No protection settings configured'}`
  if (instance.tool !== 'meters') return `${type} · No additional setup`
  const meters = instance.setup
  const voltage = meters.measurement === 'voltage-dc'
  const range = meters.range_mode === 'auto' ? 'Auto Range'
    : meters.manual_range !== null && Number.isFinite(meters.manual_range)
      ? `Manual ${meters.manual_range} ${voltage ? 'V' : 'A'}` : 'Manual Range'
  const trigger = ({ software: 'Single', 'software-custom': 'Software Custom', 'immediate-custom': 'Immediate Custom', 'external-custom': 'External Custom' } as const)[meters.trigger_mode ?? 'software']
  return `${type} · ${trigger} · ${voltage ? 'DC Voltage' : 'DC Current'} · ${range} · NPLC ${meters.nplc}`
}

export default function ToolSetupEditor({ value, steps, onChange, disabled, renderResource, resourceIdentities, metersExecutableKey, powersExecutableKey }: {
  value: ToolInstance[]; steps: WorkflowStep[]; onChange: (value: ToolInstance[]) => void; disabled: boolean
  resourceIdentities: Record<string, { model: string | null; model_id?: string | null } | null>
  metersExecutableKey: string
  powersExecutableKey: string
  renderResource: (instance: ToolInstance) => ReactNode
}) {
  const [collapsedIds, setCollapsedIds] = useState<string[]>([])
  useEffect(() => {
    setCollapsedIds(current => {
      const remaining = current.filter(id => value.some(instance => instance.id === id))
      return remaining.length === current.length ? current : remaining
    })
  }, [value])
  const [tool, setTool] = useState<ToolInstance['tool']>('meters')
  return <section className="tool-setup" aria-labelledby="tool-setup-title">
    <h3 id="tool-setup-title">Tool Setup</h3>
    <fieldset disabled={disabled}>
      <legend>Add Tool Instance</legend>
      <div className="tool-setup-add-controls">
      <select aria-label="Tool type" value={tool} onChange={event => setTool(event.target.value as ToolInstance['tool'])}>
        {['meters', 'powers', 'scopes', 'wavegen'].map(type => <option key={type} value={type}>{type}</option>)}
      </select>
      <button type="button" className="action-button" onClick={() => {
        let n = 1
        while (value.some(instance => instance.id === `${tool}-${n}`)) n++
        const id = `${tool}-${n}`
        const instance: ToolInstance = tool === 'meters'
          ? { id, tool, setup: { measurement: 'voltage-dc', range_mode: 'auto', manual_range: null,
              nplc: 1, auto_zero: 'on', dcv_input_impedance: null, current_terminal: null,
              vm_comp_slope: null,
              trigger_mode: 'software', sample_count: 1, buffer_drain_size: null,
              allow_buffer_overflow_risk: false } }
          : { id, tool, setup: {} }
        setCollapsedIds(current => current.filter(collapsedId => collapsedId !== id))
        onChange([...value, instance])
      }}>Add Tool Instance</button>
      </div>
    </fieldset>
    {value.map(instance => {
      const collapsed = collapsedIds.includes(instance.id)
      const referenced = steps.some(step => step.type === 'tool-action' && step.target === instance.id)
      return <fieldset key={instance.id} disabled={disabled}>
        <legend>
          <button type="button" className="action-button tool-setup-toggle"
            aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${instance.id}`}
            onClick={() => setCollapsedIds(current => collapsed
              ? current.filter(id => id !== instance.id) : [...current, instance.id])}>
            {collapsed ? '+' : '−'}
          </button>
          {instance.id}
        </legend>
        {collapsed ? <p className="tool-setup-hint">{setupSummary(instance)}</p> : <>
          <p>{instance.tool[0].toUpperCase() + instance.tool.slice(1)}</p>
          {instance.tool === 'meters'
            ? <MetersSetupFields metersExecutableKey={metersExecutableKey} model={resourceIdentities[instance.id]?.model}
                plannedTriggerCount={plannedMeterMeasureCount(steps, instance.id)}
                value={{ meters: instance.setup }}
                onChange={({ meters }) => onChange(value.map(item => item.id === instance.id ? { ...instance, setup: meters } : item))} />
            : instance.tool === 'powers'
              ? <PowersSetupFields value={instance.setup} modelId={resourceIdentities[instance.id]?.model_id}
                  powersExecutableKey={powersExecutableKey}
                  onChange={setup => onChange(value.map(item => item.id === instance.id ? { ...instance, setup } : item))} />
              : <p>No additional setup</p>}
          {renderResource(instance)}
          <button type="button" className="action-button action-button-danger" disabled={referenced}
            onClick={() => onChange(value.filter(item => item.id !== instance.id))}>Remove Tool Instance</button>
          {referenced && <p className="tool-setup-hint">Referenced by workflow steps. Remove those steps before removing this instance.</p>}
        </>}
        {instance.tool === 'powers' && instance.setup.protection &&
          <p className="tool-setup-hint">Protection settings are configured for this Power instance. Add a Power Protection Status step and Assert if the Workflow should fail when a protection trip is detected.</p>}
      </fieldset>
    })}
  </section>
}
