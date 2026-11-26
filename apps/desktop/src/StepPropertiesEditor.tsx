import type { Dispatch, SetStateAction } from 'react'
import { useI18n } from './i18n/I18nProvider'
import type { Translate } from './i18n/index.ts'
import InputValueEditor, { ExpressionOperandEditor } from './InputValueEditor'
import { InteractionEditor, type InteractionCommandDrafts } from './InteractionEditor'
import ProcessEditor from './ProcessEditor'
import ShowMessageEditor from './ShowMessageEditor'
import ScopesActionEditor from './ScopesActionEditor'
import SerialActionEditor from './SerialActionEditor'
import PowersActionEditor, { type PowersChannelCapabilities } from './PowersActionEditor'
import { COMPARISON_OPERATORS, curatedResultFields, type ComparisonOperator, type InputValueWire } from './inputValue'
import { hasPowerSetpoint, type PowerSetpoint } from './powerSetpoint'
import { changeOutputValue } from './outputTime'
import { targetLabel, type ResourceIdentity } from './resourceFormatting'
import { propertiesTitle, stepHelpKey, stepLabel as getStepLabel, type StepPresetOption } from './stepPresets'
import { allWorkflowSteps, compatibleOutputPages, enclosingForVariables, enclosingLoop, inputScope, loopPath, showMessageOutputCandidates, type outputDefinitions, type outputPages } from './workflow'
import type { StepBranch, WorkflowStep } from './workflow'
import type { WorkflowDraft } from './templateDraft'
import type { ToolInstance } from './toolSetup/types'
import type { ExecutionMode } from './executionMode'

