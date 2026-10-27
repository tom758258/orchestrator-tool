import { allWorkflowSteps, type BackgroundConfig, type WorkflowStep } from './workflow'
import type { ToolInstance } from './ToolSetupEditor'

export default function BackgroundSetup({ instance, value, steps, onChange }: {
  instance: ToolInstance; value: BackgroundConfig[]; steps: WorkflowStep[]; onChange: (value: BackgroundConfig[]) => void
}) {
  const config = value.find(background => background.tool_instance_id === instance.id)
  const supported = instance.tool === 'meters' && instance.setup.trigger_mode === 'immediate-custom'
  const referenced = config && allWorkflowSteps(steps).some(step => step.type === 'background' && step.background_id === config.id)
  const update = (change: Partial<BackgroundConfig>) => onChange(value.map(item => item.id === config?.id ? { ...item, ...change } : item))
  return <section className="background-setup">
    <h4>Background Streaming</h4>
    {!supported && <p>Unsupported. Background Streaming currently requires Meters Immediate Custom.</p>}
    <label><input type="checkbox" checked={Boolean(config)} disabled={(!supported && !config) || Boolean(referenced)} onChange={event => {
      if (!event.target.checked) { onChange(value.filter(item => item !== config)); return }
      let index = 1
      while (value.some(item => item.id === `background-${index}`)) index++
      onChange([...value, { id: `background-${index}`, tool_instance_id: instance.id, live_monitor: false, trigger_count: 1000 }])
    }} /> Use this instance as a Background</label>
    {config && <>
      <p>Background ID: <code>{config.id}</code>. Foreground actions cannot use this instance.</p>
      <label>Source<select aria-label={`${config.id} source`} value={config.trigger_count === null ? 'infinite' : 'finite'}
        onChange={event => update({ trigger_count: event.target.value === 'infinite' ? null : 1000 })}>
        <option value="finite">Finite</option><option value="infinite">Native Infinite</option>
      </select></label>
      {config.trigger_count !== null && <label>Trigger count<input type="number" min={1} max={1000000} step={1} value={config.trigger_count}
        onChange={event => update({ trigger_count: Number(event.target.value) })} /></label>}
      <p>Each trigger uses the Sample Count in Meters Setup. Infinite acquisition uses the Tool's existing overflow risk confirmation.</p>
      <label><input type="checkbox" checked={config.live_monitor} onChange={event => update({ live_monitor: event.target.checked })} /> Live Monitor</label>
      <p>Live Monitor keeps the latest 1,000 samples as a Line. It does not record or export data.</p>
      {referenced && <p>Remove Background actions before removing this binding.</p>}
    </>}
  </section>
}
