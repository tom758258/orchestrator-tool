import { useState } from 'react'
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

function MetersSetupFields({ value, onChange }: { value: { meters: MetersSetup }; onChange: (value: { meters: MetersSetup }) => void }) {
  const meters = value.meters
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
        {meters.range_mode === 'manual' && (
          <label className="step-property-field">
            <span className="step-property-label">Manual Range ({meters.measurement === 'voltage-dc' ? 'V' : 'A'})</span>
            <input type="number" step="any" required value={meters.manual_range ?? ''}
              onChange={(event) => onChange({
                ...value, meters: { ...meters, manual_range: Number.isFinite(event.currentTarget.valueAsNumber) ? event.currentTarget.valueAsNumber : null },
              })} />
          </label>
        )}
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

export default function ToolSetupEditor({ value, steps, onChange, disabled, renderResource }: {
  value: ToolInstance[]; steps: WorkflowStep[]; onChange: (value: ToolInstance[]) => void; disabled: boolean
  renderResource: (instance: ToolInstance) => ReactNode
}) {
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
        onChange([...value, instance])
      }}>Add Tool Instance</button>
    </fieldset>
    {value.map(instance => {
      const referenced = steps.some(step => step.type === 'tool-action' && step.target === instance.id)
      return <fieldset key={instance.id} disabled={disabled}>
        <legend>{instance.id}</legend>
        <p>Type: {instance.tool}</p>
        {instance.tool === 'meters'
          ? <MetersSetupFields value={{ meters: instance.setup }} onChange={({ meters }) => onChange(value.map(item => item.id === instance.id ? { ...instance, setup: meters } : item))} />
          : <p>No additional setup</p>}
        {renderResource(instance)}
        <button type="button" className="action-button" disabled={referenced}
          onClick={() => onChange(value.filter(item => item.id !== instance.id))}>Remove Tool Instance</button>
        {referenced && <p className="tool-setup-hint">Referenced by workflow steps. Remove those steps before removing this instance.</p>}
      </fieldset>
    })}
  </section>
}
