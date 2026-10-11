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
  const channelAction = ['channel-display', 'channel-scale', 'channel-offset', 'trigger-edge', 'measure', 'capture'].includes(step.action)
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
    ? 'Capability unavailable. Select or refresh a supported Live Resource.'
    : loaded?.key !== key ? 'Loading offline Scopes capabilities...'
    : !caps ? `Capability unavailable: ${loaded.error}` : null
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
          <option value="" disabled>{bound ? 'Bound channel (preserved)' : 'Select a channel...'}</option>
          {!bound && saved !== undefined && !supported && <option value={String(saved)} disabled>
            CH{String(saved)} ({caps ? 'not supported' : 'unconfirmed'})
          </option>}
          {channels.map(channel => <option key={channel} value={channel}>CH{channel}</option>)}
        </select></label>
      {bound ? <p className="tool-setup-hint">Channel binding preserved. Select a fixed channel to replace it.</p>
        : saved !== undefined && !supported && <p className="tool-setup-hint">
          Saved channel {String(saved)} preserved: {caps ? 'not supported by the current model.' : 'support cannot be confirmed.'}
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
          <option value="" disabled>Select {label.toLowerCase()}...</option>
          {options.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      {options.length === 0 && <p className="tool-setup-hint">{label} options are unavailable.</p>}
      {!valid && <p className="tool-setup-hint">{label} is invalid or unconfirmed. Select a supported fixed value.</p>}
    </>
  }
  const numeric = (key: string, label: string, fallback: number) => <InputValueEditor key={`${step.id}-${key}`}
    value={step.bindings?.[key] ?? { source: 'literal', value: step.arguments[key] as number ?? fallback }}
    numericSetpoint
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
  const savedChannels = step.arguments.channel
  const captureSupported = Array.isArray(savedChannels) && savedChannels.length > 0
    && savedChannels.every(value => typeof value === 'number' && channels.includes(value))
    && new Set(savedChannels).size === savedChannels.length
  const captureBound = step.bindings?.channel !== undefined
  const selectedChannels: number[] = captureSupported && !captureBound ? [...new Set(savedChannels)] : []
  return <>
    {channelAction && capabilityHint && <p className="tool-setup-hint">{capabilityHint}</p>}
    {channelAction && caps && channels.length === 0 && <p className="tool-setup-hint">No supported channels were returned for the current model.</p>}
    {channel && channelSelector('channel', 'Channel')}
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
      {channelSelector('source_channel', 'Source Channel')}{numeric('level', 'Level (V)', 0)}
      {capabilityChoice('slope', 'Slope', caps?.trigger_edge_slopes ?? [])}
    </>}
    {step.action === 'measure' && capabilityChoice('item', 'Measurement Item', caps?.direct_measurement_items ?? [])}
    {step.action === 'capture' && <>
      <div className="step-property-field"><span className="step-property-label">Channels</span>
        {channels.map(channel => <label key={channel} className="step-property-checkbox">
          <input type="checkbox" aria-label={`Capture CH${channel}`} checked={selectedChannels.includes(channel)}
            disabled={disabled || (selectedChannels.length === 1 && selectedChannels.includes(channel))} onChange={event => {
              if (disabled || !channels.includes(channel)) return
              const next = event.target.checked ? [...new Set([...selectedChannels, channel])]
                : selectedChannels.filter(value => value !== channel)
              if (next.length) changeFixed('channel', next.sort((a, b) => a - b))
            }} />CH{channel}
        </label>)}
      </div>
      {captureBound ? <p className="tool-setup-hint">Channel binding preserved. Select fixed channels to replace it.</p>
        : !captureSupported && <p className="tool-setup-hint">
          Saved Capture channels {JSON.stringify(savedChannels) ?? '(unset)'} preserved: {caps
            ? 'invalid or not supported by the current model. Select channels to replace them.' : 'support cannot be confirmed.'}
        </p>}
      {capabilityChoice('points', 'Points', caps?.capture_point_options ?? [])}
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
      {capabilityHint && <p className="tool-setup-hint">{capabilityHint}</p>}
      {caps && formats.length === 0 && <p className="tool-setup-hint">Screenshot formats are unavailable for the current model.</p>}
      {caps && !formats.includes(format) && <p className="tool-setup-hint">Unsupported by the current model; existing Image Format preserved.</p>}
      <p className="tool-setup-hint">The image is saved in Scopes File Output. Scopes validates the format against the selected model.</p>
    </>}
  </>
}