type Props = {
  workflowDraft: WorkflowDraft
  workflowBusy: boolean
  selectedStepId: string | null
  selectedStepIds: string[]
  validationIssue: { step_id: string | null; message: string } | null
  editingStepId: string | null
  stepIdDraft: string
  stepIdEditError: string | null
  setEditingStepId: Dispatch<SetStateAction<string | null>>
  setStepIdDraft: Dispatch<SetStateAction<string>>
  setStepIdEditError: Dispatch<SetStateAction<string | null>>
  saveEditedStepId: (oldId: string) => void
  updateStep: (stepId: string, update: (step: WorkflowStep) => WorkflowStep) => void
  updateToolArgument: (stepId: string, name: string, value: number | 'all') => void
  updateSetpointValue: (stepId: string, name: PowerSetpoint, value: InputValueWire) => void
  preferredIfBranch: { id: string; branch: StepBranch }
  setPreferredIfBranch: Dispatch<SetStateAction<{ id: string; branch: StepBranch }>>
  templateUiGeneration: number
  interactionCommandDrafts: Record<string, InteractionCommandDrafts>
  setInteractionCommandDrafts: Dispatch<SetStateAction<Record<string, InteractionCommandDrafts>>>
  resourceIdentityDrafts: Record<string, ResourceIdentity | null>
  executionMode: ExecutionMode
  scopesExecutableKey: string
  powersCapabilityChannels: { key: string; models: Record<string, PowersChannelCapabilities> } | null
  powersCapabilityKey: string
  outputSteps: ReturnType<typeof outputDefinitions>
  pages: ReturnType<typeof outputPages>
  stepPresets: readonly StepPresetOption[]
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export default function StepPropertiesEditor({
  workflowDraft, workflowBusy, selectedStepId, selectedStepIds, validationIssue, editingStepId,
  stepIdDraft, stepIdEditError, setEditingStepId, setStepIdDraft, setStepIdEditError, saveEditedStepId,
  updateStep, updateToolArgument, updateSetpointValue, preferredIfBranch, setPreferredIfBranch,
  templateUiGeneration, interactionCommandDrafts, setInteractionCommandDrafts, resourceIdentityDrafts,
  executionMode, scopesExecutableKey, powersCapabilityChannels, powersCapabilityKey, outputSteps, pages, stepPresets,
}: Props) {
  const { locale, t } = useI18n()
  function stepLabel(step: WorkflowStep, instances: ToolInstance[], translate: Translate = t): string {
    return getStepLabel(step, instances, translate)
  }
  const selectedStep = allWorkflowSteps(workflowDraft?.workflow.steps ?? []).find(
    (step) => step.id === selectedStepId,
  )
  const outputNameError = selectedStep?.type === 'output'
    ? selectedStep.name.trim().length === 0
      ? t("app.outputNameMustNotBeBlank")
      : outputSteps.some((step) => step !== selectedStep && step.name === selectedStep.name)
        ? t("app.outputNameMustBeUnique")
        : null
    : null
  const { earlierSteps, earlierVariables } = inputScope(workflowDraft?.workflow.steps ?? [], selectedStepId)
  const selectedParent = enclosingLoop(workflowDraft?.workflow.steps ?? [], selectedStepId)
  const selectedEnclosingForVariables = enclosingForVariables(workflowDraft?.workflow.steps ?? [], selectedStepId)
  const selectedValue = selectedStep?.type === 'output' || selectedStep?.type === 'set-variable'
    ? selectedStep.value : null
  const selectedCompatiblePages = selectedStep?.type === 'output'
    ? compatibleOutputPages(workflowDraft?.workflow.steps ?? [], selectedStep.id) : []
  const selectedToolAction = selectedStep?.type === 'tool-action' ? selectedStep : null
  const selectedAction = selectedToolAction
    ? `${workflowDraft?.tool_instances.find(instance => instance.id === selectedToolAction.target)?.tool}/${selectedToolAction.action}`
    : null
  const selectedPowersAction =
    selectedAction === 'powers/set-output' ||
    selectedAction === 'powers/measure' ||
    selectedAction === 'powers/output-on' ||
    selectedAction === 'powers/output-off'
  const selectedPowersModel = executionMode === 'simulate' ? 'simulator'
    : selectedToolAction ? resourceIdentityDrafts[selectedToolAction.target]?.model_id : undefined
  const selectedPowersCapabilities = powersCapabilityChannels?.key === powersCapabilityKey && selectedPowersModel
    ? powersCapabilityChannels.models[selectedPowersModel] : undefined

  return (
    <section className="step-properties" aria-labelledby="step-properties-title">
      <h3 id="step-properties-title">{t("app.properties")}</h3>
      {validationIssue?.step_id && selectedStepIds.includes(validationIssue.step_id) && (
        <p className="error" role="alert">{validationIssue.message}</p>
      )}

      {selectedStepIds.length > 1 && (
        <p className="step-properties-empty">{selectedStepIds.length} {t("app.stepsSelectedSelectASingleStepToEditIts")}</p>
      )}

      {selectedStepIds.length <= 1 && !selectedStep && (
        <p className="step-properties-empty">{t("app.selectAStepToEditItsProperties")}</p>
      )}

      {selectedStepIds.length === 1 && selectedStep && (
        <div className="step-properties-fields">
          <div>
            <h4 className="step-properties-step-title">{propertiesTitle(selectedStep, workflowDraft.tool_instances, locale, t, stepPresets)}</h4>
            {stepHelpKey(selectedStep, workflowDraft.tool_instances, stepPresets) && (
              <p className="step-context-help">{t(`steps.hint.${stepHelpKey(selectedStep, workflowDraft.tool_instances, stepPresets)}`)}</p>
            )}
          </div>
          <div className="step-property-readonly">
            <span className="step-property-label">{t("app.stepID")}</span>
            {editingStepId === selectedStep.id ? <>
              <div className="step-id-editor">
                <input type="text" autoFocus aria-label={t("app.stepID")} value={stepIdDraft}
                  disabled={workflowBusy} onChange={event => {
                    setStepIdDraft(event.target.value)
                    setStepIdEditError(null)
                  }} onKeyDown={event => {
                    if (event.key === 'Enter') { event.preventDefault(); saveEditedStepId(selectedStep.id) }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditingStepId(null)
                      setStepIdEditError(null)
                    }
                  }} />
                <button type="button" className="step-id-icon-button"
                  aria-label={t("app.saveStepID")} title={t("app.saveStepID")} disabled={workflowBusy}
                  onClick={() => saveEditedStepId(selectedStep.id)}>✓</button>
                <button type="button" className="step-id-icon-button"
                  aria-label={t("app.cancelStepID")} title={t("app.cancelStepID")}
                  onClick={() => { setEditingStepId(null); setStepIdEditError(null) }}>×</button>
              </div>
              {stepIdEditError && <p className="step-property-error" role="alert">{stepIdEditError}</p>}
            </> : <div className="step-id-display">
              <code className="workflow-step-id">{selectedStep.id}</code>
              <button type="button" className="step-id-icon-button"
                disabled={workflowBusy} aria-label={t("app.editStepID")} title={t("app.editStepID")}
                onClick={() => {
                  setStepIdDraft(selectedStep.id)
                  setStepIdEditError(null)
                  setEditingStepId(selectedStep.id)
                }}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                  strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 20h4l11-11-4-4L4 16v4Z" /><path d="m13 7 4 4" />
                </svg>
              </button>
            </div>}
          </div>

          {selectedToolAction && <label className="step-property-field">
            <span className="step-property-label">{t("app.targetInstance")}</span>
            <select disabled={workflowBusy} value={selectedToolAction.target} onChange={event => {
              const target = event.target.value
              updateStep(selectedToolAction.id, step => step.type === 'tool-action' ? { ...step, target } : step)
            }}>
              {workflowDraft.tool_instances.filter(instance => instance.tool === workflowDraft.tool_instances.find(item => item.id === selectedToolAction.target)?.tool)
                .map(instance => <option key={instance.id} value={instance.id}>{targetLabel(instance, resourceIdentityDrafts[instance.id])}</option>)}
            </select>
          </label>}
          {selectedStep.type === 'bg-interaction' && <InteractionEditor step={selectedStep}
            key={`${templateUiGeneration}:${selectedStep.id}`}
            instances={workflowDraft.tool_instances}
            savedCommands={interactionCommandDrafts[selectedStep.id] ?? {}}
            onSaveCommand={operation => setInteractionCommandDrafts(current => ({ ...current,
              [selectedStep.id]: { ...current[selectedStep.id], [operation.command]: operation },
            }))}
            steps={workflowDraft.workflow.steps} backgrounds={workflowDraft.backgrounds ?? []} disabled={workflowBusy}
            onChange={next => updateStep(selectedStep.id, () => next)} />}
          {selectedStep.type === 'background' && <>
            <label className="step-property-field"><span className="step-property-label">{t("app.background")}</span><select value={selectedStep.background_id} disabled={workflowBusy} onChange={event => updateStep(selectedStep.id, step => step.type === 'background' ? { ...step, background_id: event.target.value } : step)}>
              {workflowDraft.backgrounds?.map(background => <option key={background.id} value={background.id}>{background.id} · {background.tool_instance_id}</option>)}
            </select></label>
            {(selectedStep.action === 'worker-on' || selectedStep.action === 'worker-off') && <label className="step-property-field step-property-checkbox"><input type="checkbox" checked={selectedStep.capture} disabled={workflowBusy}
              onChange={event => updateStep(selectedStep.id, step => step.type === 'background' ? { ...step, capture: event.target.checked } : step)} />
              <span className="step-property-label">{t("app.simultaneousCapture")}{selectedStep.action === 'worker-on' ? t("app.oN") : t("app.oFF")}</span></label>}
            {selectedStep.action === 'worker-on' && <p className="value-source-help">{t('app.workflowHelp.captureOn')}</p>}
            {selectedStep.action === 'worker-off' && <p className="value-source-help">{t("app.ifCaptureWasAlreadyExplicitlySwitchedOFFUncheckSimultaneous")}</p>}
          </>}
          {selectedStep.type === 'for' && <>
            <label className="step-property-field">
              <span className="step-property-label">{t("app.loopVariable")}</span>
              <input type="text" required pattern="[a-z0-9]+(-[a-z0-9]+)*"
                title={t("app.useLowercaseLettersDigitsAndSingleHyphensBetweenSegments")}
                value={selectedStep.variable} disabled={workflowBusy} onChange={event => {
                  const variable = event.target.value
                  updateStep(selectedStep.id, step => step.type === 'for' ? { ...step, variable } : step)
                }} />
            </label>
            <p className="value-source-help">{t('app.workflowHelp.loopVariable')}</p>
            {(['start', 'stop', 'step'] as const).map(field => <div key={field} className="workflow-help-group"><label className="step-property-field">
              <span className="step-property-label">{field === 'start' ? t("app.start") : field === 'stop' ? t("app.stop") : t("app.step")}</span>
              <input type="text" required value={selectedStep.range[field]} disabled={workflowBusy}
                onChange={event => {
                  const value = event.target.value
                  updateStep(selectedStep.id, step => step.type === 'for'
                    ? { ...step, range: { ...step.range, [field]: value } } : step)
                }} />
            </label><p className="value-source-help">{t(`app.workflowHelp.for.${field}`)}</p></div>)}
            {(!selectedStep.variable.trim() || Object.values(selectedStep.range).some(value => !value.trim())) &&
              <p className="error">{t("app.loopVariableAndRangeFieldsMustNotBeBlank")}</p>}
          </>}
          {selectedStep.type === 'set-variable' && selectedEnclosingForVariables.includes(selectedStep.variable) &&
            <p className="error">{t("app.aBodySetVariableCannotWriteAnEnclosingFor")}</p>}
          {selectedStep.type === 'set-variable' && (
            <>
              <label className="step-property-field">
                <span className="step-property-label">{t("app.variable")}</span>
                <input
                  type="text"
                  value={selectedStep.variable}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  title={t("app.useLowercaseLettersDigitsAndSingleHyphensBetweenSegments")}
                  disabled={workflowBusy}
                  onChange={(event) => {
                    const variable = event.target.value
                    updateStep(selectedStep.id, (step) =>
                      step.type === 'set-variable' ? { ...step, variable } : step,
                    )
                  }}
                />
              </label>
            </>
          )}

          {selectedStep.type === 'output' && (
            <>
              <label className="step-property-field">
                <span className="step-property-label">{t("app.outputName")}</span>
                <input
                  type="text"
                  value={selectedStep.name}
                  disabled={workflowBusy}
                  aria-invalid={outputNameError !== null}
                  aria-describedby={outputNameError
                    ? 'output-name-help output-name-error' : 'output-name-help'}
                  onChange={(event) => updateStep(selectedStep.id, (step) =>
                    step.type === 'output' ? { ...step, name: event.target.value } : step,
                  )}
                />
              </label>
              <p id="output-name-help" className="value-source-help">{t("app.editableColumnNameUsedInOutputDataCSVXLSX")}</p>
              {outputNameError && <p id="output-name-error" className="step-property-error">{outputNameError}</p>}
              <label className="step-property-field">
                <span className="step-property-label">{t("app.existingCompatiblePage")}</span>
                <select value={selectedCompatiblePages.includes(selectedStep.page) ? selectedStep.page : ''}
                  disabled={workflowBusy}
                  onChange={event => {
                    if (event.target.value) updateStep(selectedStep.id, step =>
                      step.type === 'output' ? { ...step, page: event.target.value } : step)
                  }}>
                  <option value="">{t("app.selectExistingPage")}</option>
                  {selectedCompatiblePages.map(page => <option key={page} value={page}>{page}</option>)}
                </select>
              </label>
              <label className="step-property-field">
                <span className="step-property-label">{t("app.pageName")}</span>
                <input value={selectedStep.page} disabled={workflowBusy} aria-describedby="output-page-help"
                  onChange={event => updateStep(selectedStep.id, step => step.type === 'output' ? { ...step, page: event.target.value } : step)} />
              </label>
              <p id="output-page-help" className="value-source-help">
                {t("app.aPageIsAnIndependentTabularDatasetOnlyPages")}</p>
              {pages.some(page => page.name === selectedStep.page && JSON.stringify(page.scope) !== JSON.stringify(loopPath(workflowDraft.workflow.steps, selectedStep.id).map(loop => loop.id))) &&
                <p className="error">{t("app.thisPageBelongsToADifferentLoopPathChoose")}</p>}
            </>
          )}

          {selectedValue && (
            <InputValueEditor
              key={selectedStep.id}
              value={selectedValue}
               allowStringLiteral={selectedStep.type === 'set-variable'}
              allowBooleanLiteral={selectedStep.type === 'set-variable'}
              allowNullLiteral={selectedStep.type === 'set-variable'}
              timeFormat={selectedStep.type === 'output' ? selectedStep.time_format : undefined}
              onTimeFormatChange={selectedStep.type === 'output' ? format => updateStep(selectedStep.id, step =>
                step.type === 'output' ? { ...step, time_format: format } : step) : undefined}
              earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []}
              instances={workflowDraft.tool_instances}
              stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
              earlierVariables={earlierVariables}
              disabled={workflowBusy}
              onChange={(value) => updateStep(selectedStep.id, (step) =>
                step.type === 'output' ? changeOutputValue(step, value) : step.type === 'set-variable'
                  ? { ...step, value } : step)}
            />
          )}

          {(selectedStep.type === 'assert' || selectedStep.type === 'while' || selectedStep.type === 'if') && (
            <div key={selectedStep.id} className="step-properties-fields">
              <ExpressionOperandEditor
                allowBooleanLiteral
                allowStringLiteral
                allowNullLiteral
                side="Left" value={selectedStep.left}
                earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []} earlierVariables={earlierVariables}
                instances={workflowDraft.tool_instances}
                stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                disabled={workflowBusy}
                onChange={left => updateStep(selectedStep.id, step =>
                  (step.type === 'assert' || step.type === 'while' || step.type === 'if') ? { ...step, left } : step)}
              />
              <label className="step-property-field">
                <span className="step-property-label">{t("app.operator")}</span>
                <select value={selectedStep.operator} disabled={workflowBusy}
                  onChange={event => updateStep(selectedStep.id, step =>
                    (step.type === 'assert' || step.type === 'while' || step.type === 'if') ? { ...step, operator: event.target.value as ComparisonOperator } : step)}>
                  {Object.entries(COMPARISON_OPERATORS).map(([operator, symbol]) => (
                    <option key={operator} value={operator}>{symbol}</option>
                  ))}
                </select>
              </label>
              <ExpressionOperandEditor
                allowBooleanLiteral
                allowStringLiteral
                allowNullLiteral
                side="Right" value={selectedStep.right}
                earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []} earlierVariables={earlierVariables}
                instances={workflowDraft.tool_instances}
                stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                disabled={workflowBusy}
                onChange={right => updateStep(selectedStep.id, step =>
                  (step.type === 'assert' || step.type === 'while' || step.type === 'if') ? { ...step, right } : step)}
              />
              {selectedStep.type === 'assert' && <label className="step-property-field">
                <span className="step-property-label">{t("app.failureMessage")}</span>
                <input type="text" value={selectedStep.message} placeholder={t("app.assertionFailed")}
                  disabled={workflowBusy}
                  onChange={event => updateStep(selectedStep.id, step =>
                    step.type === 'assert' ? { ...step, message: event.target.value } : step)} />
              </label>}
              {selectedStep.type === 'assert' && <p className="value-source-help">{t('app.workflowHelp.assertMessage')}</p>}
              {selectedStep.type === 'while' && <div className="step-property-field">
                <span className="step-property-label">{t("app.iterationLimit")}</span>
                <select aria-label={t("app.iterationLimit")} value={selectedStep.max_iterations === null ? 'unlimited' : 'limited'} disabled={workflowBusy}
                  onChange={event => updateStep(selectedStep.id, step =>
                    step.type === 'while' ? { ...step, max_iterations: event.target.value === 'unlimited' ? null : 1000 } : step)}>
                  <option value="limited">{t("app.maxIterations")}</option>
                  <option value="unlimited" disabled={Boolean(selectedParent)}>{t("app.unlimited")}</option>
                </select>
                <p className="value-source-help">{t('app.workflowHelp.iterationLimit')}</p>
                {selectedStep.max_iterations === null ? (
                  <p className="value-source-help">{t("app.runsUntilTheConditionBecomesFalseOrTheLoop")} {t('app.workflowHelp.unlimitedScope')}</p>
                ) : <>
                  <input type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1"
                    aria-label={t("app.maxIterations")} value={selectedStep.max_iterations} disabled={workflowBusy}
                    onChange={event => {
                      const limit = event.currentTarget.valueAsNumber
                      if (!Number.isSafeInteger(limit) || limit <= 0) return
                      updateStep(selectedStep.id, step =>
                        step.type === 'while' ? { ...step, max_iterations: limit } : step)
                    }} />
                  {(!Number.isSafeInteger(selectedStep.max_iterations) || selectedStep.max_iterations <= 0) &&
                    <span className="error">{t("app.maxIterationsMustBeAPositiveSafeInteger")}</span>}
                </>}
                {selectedParent && <p className="value-source-help">{t('app.workflowHelp.unlimitedNested')}</p>}
              </div>}
            </div>
          )}

          {selectedStep.type === 'if' && <label className="step-property-field">
            <span className="step-property-label">{t("app.addNewStepsTo")}</span>
            <select aria-label={t("app.ifBranchForNewSteps")} disabled={workflowBusy}
              value={preferredIfBranch.id === selectedStep.id ? preferredIfBranch.branch : 'then'}
              onChange={event => setPreferredIfBranch({
                id: selectedStep.id, branch: event.target.value as StepBranch,
              })}>
              <option value="then">{t("app.tHEN")}</option>
              <option value="else">{t("app.eLSE")}</option>
            </select>
          </label>}
          {selectedStep.type === 'if' && <p className="value-source-help">{t('app.workflowHelp.ifBranch')}</p>}
          {selectedStep.type === 'wait' && (
            <label className="step-property-field">
              <span className="step-property-label">{t("app.durationMs")}</span>
              <input
                type="number"
                min="0"
                step="1"
                value={selectedStep.duration_ms}
                disabled={workflowBusy}
                onChange={(event) => {
                  const durationMs = event.currentTarget.valueAsNumber
                  if (!isNonNegativeInteger(durationMs)) {
                    return
                  }

                  updateStep(selectedStep.id, (step) =>
                    step.type === 'wait'
                      ? { ...step, duration_ms: durationMs }
                      : step,
                  )
                }}
              />
            </label>
          )}

          {selectedStep.type === 'wait' && <p className="value-source-help">{t('app.workflowHelp.wait')}</p>}
          {(selectedStep.type === 'string-process' || selectedStep.type === 'byte-process' || selectedStep.type === 'array-process') && (
            <ProcessEditor key={selectedStep.id} step={selectedStep}
              earlierSteps={earlierSteps} earlierVariables={earlierVariables}
              instances={workflowDraft.tool_instances} backgrounds={workflowDraft.backgrounds ?? []}
              stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
              disabled={workflowBusy}
              onChange={update => updateStep(selectedStep.id, step => step.type === 'string-process' || step.type === 'byte-process' || step.type === 'array-process' ? update(step) : step)}
            />
          )}

          {selectedStep.type === 'show-message' && (
            <ShowMessageEditor
              key={selectedStep.id}
              step={selectedStep}
              outputs={showMessageOutputCandidates(earlierSteps)}
              disabled={workflowBusy}
              onChange={(next) => updateStep(selectedStep.id, (step) =>
                step.type === 'show-message' ? next : step)}
            />
          )}

          {selectedToolAction && selectedAction?.startsWith('serial/') && (
            <SerialActionEditor showStepHelp={false} step={selectedToolAction} instances={workflowDraft.tool_instances}
              earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []} earlierVariables={earlierVariables} disabled={workflowBusy}
              stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
              onChange={serialStep => updateStep(selectedToolAction.id, () => serialStep)} />
          )}
          {selectedToolAction && selectedAction?.startsWith('scopes/') && (
            <ScopesActionEditor step={selectedToolAction} instances={workflowDraft.tool_instances}
              executionMode={executionMode} scopesExecutableKey={scopesExecutableKey}
              modelId={executionMode === 'live' ? resourceIdentityDrafts[selectedToolAction.target]?.model_id : undefined}
              earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []} earlierVariables={earlierVariables} disabled={workflowBusy}
              stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
              onChange={next => updateStep(selectedToolAction.id, () => next)} />
          )}
          {selectedToolAction && <PowersActionEditor
            selectedToolAction={selectedToolAction} selectedAction={selectedAction}
            selectedPowersAction={selectedPowersAction} selectedPowersModel={selectedPowersModel}
            selectedPowersCapabilities={selectedPowersCapabilities}
            workflowDraft={workflowDraft} workflowBusy={workflowBusy}
            earlierSteps={earlierSteps} earlierVariables={earlierVariables}
            stepLabel={stepLabel} updateStep={updateStep}
            updateToolArgument={updateToolArgument} updateSetpointValue={updateSetpointValue}
          />}

          {selectedAction === 'meters/measure' && (
            <p className="step-properties-empty">{t("app.noEditableParameters")}</p>
          )}
          {selectedAction === 'meters/measure' && (
            <p className="value-source-help">{t('app.workflowHelp.meterResult')}</p>
          )}
          {(() => {
            if (selectedStep.type !== 'tool-action' && (selectedStep.type !== 'bg-interaction' ||
              !['get-latest', 'wait-next', 'get-command-result'].includes(selectedStep.operation.kind))) return null
            const resultFields = curatedResultFields(selectedStep, workflowDraft.tool_instances, t, workflowDraft.backgrounds ?? [], earlierSteps)
            const fields = selectedStep.type === 'tool-action' && selectedAction === 'powers/set-output'
              ? resultFields.filter(field =>
                  (field.pointer !== '/request/arguments/voltage' || hasPowerSetpoint(selectedStep, 'voltage')) &&
                  (field.pointer !== '/request/arguments/current' || hasPowerSetpoint(selectedStep, 'current')))
              : resultFields
            if (!fields.length) return null
            const serialRead = selectedStep.type === 'tool-action' &&
              (selectedAction === 'serial/receive' || selectedAction === 'serial/query')
            // Keep the wire pointers for selection; display the same names as the Result dropdown.
            const serialTypes: Record<string, string> = {
              '/outcome': 'String', '/timed_out': 'Boolean',
              '/rx_hex': 'String', '/rx_bytes': 'Number', '/rx_text': 'String / Null',
              '/partial_rx_hex': 'String', '/partial_rx_bytes': 'Number', '/partial_rx_text': 'String / Null',
            }
            const serialType = (field: (typeof fields)[number]) => serialTypes[field.pointer]
            const renderFields = (items: typeof fields,
              describe: (field: (typeof fields)[number]) => string | undefined = field => field.hint) => items.map(field => {
              const detail = describe(field)
              return <div key={field.pointer} className="workflow-result-field">
                <strong>{field.label}</strong>
                {detail && <p className="value-source-help">{detail}</p>}
              </div>
            })
            return <div className="workflow-help-group" role="group" aria-label={t('app.workflowHelp.commonResults')}>
              <span className="step-property-label">{t('app.workflowHelp.commonResults')}</span>
              {serialRead ? <>
                {renderFields(fields.filter(field => ['/outcome', '/timed_out'].includes(field.pointer)), selectedStep.arguments.fail_on_read_timeout === true ? serialType : undefined)}
                <span className="step-property-label">{t('app.workflowHelp.serialCompletedResults')}</span>
                {renderFields(fields.filter(field => ['/rx_hex', '/rx_bytes', '/rx_text'].includes(field.pointer)), serialType)}
                {selectedStep.arguments.fail_on_read_timeout !== true && <>
                  <span className="step-property-label">{t('app.workflowHelp.serialTimeoutResults')}</span>
                  <p className="value-source-help">{t('app.workflowHelp.serialTimeoutResultHelp')}</p>
                  {renderFields(fields.filter(field => ['/partial_rx_hex', '/partial_rx_bytes', '/partial_rx_text'].includes(field.pointer)), serialType)}
                </>}
              </> : renderFields(fields.slice(0, 3))}
              <p className="value-source-help">{t('app.workflowHelp.resultReference')}</p>
            </div>
          })()}

          {selectedToolAction &&
            !selectedPowersAction &&
            selectedAction !== 'powers/protection-status' &&
            selectedAction !== 'meters/measure' &&
            !selectedAction?.startsWith('scopes/') &&
             !selectedAction?.startsWith('serial/') && (
              <p className="step-properties-empty">
                {t("app.noEditablePropertiesAreAvailableForThisStep")}</p>
            )}
        </div>
      )}
    </section>
  )
}
