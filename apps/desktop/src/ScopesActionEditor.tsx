import InputValueEditor from './InputValueEditor'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ExecutionMode } from './executionMode'
import type { ScopesCapabilities } from './scopesSetup'
import type { InputValueWire } from './inputValue'
import type { ToolInstance } from './ToolSetupEditor'
import type { ToolActionStep, WorkflowStep } from './workflow'

export default function ScopesActionEditor({ step, instances, earlierSteps, earlierVariables, disabled, onChange, stepLabel,
  executionMode, modelId, scopesExecutableKey }: {
  step: ToolActionStep; instances: ToolInstance[]; earlierSteps: WorkflowStep[]; earlierVariables: string[]
  disabled: boolean; onChange: (step: ToolActionStep) => void; stepLabel: (step: WorkflowStep) => string
  executionMode: ExecutionMode; modelId: string | null | undefined; scopesExecutableKey: string
}) {
  const [loaded, setLoaded] = useState<{ key: string; value: ScopesCapabilities | null; error?: string } | null>(null)
  const capabilityModelId = executionMode === 'live' ? modelId : undefined
  const key = JSON.stringify([executionMode, capabilityModelId, scopesExecutableKey, step.target])
  useEffect(() => {
    if (step.action !== 'screenshot' || (executionMode === 'live' && !capabilityModelId)) return
    let cancelled = false
    invoke<ScopesCapabilities>('get_scopes_capabilities', { modelId: capabilityModelId, executionMode }).then(
      value => { if (!cancelled) setLoaded({ key, value }) },
      error => { if (!cancelled) setLoaded({ key, value: null, error: String(error) }) },
    )
    return () => { cancelled = true }
  }, [step.action, executionMode, capabilityModelId, key])
  const caps = loaded?.key === key ? loaded.value : null
  const formats = caps?.screenshot_formats ?? []
  const format = String(step.arguments.format ?? 'png')
  const change = (key: string, value: unknown) => onChange({ ...step, arguments: { ...step.arguments, [key]: value } })
  const numeric = (key: string, label: string, fallback: number) => <InputValueEditor key={`${step.id}-${key}`}
    value={step.bindings?.[key] ?? { source: 'literal', value: step.arguments[key] as number ?? fallback }}
    sourceLabel={`${label} Source`} literalLabel={label} literalDefault={fallback}
    earlierSteps={earlierSteps} earlierVariables={earlierVariables} instances={instances} stepLabel={stepLabel} disabled={disabled}
    onChange={(value: InputValueWire) => {
      const bindings = { ...step.bindings }
      const arguments_ = { ...step.arguments }
      if (value.source === 'literal') { arguments_[key] = value.value; delete bindings[key] }
      else bindings[key] = value
      const next: ToolActionStep = { ...step, arguments: arguments_, bindings }
      if (!Object.keys(bindings).length) delete next.bindings
      onChange(next)
    }} />
  const channel = step.action.startsWith('channel-') || step.action === 'measure'
  return <>
    {channel && numeric('channel', 'Channel', 1)}
    {step.action === 'channel-display' && <label className="step-property-field"><span className="step-property-label">Display</span>
      <select value={step.arguments.off === true ? 'off' : 'on'} disabled={disabled} onChange={event => {
        const arguments_ = { ...step.arguments }; delete arguments_.on; delete arguments_.off; delete arguments_.query
        arguments_[event.target.value] = true
        onChange({ ...step, arguments: arguments_ })
      }}><option value="on">On</option><option value="off">Off</option></select></label>}
    {step.action === 'channel-scale' && numeric('volts_per_division', 'Volts per Division', 1)}
    {step.action === 'channel-offset' && numeric('volts', 'Offset (V)', 0)}
    {step.action === 'timebase-scale' && numeric('seconds_per_division', 'Seconds per Division', 0.001)}
    {step.action === 'timebase-position' && numeric('seconds', 'Position (s)', 0)}
    {step.action === 'trigger-edge' && <>
      {numeric('source_channel', 'Source Channel', 1)}{numeric('level', 'Level (V)', 0)}
      <label className="step-property-field"><span className="step-property-label">Slope</span><select value={String(step.arguments.slope ?? 'positive')}
        disabled={disabled} onChange={event => change('slope', event.target.value)}>
        {['positive', 'negative', 'either', 'alternate'].map(slope => <option key={slope} value={slope}>{slope}</option>)}
      </select></label>
    </>}
    {step.action === 'measure' && <label className="step-property-field"><span className="step-property-label">Measurement Item</span>
      <input type="text" value={String(step.arguments.item ?? '')} disabled={disabled} onChange={event => change('item', event.target.value)} />
      <span className="tool-setup-hint">Use a canonical Scopes item, such as vpp, vavg, frequency or period. Scopes validates model support.</span></label>}
    {step.action === 'capture' && <>
      <label className="step-property-field"><span className="step-property-label">Channels (comma separated)</span>
        <input type="text" defaultValue={Array.isArray(step.arguments.channel) ? step.arguments.channel.join(', ') : String(step.arguments.channel ?? 1)}
          key={`${step.id}-channels-${JSON.stringify(step.arguments.channel)}`} disabled={disabled} onBlur={event => {
            const channels = event.target.value.split(',').map(value => Number(value.trim()))
            change('channel', channels.every(value => Number.isInteger(value) && value > 0) ? channels : event.target.value)
          }} /></label>
      {numeric('points', 'Points', 1000)}
      <p className="tool-setup-hint">CSV and metadata are saved in Scopes File Output. Every execution creates new files.</p>
    </>}
    {step.action === 'screenshot' && <>
      <label className="step-property-field"><span className="step-property-label">Image Format</span>
        <select aria-label="Image Format" value={format} disabled={disabled || formats.length === 0} onChange={event => {
          if (!disabled && formats.includes(event.target.value)) change('format', event.target.value)
        }}>
          <option value="png" disabled={!formats.includes('png')}>PNG</option>
          <option value="bmp" disabled={!formats.includes('bmp')}>BMP</option>
          <option value="bmp8bit" disabled={!formats.includes('bmp8bit')}>BMP 8-bit</option>
          {!['png', 'bmp', 'bmp8bit'].includes(format) && <option value={format} disabled>{format}</option>}
        </select></label>
      {executionMode === 'live' && !capabilityModelId && <p className="tool-setup-hint">Capability unavailable. Select or refresh a supported Live Resource.</p>}
      {(executionMode === 'simulate' || capabilityModelId) && loaded?.key !== key && <p className="tool-setup-hint">Loading offline Scopes capabilities...</p>}
      {(executionMode === 'simulate' || capabilityModelId) && loaded?.key === key && !caps && <p className="tool-setup-hint">Capability unavailable: {loaded.error}</p>}
      {caps && formats.length === 0 && <p className="tool-setup-hint">Screenshot formats are unavailable for the current model.</p>}
      {caps && !formats.includes(format) && <p className="tool-setup-hint">Unsupported by the current model; existing Image Format preserved.</p>}
      <p className="tool-setup-hint">The image is saved in Scopes File Output. Scopes validates the format against the selected model.</p>
    </>}
  </>
}
