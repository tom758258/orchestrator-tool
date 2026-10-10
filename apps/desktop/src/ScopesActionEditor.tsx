import InputValueEditor from './InputValueEditor'
import type { InputValueWire } from './inputValue'
import type { ToolInstance } from './ToolSetupEditor'
import type { ToolActionStep, WorkflowStep } from './workflow'

export default function ScopesActionEditor({ step, instances, earlierSteps, earlierVariables, disabled, onChange, stepLabel }: {
  step: ToolActionStep; instances: ToolInstance[]; earlierSteps: WorkflowStep[]; earlierVariables: string[]
  disabled: boolean; onChange: (step: ToolActionStep) => void; stepLabel: (step: WorkflowStep) => string
}) {
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
        <select value={String(step.arguments.format ?? 'png')} disabled={disabled} onChange={event => change('format', event.target.value)}>
          <option value="png">PNG</option><option value="bmp">BMP</option><option value="bmp8bit">BMP 8-bit</option>
        </select></label>
      <p className="tool-setup-hint">The image is saved in Scopes File Output. Scopes validates the format against the selected model.</p>
    </>}
  </>
}
