import { useI18n } from './i18n/I18nProvider'
import InputValueEditor from './InputValueEditor'
import type { InputValueWire } from './inputValue'
import { hasPowerSetpoint, powerSetpointLiteralDefault, togglePowerSetpoint, type PowerSetpoint } from './powerSetpoint'
import type { ToolInstance } from './toolSetup/types'
import type { WorkflowDraft } from './templateDraft'
import type { ToolActionStep, WorkflowStep } from './workflow'

export type PowersChannelCapabilities = { status: 'ready'; channels: number[] } | { status: 'error' }

type Props = {
  selectedToolAction: ToolActionStep
  selectedAction: string | null
  selectedPowersAction: boolean
  selectedPowersModel: string | null | undefined
  selectedPowersCapabilities: PowersChannelCapabilities | undefined
  workflowDraft: WorkflowDraft
  workflowBusy: boolean
  earlierSteps: WorkflowStep[]
  earlierVariables: string[]
  stepLabel: (step: WorkflowStep, instances: ToolInstance[]) => string
  updateStep: (stepId: string, update: (step: WorkflowStep) => WorkflowStep) => void
  updateToolArgument: (stepId: string, name: string, value: number | 'all') => void
  updateSetpointValue: (stepId: string, name: PowerSetpoint, value: InputValueWire) => void
}

function numericArgument(step: ToolActionStep, name: string): number | '' {
  const value = step.arguments[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : ''
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1
}

export default function PowersActionEditor({
  selectedToolAction, selectedAction, selectedPowersAction, selectedPowersModel,
  selectedPowersCapabilities, workflowDraft, workflowBusy, earlierSteps, earlierVariables,
  stepLabel, updateStep, updateToolArgument, updateSetpointValue,
}: Props) {
  const { t } = useI18n()
  const selectedPowersChannels = selectedPowersCapabilities?.status === 'ready' ? selectedPowersCapabilities.channels : []
  const powersChannelHint = !selectedPowersModel
    ? t("app.channelCapabilitiesUnavailableSelectOrRefreshASupportedLive")
    : !selectedPowersCapabilities ? t("app.loadingChannelCapabilities")
    : selectedPowersCapabilities.status === 'error' ? t("app.channelCapabilitiesQueryFailedCheckTheConfiguredPowersTool")
    : selectedPowersChannels.length === 0 ? t("app.noSupportedChannelsWereReturnedForTheCurrentModel") : null
  const channelBound = selectedToolAction?.bindings?.channel !== undefined
  const savedChannel = selectedToolAction?.arguments.channel
  const savedChannelSupported = typeof savedChannel === 'number' && selectedPowersChannels.includes(savedChannel)
  const powersChannelSelector = selectedToolAction && <>
    <label className="step-property-field">
      <span className="step-property-label">{t("app.channel")}</span>
      <select aria-label={t("app.channel")} value={channelBound || savedChannel === undefined ? '' : String(savedChannel)}
        disabled={workflowBusy || selectedPowersChannels.length === 0}
        onChange={event => {
          const channel = Number(event.target.value)
          if (isPositiveInteger(channel) && selectedPowersChannels.includes(channel)) {
            updateToolArgument(selectedToolAction.id, 'channel', channel)
          }
        }}>
        <option value="" disabled>{channelBound ? t("app.boundChannelPreserved") : t("app.selectAChannel")}</option>
        {!channelBound && savedChannel !== undefined && !savedChannelSupported && (
          <option value={String(savedChannel)} disabled>
            {t("app.cH")}{String(savedChannel)} ({selectedPowersCapabilities?.status === 'ready' ? t("app.notSupported") : t("app.unconfirmed")})
          </option>
        )}
        {selectedPowersChannels.map(channel => <option key={channel} value={channel}>{t("app.cH")}{channel}</option>)}
      </select>
    </label>
    {powersChannelHint && <p className="value-source-help">{powersChannelHint}</p>}
    {channelBound
      ? <p className="value-source-help">{t("app.channelBindingPreservedSelectAFixedChannelToReplace")}</p>
      : savedChannel !== undefined && !savedChannelSupported && <p className="value-source-help">
          {t("app.savedChannel")}{String(savedChannel)} {t("app.preserved")}{selectedPowersCapabilities?.status === 'ready'
            ? t("app.notSupportedByTheCurrentModel") : t("app.supportCannotBeConfirmed")}
        </p>}
  </>

  return (
    <>
      {selectedToolAction && selectedPowersAction && (
        powersChannelSelector
      )}

      {selectedToolAction && selectedAction === 'powers/protection-status' && (
        <>
          <label className="step-property-field">
            <span className="step-property-label">{t("app.channelSelection")}</span>
            <select
              value={!channelBound && savedChannel === 'all' ? 'all' : 'specific'}
              disabled={workflowBusy}
              onChange={event => {
                if (event.target.value === 'all') updateToolArgument(selectedToolAction.id, 'channel', 'all')
                else if (selectedPowersChannels.length > 0) {
                  updateToolArgument(selectedToolAction.id, 'channel', selectedPowersChannels[0])
                }
              }}
            >
              <option value="all">{t("app.all")}</option>
              <option value="specific" disabled={selectedPowersChannels.length === 0}>{t("app.specificChannel")}</option>
            </select>
          </label>
          {channelBound || savedChannel !== 'all' ? powersChannelSelector : powersChannelHint && (
            <p className="value-source-help">{t("app.specificChannelIsUnavailable")}{powersChannelHint}</p>
          )}
        </>
      )}

      {selectedToolAction && selectedAction === 'powers/set-output' &&
        (['voltage', 'current'] as const).map((name) => {
            const active = hasPowerSetpoint(selectedToolAction, name)
            const label = name === 'voltage' ? t("app.voltage") : t("app.currentLimit")
            return <div className="step-properties-fields" key={`${selectedToolAction.id}-${name}`}>
              {selectedAction === 'powers/set-output' && (
                <label className="step-property-field step-property-checkbox">
                  <input type="checkbox" checked={active}
                    disabled={workflowBusy || (active && !hasPowerSetpoint(selectedToolAction, name === 'voltage' ? 'current' : 'voltage'))}
                    onChange={(event) => updateStep(selectedToolAction.id, step =>
                      step.type === 'tool-action'
                        ? togglePowerSetpoint(step, name, event.target.checked)
                        : step)} />
                  <span className="step-property-label">{t("app.set")}{label}</span>
                </label>
              )}
              {selectedAction === 'powers/set-output' && <p className="value-source-help">
                {name === 'voltage'
                  ? t("app.setTheChannelSOutputVoltageUncheckToLeave")
                  : t("app.setTheMaximumAllowedOutputCurrentNotAForced")}
              </p>}
              {active && (
                <InputValueEditor
                  value={selectedToolAction.bindings?.[name] ?? { source: 'literal', value: numericArgument(selectedToolAction, name) }}
                  sourceLabel={t("inputValueEditor.namedSource", { label })}
                  literalLabel={`${label} (${name === 'voltage' ? 'V' : 'A'})`}
                  literalDefault={powerSetpointLiteralDefault(selectedToolAction, name)}
                  numericSetpoint
                  earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []}
                  instances={workflowDraft.tool_instances}
                  stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                  earlierVariables={earlierVariables}
                  disabled={workflowBusy}
                  onChange={(value) => updateSetpointValue(selectedToolAction.id, name, value)}
                />
              )}
            </div>
          })}
    </>
  )
}
