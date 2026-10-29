import { useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export function useSimulationSamples() {
  const [values, setValues] = useState<Record<string, string> | null>(null)
  const resolve = useRef<((value: Record<string, number> | null) => void) | null>(null)
  const valid = values !== null && Object.values(values).every(value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1000000)
  const finish = (accepted: boolean) => {
    if (accepted && !valid) return
    resolve.current?.(accepted ? Object.fromEntries(Object.entries(values!).map(([id, value]) => [id, Number(value)])) : null)
    resolve.current = null
    setValues(null)
  }
  async function request(templateJson: string, isCurrent: () => boolean): Promise<Record<string, number> | null> {
    const instances = await invoke<string[]>('get_simulation_sample_requirements', { templateJson })
    if (!isCurrent()) return null
    if (instances.length === 0) return {}
    setValues(Object.fromEntries(instances.map(id => [id, '1000'])))
    return new Promise(complete => { resolve.current = complete })
  }
  const dialog = values && <div className="simulation-samples-backdrop"><section className="simulation-samples-dialog" role="dialog" aria-modal="true" aria-labelledby="simulation-samples-title"
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); finish(false) } }}>
    <h2 id="simulation-samples-title">Meters Simulation samples</h2>
    <p>These Meters need a finite sample count to start Simulation. This is not the Unlimited While iteration count.
      Values apply to this run only and do not change the Template, Setup, Steps, or Run Live.
      If the source runs out while the Workflow still requests Measure, that step fails.</p>
    {Object.entries(values).map(([id, value], index) => <label key={id}>{id} · SIM Max Samples
      <input autoFocus={index === 0} aria-label={`${id} SIM Max Samples`} type="number" min={1} max={1000000} step={1} value={value}
        onChange={event => setValues(current => ({ ...current, [id]: event.target.value }))} /></label>)}
    {!valid && <p role="alert">Enter a whole number from 1 to 1,000,000 for each Meters instance.</p>}
    <button type="button" onClick={() => finish(false)}>Cancel</button>
    <button type="button" disabled={!valid} onClick={() => finish(true)}>Run Simulation</button>
  </section></div>
  return { request, dialog, pending: values !== null }
}
