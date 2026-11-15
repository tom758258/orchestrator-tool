import { useI18n } from './i18n/I18nProvider'
import { useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export function useSimulationSamples() {
  const { t } = useI18n()
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
    <h2 id="simulation-samples-title">{t("useSimulationSamples.metersSimulationSamples")}</h2>
    <p>{t("useSimulationSamples.theseMetersNeedAFiniteSampleCountToStart")}</p>
    {Object.entries(values).map(([id, value], index) => <label key={id}>{id} {t("useSimulationSamples.sIMMaxSamples")}<input autoFocus={index === 0} aria-label={t("useSimulationSamples.sIMMaxSamples2", { value1: id })} type="number" min={1} max={1000000} step={1} value={value}
        onChange={event => setValues(current => ({ ...current, [id]: event.target.value }))} /></label>)}
    {!valid && <p role="alert">{t("useSimulationSamples.enterAWholeNumberFrom1To1000")}</p>}
    <button type="button" onClick={() => finish(false)}>{t("useSimulationSamples.cancel")}</button>
    <button type="button" disabled={!valid} onClick={() => finish(true)}>{t("useSimulationSamples.runSimulation")}</button>
  </section></div>
  return { request, dialog, pending: values !== null }
}
