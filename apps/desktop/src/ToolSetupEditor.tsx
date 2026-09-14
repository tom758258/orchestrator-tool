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
}

export type ToolInstance =
  | { id: string; tool: 'meters'; setup: MetersSetup }
  | { id: string; tool: 'powers' | 'scopes' | 'wavegen'; setup: Record<string, never> }

const METERS_NPLC_OPTIONS = [0.02, 0.2, 1, 10, 100] as const

type MetersRangeOptions = { measurement_name: string; range_values: number[] }

function formatRange(value: number, unit: string): string {
  const magnitude = Math.abs(value)
  const exponent = magnitude === 0 ? 0 : Math.max(-12, Math.min(12, Math.floor(Math.log10(magnitude) / 3) * 3))
  const prefix: Record<number, string> = { '-12': 'p', '-9': 'n', '-6': '\u00b5', '-3': 'm', 0: '', 3: 'k', 6: 'M', 9: 'G', 12: 'T' }
  return `${Number((value / 10 ** exponent).toPrecision(12))} ${prefix[exponent]}${unit}`
}

function MetersSetupFields({ value, onChange, model, metersExecutableKey }: {
  value: { meters: MetersSetup }; onChange: (value: { meters: MetersSetup }) => void; model?: string | null; metersExecutableKey: string
}) {
  const [capabilities, setCapabilities] = useState<{ model: string; metersExecutableKey: string; options: MetersRangeOptions[] | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    setCapabilities(null)
    if (model) {
      invoke<MetersRangeOptions[]>('get_meters_range_options', { model }).then(
        options => { if (!cancelled) setCapabilities({ model, metersExecutableKey, options }) },
        () => { if (!cancelled) setCapabilities({ model, metersExecutableKey, options: null }) },
      )
    }
    return () => { cancelled = true }
  }, [model, metersExecutableKey])
  const meters = value.meters
  const currentCapabilities = capabilities?.model === model && capabilities?.metersExecutableKey === metersExecutableKey ? capabilities : null
  const ranges = currentCapabilities?.options?.find(option => option.measurement_name === meters.measurement)?.range_values
  const unsupportedRange = meters.range_mode === 'manual' && ranges !== undefined && meters.manual_range !== null && !ranges.includes(meters.manual_range)
  const unit = meters.measurement === 'voltage-dc' ? 'V' : 'A'
  const hasStandardNplc = METERS_NPLC_OPTIONS.some((option) => option === meters.nplc)
  return (
    <>
      <p className="tool-setup-hint">Applied before the run starts. Trigger: Software.</p>
      <div className="meters-setup-fields">
        <label className="step-property-field">
          <span className="step-property-label">Measurement</span>
          <select value={meters.measurement} onChange={(event) => {
            const measurement = event.target.value as MetersSetup['measurement']
            onChange({ ...value, meters: {
              ...meters,
              measurement,
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
              {unsupportedRange && <option value={meters.manual_range!}>{formatRange(meters.manual_range!, unit)} (current, unsupported)</option>}
              {ranges.map(range => <option key={range} value={range}>{formatRange(range, unit)}</option>)}
            </select>
          ) : (
            <input type="number" step="any" required disabled={meters.range_mode !== 'manual'} value={meters.manual_range ?? ''}
              onChange={(event) => onChange({
                ...value, meters: { ...meters, manual_range: Number.isFinite(event.currentTarget.valueAsNumber) ? event.currentTarget.valueAsNumber : null },
              })} />
          )}
          {currentCapabilities && ranges === undefined && (
            <span className="tool-setup-hint">Supported range options could not be loaded. Enter a range manually.</span>
          )}
          {unsupportedRange && <span className="tool-setup-hint">Current range is not supported by this model for this measurement.</span>}
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
        {meters.measurement === 'voltage-dc' && (
          <label className="step-property-field">
            <span className="step-property-label">Input Impedance</span>
            <select value={meters.dcv_input_impedance ?? ''} onChange={(event) => onChange({
              ...value, meters: { ...meters, dcv_input_impedance: (event.target.value || null) as MetersSetup['dcv_input_impedance'] },
            })}>
              <option value="">Not specified</option>
              <option value="default">Default</option>
              <option value="ten-megohm">10 MΩ</option>
              <option value="auto">Auto</option>
            </select>
          </label>
        )}
        {meters.measurement === 'current-dc' && (
          <label className="step-property-field">
            <span className="step-property-label">Current Terminal (optional)</span>
            <select value={meters.current_terminal ?? ''} onChange={(event) => onChange({
              ...value, meters: { ...meters, current_terminal: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) },
            })}>
              <option value="">Not specified</option>
              <option value="3">3 A terminal</option>
              <option value="10">10 A terminal</option>
            </select>
          </label>
        )}
      </div>
    </>
  )
}

function setupSummary(instance: ToolInstance): string {
  const type = instance.tool[0].toUpperCase() + instance.tool.slice(1)
  if (instance.tool !== 'meters') return `${type} · No additional setup`
  const meters = instance.setup
  const voltage = meters.measurement === 'voltage-dc'
  const range = meters.range_mode === 'auto' ? 'Auto Range'
    : meters.manual_range !== null && Number.isFinite(meters.manual_range)
      ? `Manual ${meters.manual_range} ${voltage ? 'V' : 'A'}` : 'Manual Range'
  return `${type} · ${voltage ? 'DC Voltage' : 'DC Current'} · ${range} · NPLC ${meters.nplc}`
}

export default function ToolSetupEditor({ value, steps, onChange, disabled, renderResource, resourceIdentities, metersExecutableKey }: {
  value: ToolInstance[]; steps: WorkflowStep[]; onChange: (value: ToolInstance[]) => void; disabled: boolean
  resourceIdentities: Record<string, { model: string | null } | null>
  metersExecutableKey: string
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
      <select aria-label="Tool type" value={tool} onChange={event => setTool(event.target.value as ToolInstance['tool'])}>
        {['meters', 'powers', 'scopes', 'wavegen'].map(type => <option key={type} value={type}>{type}</option>)}
      </select>
      <button type="button" className="action-button" onClick={() => {
        let n = 1
        while (value.some(instance => instance.id === `${tool}-${n}`)) n++
        const id = `${tool}-${n}`
        const instance: ToolInstance = tool === 'meters'
          ? { id, tool, setup: { measurement: 'voltage-dc', range_mode: 'auto', manual_range: null,
              nplc: 1, auto_zero: 'on', dcv_input_impedance: null, current_terminal: null } }
          : { id, tool, setup: {} }
        setCollapsedIds(current => current.filter(collapsedId => collapsedId !== id))
        onChange([...value, instance])
      }}>Add Tool Instance</button>
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
            ? <MetersSetupFields metersExecutableKey={metersExecutableKey} model={resourceIdentities[instance.id]?.model} value={{ meters: instance.setup }} onChange={({ meters }) => onChange(value.map(item => item.id === instance.id ? { ...instance, setup: meters } : item))} />
            : <p>No additional setup</p>}
          {renderResource(instance)}
          <button type="button" className="action-button" disabled={referenced}
            onClick={() => onChange(value.filter(item => item.id !== instance.id))}>Remove Tool Instance</button>
          {referenced && <p className="tool-setup-hint">Referenced by workflow steps. Remove those steps before removing this instance.</p>}
        </>}
      </fieldset>
    })}
  </section>
}
