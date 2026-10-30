import { allWorkflowSteps, type BackgroundConfig, type WorkflowStep } from './workflow'
import type { ToolInstance } from './ToolSetupEditor'

export default function BackgroundSetup({ instance, value, steps, onChange }: {
  instance: ToolInstance; value: BackgroundConfig[]; steps: WorkflowStep[]; onChange: (value: BackgroundConfig[]) => void
}) {
  const config = value.find(background => background.tool_instance_id === instance.id)
  const supported = instance.tool === 'meters'
  const mode = instance.tool === 'meters' ? instance.setup.trigger_mode ?? 'software' : ''
  const custom = mode.endsWith('-custom')
  const software = mode === 'software' || mode === 'software-custom'
  const foregroundReferenced = allWorkflowSteps(steps).some(step => step.type === 'tool-action' && step.target === instance.id)
  const referenced = config && allWorkflowSteps(steps).some(step => step.type === 'background' && step.background_id === config.id)
  const update = (change: Partial<BackgroundConfig>) => onChange(value.map(item => item.id === config?.id ? { ...item, ...change } : item))
  return <section className="background-setup">
    <h4>Background Streaming</h4>
    {!supported && <p>Unsupported. Background Streaming currently requires Meters.</p>}
    <label><input type="checkbox" checked={Boolean(config)} disabled={(!supported && !config) || Boolean(referenced)} onChange={event => {
      if (!event.target.checked) { onChange(value.filter(item => item !== config)); return }
      let index = 1
      while (value.some(item => item.id === `background-${index}`)) index++
      onChange([...value, { id: `background-${index}`, tool_instance_id: instance.id, live_monitor: false, limit_count: 1000, ...(software ? { timer_interval_ms: 1000 } : {}) }])
    }} /> Use this instance as a Background</label>
    {config && <>
      <p>Background: <code>{config.id}</code>. Use Worker and Capture actions to control this instance.</p>
      {foregroundReferenced && <p role="alert">This instance still has Foreground actions. Remove those actions or use another instance before running.</p>}
      <label>Source<select aria-label={`${config.id} source`} value={config.limit_count === null ? 'infinite' : 'finite'}
        onChange={event => update({ limit_count: event.target.value === 'infinite' ? null : 1000 })}>
        <option value="finite">Finite</option><option value="infinite">Infinite</option>
      </select></label>
      {config.limit_count !== null && <label>{custom ? 'Trigger Count' : 'Max Samples'}<input type="number" min={1} max={1000000} step={1} value={config.limit_count}
        onChange={event => update({ limit_count: Number(event.target.value) })} /></label>}
      {custom && <p>Each trigger records Sample Count readings. Infinite acquisition requires Allow Buffer Overflow Risk.</p>}
      {software && <label>Timer Interval (ms)<input type="number" required min={1} step={1} value={config.timer_interval_ms ?? ''}
        onChange={event => update({ timer_interval_ms: Number(event.target.value) })} /></label>}
      {software && <p>The first trigger is sent when ready. Each later trigger waits this interval after the previous measurement completes.</p>}
      <label><input type="checkbox" checked={config.live_monitor} onChange={event => update({ live_monitor: event.target.checked })} /> Live Monitor</label>
      <p>Live Monitor keeps the latest 1,000 samples as a Line. It does not record or export data.</p>
      {referenced && <p>Remove Background actions before turning off Background use.</p>}
    </>}
  </section>
}
