import { useI18n } from './i18n/I18nProvider'
import { toolInstanceLabel } from './toolInstanceLabel'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkflowStep } from './App'
import { executionModeLabel, type ExecutionMode } from './executionMode'
import BackgroundSetup from './BackgroundSetup'
import type { BackgroundConfig } from './workflow'
import MetersSetupFields from './toolSetup/MetersSetupFields'
import PowersSetupFields from './toolSetup/PowersSetupFields'
import ScopesSetupFields from './toolSetup/ScopesSetupFields'
import SerialSetupFields from './toolSetup/SerialSetupFields'
import type { ToolInstance } from './toolSetup/types'

export default function ToolSetupEditor({ value, configuredToolTypes, steps, onChange, disabled, renderResource, renderPowersDeviceStatus, resourceIdentities, executionMode, metersExecutableKey, powersExecutableKey, scopesExecutableKey, backgrounds = [], onBackgroundsChange }: {
  value: ToolInstance[]; steps: WorkflowStep[]; onChange: (value: ToolInstance[]) => void; disabled: boolean
  configuredToolTypes: ToolInstance['tool'][]
  resourceIdentities: Record<string, { model: string | null; model_id?: string | null } | null>
  executionMode: ExecutionMode
  metersExecutableKey: string
  powersExecutableKey: string
  scopesExecutableKey: string
  renderResource: (instance: ToolInstance) => ReactNode
  renderPowersDeviceStatus: (instance: Extract<ToolInstance, { tool: 'powers' }>) => ReactNode
  backgrounds?: BackgroundConfig[]
  onBackgroundsChange?: (value: BackgroundConfig[]) => void
}) {
  function setupSummary(instance: ToolInstance, background?: BackgroundConfig): string {
    const type = instance.tool[0].toUpperCase() + instance.tool.slice(1)
    if (instance.tool === 'serial') return instance.setup.transport === 'tcp'
      ? t("toolSetupEditor.tcpSummary", { value1: instance.setup.io_timeout_ms ?? 1000 })
      : t("toolSetupEditor.serialSummary", { value1: instance.setup.baud, value2: instance.setup.data_bits })
    if (instance.tool === 'powers') return `${type} · ${instance.setup.protection ? t("toolSetupEditor.protectionSetup2") : t("toolSetupEditor.noProtectionSettingsConfigured")}`
    if (instance.tool === 'scopes') return t("toolSetupEditor.scopeSummary", { type, acquisition: instance.setup.acquisition ? t("toolSetupEditor.acquisitionSetup2") : t("toolSetupEditor.acquisitionUnchanged"), count: instance.setup.channels?.length ?? 0 })
    if (instance.tool !== 'meters') return `${type} · ${t("toolSetupEditor.noAdditionalSetup")}`
    const meters = instance.setup
    const voltage = meters.measurement === 'voltage-dc'
    const range = meters.range_mode === 'auto' ? t("toolSetupEditor.autoRange")
      : meters.manual_range !== null && Number.isFinite(meters.manual_range)
        ? t("toolSetupEditor.manualRangeSummary", { value1: meters.manual_range, value2: voltage ? 'V' : 'A' }) : t("toolSetupEditor.manualRange2")
    const trigger = ({ software: background ? t("toolSetupEditor.software") : t("toolSetupEditor.single"), immediate: t("toolSetupEditor.immediate"), external: t("toolSetupEditor.external"), 'software-custom': t("toolSetupEditor.softwareCustom"), 'immediate-custom': t("toolSetupEditor.immediateCustom"), 'external-custom': t("toolSetupEditor.externalCustom") } as const)[meters.trigger_mode ?? 'software']
    return `${type} · ${trigger} · ${voltage ? t("toolSetupEditor.dCVoltage") : t("toolSetupEditor.dCCurrent")} · ${range} · NPLC ${meters.nplc}`
  }

    const { t } = useI18n()
  const [collapsedIds, setCollapsedIds] = useState<string[]>([])
  useEffect(() => {
    setCollapsedIds(current => {
      const remaining = current.filter(id => value.some(instance => instance.id === id))
      return remaining.length === current.length ? current : remaining
    })
  }, [value])
  const [selectedTool, setTool] = useState<ToolInstance['tool'] | ''>('')
  const tool = configuredToolTypes.includes(selectedTool as ToolInstance['tool'])
    ? selectedTool : configuredToolTypes[0] ?? ''
  const instanceCounts = value.reduce<Partial<Record<ToolInstance['tool'], number>>>((counts, instance) => {
    counts[instance.tool] = (counts[instance.tool] ?? 0) + 1
    return counts
  }, {})
  return <section className="tool-setup" aria-labelledby="tool-setup-title">
    <h3 id="tool-setup-title">{t("toolSetupEditor.toolSetup")}</h3>
    {value.length > 0 && <section className="tool-instance-summary" aria-labelledby="tool-instance-summary-title">
      <h4 id="tool-instance-summary-title">{t("toolSetupEditor.toolInstanceSummary")}</h4>
      <dl className="tool-instance-counts">
        {Object.entries(instanceCounts).map(([type, count]) => <div key={type}>
          <dt>{type[0].toUpperCase() + type.slice(1)}</dt><dd>{count}</dd>
        </div>)}
      </dl>
    </section>}
    <fieldset disabled={disabled || !tool}>
      <legend>{t("toolSetupEditor.addToolInstance")}</legend>
      <div className="tool-setup-add-controls tool-setup-add-instance-controls">
      <div className="tool-setup-tool-choice">
      <label htmlFor="tool-instance-type" className="step-property-label">{t("toolSetupEditor.selectToolType")}</label>
      <select id="tool-instance-type" aria-label={t("toolSetupEditor.toolType")} value={tool} onChange={event => setTool(event.target.value as ToolInstance['tool'])}>
        {!tool && <option value="">{t("toolSetupEditor.noConfiguredTools")}</option>}
        {configuredToolTypes.map(type => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}
      </select>
      </div>
      <button type="button" className="action-button" onClick={() => {
        if (!tool) return
        let n = 1
        while (value.some(instance => instance.id === `${tool}-${n}`)) n++
        const id = `${tool}-${n}`
        const instance: ToolInstance = tool === 'meters'
          ? { id, tool, setup: { measurement: 'voltage-dc', range_mode: 'auto', manual_range: null,
              nplc: 1, auto_zero: 'on', dcv_input_impedance: null, current_terminal: null,
              vm_comp_slope: null,
              trigger_mode: 'software', sample_count: 1, buffer_drain_size: null,
              allow_buffer_overflow_risk: false } }
          : tool === 'serial'
            ? { id, tool, setup: { transport: 'serial', baud: 115200, data_bits: 8, parity: 'none', stop_bits: 1, flow_control: 'none', timeout_ms: 1000, connect_timeout_ms: 3000, io_timeout_ms: 1000 } }
            : { id, tool, setup: {} }
        setCollapsedIds(current => current.filter(collapsedId => collapsedId !== id))
        onChange([...value, instance])
      }}>{t("toolSetupEditor.addToolInstance")}</button>
      </div>
    </fieldset>
    {!tool && <p className="tool-setup-hint">{t("toolSetupEditor.configureAnExternalToolInToolsBeforeAddingA")}</p>}
    {value.map(instance => {
      const collapsed = collapsedIds.includes(instance.id)
      const background = backgrounds.find(item => item.tool_instance_id === instance.id)
      const referenced = steps.some(step => step.type === 'tool-action' && step.target === instance.id)
      return <fieldset key={instance.id} className="tool-instance-card" disabled={disabled}>
        <legend>
          <button type="button" className="action-button tool-setup-toggle"
            data-scopes-count-disclosure={instance.tool === 'scopes' ? '' : undefined}
            aria-expanded={!collapsed} aria-label={`${collapsed ? t("toolSetupEditor.expand") : t("toolSetupEditor.collapse")} ${instance.id}`}
            onClick={() => setCollapsedIds(current => collapsed
              ? current.filter(id => id !== instance.id) : [...current, instance.id])}>
            {collapsed ? '+' : '−'}
          </button>
          <span>{toolInstanceLabel(instance, false)}</span>
          <span className={`execution-mode-badge execution-mode-${executionMode}`}>{executionModeLabel(executionMode, t)}</span>
        </legend>
        {instance.display_name?.trim() && <p className="tool-setup-hint">{t("toolSetupEditor.instanceID")}{instance.id}</p>}
        {!configuredToolTypes.includes(instance.tool) && <p className="tool-setup-hint" role="status">
          {instance.tool[0].toUpperCase() + instance.tool.slice(1)} {t("toolSetupEditor.isNotConfiguredInTools")}</p>}
        {collapsed && <p className="tool-setup-hint">{setupSummary(instance, background)}</p>}
        {/* Keep setup fields mounted so collapsing never discards local drafts or reloads capabilities. */}
        <div hidden={collapsed}>
          <label className="step-property-field">
            <span className="step-property-label">{t("toolSetupEditor.displayNameOptional")}</span>
            <input type="text" disabled={disabled} value={instance.display_name ?? ''}
              onChange={event => {
                if (disabled) return
                const display_name = event.target.value || undefined
                onChange(value.map(item => item.id === instance.id ? { ...item, display_name } : item))
              }}
              onBlur={event => {
                if (disabled) return
                const display_name = event.target.value.trim() || undefined
                if (display_name === instance.display_name) return
                onChange(value.map(item => item.id === instance.id ? { ...item, display_name } : item))
              }} />
            <span className="tool-setup-hint">{t("toolSetupEditor.leaveBlankToUseTheDefaultInstanceID")}</span>
          </label>
          <p>{instance.tool[0].toUpperCase() + instance.tool.slice(1)}</p>
          {instance.tool === 'meters'
            ? <MetersSetupFields metersExecutableKey={metersExecutableKey}
                model={executionMode === 'live' ? resourceIdentities[instance.id]?.model : undefined}
                executionMode={executionMode}
                background={background}
                value={{ meters: instance.setup }}
                onChange={({ meters }) => {
                  onChange(value.map(item => item.id === instance.id ? { ...instance, setup: meters } : item))
                  if (background && meters.trigger_mode !== instance.setup.trigger_mode) {
                    const software = meters.trigger_mode === 'software' || meters.trigger_mode === 'software-custom'
                    onBackgroundsChange?.(backgrounds.map(item => item.id === background.id
                      ? { ...item, timer_interval_ms: software ? item.timer_interval_ms ?? 1000 : undefined } : item))
                  }
                }} />
            : instance.tool === 'powers'
              ? <PowersSetupFields value={instance.setup}
                  modelId={executionMode === 'live' ? resourceIdentities[instance.id]?.model_id : undefined}
                  executionMode={executionMode}
                  powersExecutableKey={powersExecutableKey}
                  onChange={setup => onChange(value.map(item => item.id === instance.id ? { ...instance, setup } : item))}>
                  <div className="powers-device">
                    <h4 className="powers-section-heading">{t("toolSetupEditor.device")}</h4>
                    {renderPowersDeviceStatus(instance)}
                  </div>
                </PowersSetupFields>
              : instance.tool === 'scopes'
                ? <ScopesSetupFields value={instance.setup} onChange={setup => onChange(value.map(item => item.id === instance.id ? { ...instance, setup } : item))}
                    modelId={executionMode === 'live' ? resourceIdentities[instance.id]?.model_id : undefined}
                    executionMode={executionMode} scopesExecutableKey={scopesExecutableKey} />
              : instance.tool === 'serial'
                ? <SerialSetupFields value={instance.setup} onChange={setup =>
                    onChange(value.map(item => item.id === instance.id ? { ...instance, setup } : item))} />
              : <>
                  <p>{t("toolSetupEditor.noAdditionalSetup")}</p>
                  <p className="tool-setup-hint">{executionMode === 'simulate'
                    ? t("toolSetupEditor.simulationSelectedOrchestratorRuntimeActionsForThisToolType")
                    : t("toolSetupEditor.orchestratorRuntimeActionsForThisToolTypeAreNot")}</p>
                </>}
          {onBackgroundsChange && <BackgroundSetup instance={instance} value={backgrounds} steps={steps} onChange={onBackgroundsChange}
            executionMode={executionMode} modelId={executionMode === 'live' ? resourceIdentities[instance.id]?.model_id : null}
            scopesExecutableKey={scopesExecutableKey} />}
          {renderResource(instance)}
          <button type="button" className="action-button action-button-danger" disabled={referenced || backgrounds.some(background => background.tool_instance_id === instance.id)}
            onClick={() => onChange(value.filter(item => item.id !== instance.id))}>{t("toolSetupEditor.removeToolInstance")}</button>
          {referenced && <p className="tool-setup-hint">{t("toolSetupEditor.referencedByWorkflowStepsRemoveThoseStepsBeforeRemoving")}</p>}
        </div>
      </fieldset>
    })}
  </section>
}
