import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { allWorkflowSteps, type BackgroundConfig, type ScopesMeasurement, type WorkflowStep } from './workflow'
import type { ToolInstance } from './ToolSetupEditor'
import type { ExecutionMode } from './executionMode'
import type { ScopesCapabilities } from './scopesSetup'

export default function BackgroundSetup({ instance, value, steps, onChange, executionMode = 'simulate', modelId, scopesExecutableKey = '' }: {
  instance: ToolInstance; value: BackgroundConfig[]; steps: WorkflowStep[]; onChange: (value: BackgroundConfig[]) => void
  executionMode?: ExecutionMode; modelId?: string | null; scopesExecutableKey?: string
}) {
  const config = value.find(background => background.tool_instance_id === instance.id)
  const supported = instance.tool === 'meters' || instance.tool === 'scopes' || instance.tool === 'serial'
  const scopes = instance.tool === 'scopes'
  const serial = instance.tool === 'serial'
  const mode = instance.tool === 'meters' ? instance.setup.trigger_mode ?? 'software' : ''
  const custom = mode.endsWith('-custom')
  const software = instance.tool === 'meters' && (mode === 'software' || mode === 'software-custom')
  const [capabilities, setCapabilities] = useState<ScopesCapabilities | null>(null)
  useEffect(() => {
    if (!scopes || (executionMode === 'live' && !modelId)) {
      setCapabilities(null)
      return
    }
    let cancelled = false
    void invoke<ScopesCapabilities>('get_scopes_capabilities', { modelId: executionMode === 'live' ? modelId : null, executionMode })
      .then(result => { if (!cancelled) setCapabilities(result) }, () => { if (!cancelled) setCapabilities(null) })
    return () => { cancelled = true }
  }, [scopes, executionMode, modelId, scopesExecutableKey])
  const items = capabilities?.direct_measurement_items ?? []
  const channels = capabilities?.analog_channels ?? 1
  const foregroundReferenced = allWorkflowSteps(steps).some(step => step.type === 'tool-action' && step.target === instance.id)
  const referenced = config && allWorkflowSteps(steps).some(step => step.type === 'background' && step.background_id === config.id)
  const update = (change: Partial<BackgroundConfig>) => onChange(value.map(item => item.id === config?.id ? { ...item, ...change } : item))
  const measurements = config?.scopes_measurements ?? []
  function uniqueId(channel: number, item: string, except = -1) {
    const base = ('ch' + channel + '_' + item).replace(/[^a-zA-Z0-9_]/g, '_')
    let id = base; let suffix = 2
    while (measurements.some((m, index) => index !== except && m.id === id)) id = base + '_' + suffix++
    return id
  }
  function changeMeasurement(index: number, change: Partial<ScopesMeasurement>) {
    const next = [...measurements]
    const row = { ...next[index], ...change }
    if (change.channel !== undefined || change.item !== undefined) row.id = uniqueId(row.channel, row.item, index)
    next[index] = row
    update({ scopes_measurements: next })
  }
  return <section className="background-setup">
    <h4>Background Streaming</h4>
    {!supported && <p>Unsupported. Background Streaming requires Meters, Scopes or Serial.</p>}
    <label><input type="checkbox" checked={Boolean(config)} disabled={(!supported && !config) || Boolean(referenced)} onChange={event => {
      if (!event.target.checked) { onChange(value.filter(item => item !== config)); return }
      let index = 1
      while (value.some(item => item.id === 'background-' + index)) index++
      onChange([...value, {
        id: 'background-' + index, tool_instance_id: instance.id, live_monitor: false, limit_count: serial ? null : 1000,
        ...(scopes ? { scopes_measurements: [{ id: 'ch1_frequency', channel: 1, item: 'frequency' }], scopes_interval_seconds: 1 }
          : software ? { timer_interval_ms: 1000 } : {}),
      }])
    }} /> Use this instance as a Background</label>
    {config && <>
      <p>Background: <code>{config.id}</code>. Use Worker and Capture actions to control this instance.</p>
      {foregroundReferenced && <p role="alert">This instance still has Foreground actions. Remove those actions or use another instance before running.</p>}
      {!serial && <label>Source<select aria-label={config.id + ' source'} value={config.limit_count === null ? 'infinite' : 'finite'}
        onChange={event => update({ limit_count: event.target.value === 'infinite' ? null : 1000 })}>
        <option value="finite">Finite</option><option value="infinite">Infinite</option>
      </select></label>}
      {!serial && config.limit_count !== null && <label>{custom ? 'Trigger Count' : scopes ? 'Cycles' : 'Max Samples'}<input type="number" min={1} max={1000000} step={1} value={config.limit_count}
        onChange={event => update({ limit_count: Number(event.target.value) })} /></label>}
      {custom && <p>Each trigger records Sample Count readings. Infinite acquisition requires Allow Buffer Overflow Risk.</p>}
      {software && <label>Timer Interval (ms)<input type="number" required min={1} step={1} value={config.timer_interval_ms ?? ''}
        onChange={event => update({ timer_interval_ms: Number(event.target.value) })} /></label>}
      {software && <p>The first trigger is sent when ready. Each later trigger waits this interval after the previous measurement completes.</p>}
      {serial && <p>Serial RX runs continuously until Worker OFF, with no finite count or trigger.</p>}
      {scopes && <>
        <label>Measure interval (seconds)<input type="number" min={0} max={86400} step="any" required
          value={config.scopes_interval_seconds ?? 1}
          onChange={event => update({ scopes_interval_seconds: Number(event.target.value) })} /></label>
        <p>Wait after each complete Measure cycle. Channels are read sequentially; this is not a fixed sample rate.</p>
        <h5>Measurements</h5>
        {measurements.map((row, index) => <div key={row.id} className="tool-setup-add-controls">
          <label>Channel<select aria-label={'Measurement ' + (index + 1) + ' channel'} value={row.channel}
            onChange={event => changeMeasurement(index, { channel: Number(event.target.value) })}>
            {Array.from({ length: Math.max(channels, row.channel) }, (_, i) => i + 1)
              .map(channel => <option key={channel} value={channel}>CH{channel}</option>)}
          </select></label>
          <label>Item<select aria-label={'Measurement ' + (index + 1) + ' item'} value={row.item}
            onChange={event => changeMeasurement(index, { item: event.target.value })}>
            {!items.includes(row.item) && <option value={row.item}>{row.item}</option>}
            {items.map(item => <option value={item} key={item}>{item}</option>)}
          </select></label>
          <button type="button" disabled={measurements.length === 1} onClick={() => update({
            scopes_measurements: measurements.filter((_, i) => i !== index),
          })}>Remove</button>
        </div>)}
        <button type="button" className="action-button" onClick={() => {
          const item = items[0] ?? 'frequency'
          update({ scopes_measurements: [...measurements, { id: uniqueId(1, item), channel: 1, item }] })
        }}>+ Add Measurement</button>
      </>}
      <label><input type="checkbox" checked={config.live_monitor} onChange={event => update({ live_monitor: event.target.checked })} /> Live Monitor</label>
      <p>{serial ? 'Live Monitor shows a bounded continuous RX Hex/Text view independently of Capture.'
      : 'Live Monitor keeps the latest 1,000 samples as a Line. It does not record or export data.'}</p>
      {referenced && <p>Remove Background actions before turning off Background use.</p>}
    </>}
  </section>
}
