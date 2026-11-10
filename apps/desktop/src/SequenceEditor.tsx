import { toolInstanceLabel } from './toolInstanceLabel'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { canMoveSteps, canRelocateSteps, stepContainer } from './stepEditing'
import type { ToolInstance } from './ToolSetupEditor'
import type { StepSummaryDto, WorkflowStep, WorkflowContainerStep, StepBranch } from './workflow'
import { allWorkflowSteps, containerPath, MESSAGE_TARGET_LABELS } from './workflow'
import { expressionSummary } from './inputValue'

export type SequenceDropTarget = { parentId: string | null; branch: StepBranch | null; index: number }
export type StepDensity = 'compact' | 'standard' | 'comfortable'

export type SequenceEditorHandle = {
  updatePaletteDrop: (x: number, y: number, isControl: boolean) => void
  finishPaletteDrop: (x: number, y: number, isControl: boolean) => SequenceDropTarget | null
  clearPaletteDrop: () => void
}

type SequenceEditorProps = {
  paletteDropRef?: RefObject<SequenceEditorHandle | null>
  instances: ToolInstance[]
  steps: readonly WorkflowStep[]
  runResults: readonly StepSummaryDto[] | null
  formatMeasurement: (output: unknown) => string | null
  selectedStepIds: readonly string[]
  onSelectStep: (stepId: string, modifiers?: { ctrlKey: boolean; shiftKey: boolean }) => void
  onReorderSteps: (ids: string[], parentId: string | null, index: number, branch?: StepBranch | null) => void
  validationIssue?: { step_id: string | null; message: string } | null
  stepLabel: (step: WorkflowStep) => string
  workflowBusy: boolean
  onMoveStep: (stepId: string, offset: -1 | 1) => void
  onDeleteStep: (stepId: string) => void
  onClearWorkflow: () => void
  density: StepDensity
  onDensityChange: (density: StepDensity) => void
  collapsedStepIds: ReadonlySet<string>
  collapsedBranches: ReadonlySet<string>
  onToggleContainer: (id: string) => void
  onToggleBranch: (id: string, branch: StepBranch) => void
  onSetAllExpanded: (expanded: boolean) => void
}

function valueSummary(value: Extract<WorkflowStep, { type: 'output' }>['value']): string {
  switch (value.source) {
    case 'elapsed-time':
      return 'Elapsed time'
    case 'timestamp':
      return 'Timestamp'
    case 'expression':
      return expressionSummary(value)
    case 'literal':
      return JSON.stringify(value.value) ?? 'No value'
    case 'variable':
      return `Variable ${value.variable}`
    case 'step-output':
      return `${value.step_id} → ${value.pointer || '(root)'}`
  }
}

function stepSummary(step: WorkflowStep, instances: ToolInstance[]): string {
  switch (step.type) {
    case 'background':
      return `${step.background_id}${step.capture ? ' · simultaneous Capture' : ''}`
    case 'for':
      return `Step ${step.range.step} · ${step.steps.length} body steps`
    case 'while':
    case 'assert':
    case 'if':
      return expressionSummary(step)
    case 'set-variable':
      return `${step.variable} = ${valueSummary(step.value)}`
    case 'output':
      return `${step.name} = ${valueSummary(step.value)}`
    case 'show-message':
      return `${MESSAGE_TARGET_LABELS[step.target]} · ${step.fields.length} field${step.fields.length === 1 ? '' : 's'}`
    case 'wait':
      return `${step.duration_ms} ms`
    case 'tool-action': {
      if (instances.find(instance => instance.id === step.target)?.tool === 'powers') {
        if (step.action === 'protection-status') {
          return step.arguments.channel === 'all' ? 'All channels' : `CH${step.arguments.channel ?? '?'}`
        }
        const channel = step.bindings?.channel
          ? 'Bound channel'
          : `CH${step.arguments.channel ?? '?'}`
        if (step.action === 'set-output') {
          const setpoints = (['voltage', 'current'] as const).flatMap(name => {
            const binding = step.bindings?.[name]
            if (!binding && !Object.hasOwn(step.arguments, name)) return []
            const label = name === 'voltage' ? '' : 'Current Limit '
            const boundLabel = name === 'voltage' ? 'Voltage' : 'Current Limit'
            if (!binding) return [`${label}${step.arguments[name]} ${name === 'voltage' ? 'V' : 'A'}`]
            if (binding.source === 'literal') return [`${label}${valueSummary(binding)} ${name === 'voltage' ? 'V' : 'A'}`]
            if (binding.source === 'variable') return [`${boundLabel} = ${binding.variable}`]
            if (binding.source === 'expression') return [`${boundLabel} = ${expressionSummary(binding)}`]
            return [`${boundLabel} = ${valueSummary(binding)}`]
          })
          return [channel, ...setpoints].join(' · ')
        }
        if (step.action === 'output-on' || step.action === 'output-off' || step.action === 'measure') {
          return channel
        }
      }
      const instance = instances.find(instance => instance.id === step.target)
      return instance ? toolInstanceLabel(instance) : step.target
    }
  }
}

function SequenceEditor({
  steps,
  instances,
  runResults,
  formatMeasurement,
  selectedStepIds,
  onSelectStep,
  onReorderSteps,
  validationIssue,
  stepLabel,
  workflowBusy,
  onMoveStep,
  onDeleteStep,
  onClearWorkflow,
  density,
  onDensityChange,
  collapsedStepIds,
  collapsedBranches,
  onToggleContainer,
  onToggleBranch,
  onSetAllExpanded,
  paletteDropRef,
}: SequenceEditorProps) {
  const editorRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{
    ids: string[]; id: string; pointerId: number; handle: HTMLButtonElement;
    startX: number; startY: number; x: number; y: number; started: boolean
  } | null>(null)
  const scrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const suppressClickRef = useRef(false)
  const palettePointRef = useRef<{ x: number; y: number; isControl: boolean } | null>(null)
  const dropRef = useRef<SequenceDropTarget | null>(null)
  const [drop, setDrop] = useState<SequenceDropTarget | null>(null)
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const [paletteDragControl, setPaletteDragControl] = useState<boolean | null>(null)
  const hasContainers = allWorkflowSteps(steps).some(
    step => step.type === 'for' || step.type === 'while' || step.type === 'if')

  function setDropTarget(next: SequenceDropTarget | null) {
    dropRef.current = next
    setDrop(current => current?.parentId === next?.parentId && current?.branch === next?.branch &&
      current?.index === next?.index ? current : next)
  }

  function stopScrollTimer() {
    if (scrollTimerRef.current !== null) clearInterval(scrollTimerRef.current)
    scrollTimerRef.current = null
  }

  function finishDrag() {
    const drag = dragRef.current
    dragRef.current = null
    stopScrollTimer()
    setDropTarget(null)
    setDraggingIds([])
    if (drag?.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
  }

  function clearPaletteDrop() {
    palettePointRef.current = null
    setPaletteDragControl(null)
    if (!dragRef.current) stopScrollTimer()
    setDropTarget(null)
  }

  useEffect(() => {
    if (workflowBusy) {
      finishDrag()
      clearPaletteDrop()
    }
  }, [workflowBusy])
  useEffect(() => () => {
    stopScrollTimer()
  }, [])

  function resolveDrop(x: number, y: number, movingIds?: readonly string[], paletteIsControl = false): SequenceDropTarget | null {
    const editor = editorRef.current
    if (!editor) return null
    const hit = document.elementFromPoint(x, y)
    const target = hit?.closest<HTMLElement>('[data-step-end-target], [data-step-drop-id], [data-step-container]')
    let next: SequenceDropTarget | null = null
    if (target && editor.contains(target)) {
      const id = target.dataset.stepDropId
      const container = id ? stepContainer(steps, id) : undefined
      if (id && container && !movingIds?.includes(id)) {
        const rect = target.getBoundingClientRect()
        next = { parentId: container.parentId, branch: container.branch,
          index: container.siblings.findIndex(step => step.id === id) + (y >= rect.top + rect.height / 2 ? 1 : 0) }
      } else if (!id) {
        const parentId = target.dataset.stepContainer || null
        const branch = target.dataset.stepBranch === 'then' || target.dataset.stepBranch === 'else'
          ? target.dataset.stepBranch : null
        // Palette drops in the gap between sibling cards use the nearest insertion boundary.
        // Keep the existing Sequence reorder behavior unchanged.
        if (target.hasAttribute('data-step-end-target')) {
          // The visible end zone identifies a specific container, even at a deeply nested boundary.
          next = { parentId, branch, index: Number(target.dataset.stepCount) }
        } else {
          const rows = movingIds ? [] : Array.from(target.children).filter((child): child is HTMLElement =>
            child instanceof HTMLElement && child.classList.contains('sequence-step-row'))
          const before = rows.findIndex(row => {
            const main = row.querySelector<HTMLElement>('.sequence-step-main') ?? row
            const rect = main.getBoundingClientRect()
            return y < rect.top + rect.height / 2
          })
          next = { parentId, branch, index: movingIds ? Number(target.dataset.stepCount)
            : before < 0 ? rows.length : before }
        }
      }
    } else if (steps.length === 0 && hit?.closest('.sequence-empty') && editor.contains(hit)) {
      next = { parentId: null, branch: null, index: 0 }
    }
    if (next && movingIds && !canRelocateSteps(steps, movingIds, next.parentId, next.branch)) return null
    if (next && paletteIsControl && next.parentId &&
        containerPath(steps, next.parentId).length + 1 >= 8) return null
    return next
  }

  function updateDrop() {
    const drag = dragRef.current
    if (drag?.started) setDropTarget(resolveDrop(drag.x, drag.y, drag.ids))
  }

  function startScrollTimer() {
    if (scrollTimerRef.current !== null) return
    scrollTimerRef.current = setInterval(() => {
      const editor = editorRef.current
      const point = dragRef.current?.started ? dragRef.current : palettePointRef.current
      if (!editor || !point) return
      const rect = editor.getBoundingClientRect()
      const top = Math.max(rect.top, 0)
      const bottom = Math.min(rect.bottom, window.innerHeight)
      if (point.x >= rect.left && point.x <= rect.right && point.y >= top && point.y <= bottom) {
        const direction = point.y < top + 40 ? -1 : point.y > bottom - 40 ? 1 : 0
        if (direction) editor.scrollTop += direction * 12
      }
      if (dragRef.current?.started) updateDrop()
      else if (palettePointRef.current) setDropTarget(resolveDrop(point.x, point.y, undefined, palettePointRef.current.isControl))
    }, 50)
  }

  useEffect(() => {
    if (!paletteDropRef) return
    const api: SequenceEditorHandle = {
      updatePaletteDrop(x, y, isControl) {
        if (workflowBusy || dragRef.current) return
        palettePointRef.current = { x, y, isControl }
        setPaletteDragControl(isControl)
        startScrollTimer()
        setDropTarget(resolveDrop(x, y, undefined, isControl))
      },
      finishPaletteDrop(x, y, isControl) {
        const next = workflowBusy || dragRef.current ? null : resolveDrop(x, y, undefined, isControl)
        clearPaletteDrop()
        return next
      },
      clearPaletteDrop,
    }
    paletteDropRef.current = api
    return () => {
      if (paletteDropRef.current === api) paletteDropRef.current = null
    }
  })

  function pointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId || workflowBusy) return
    drag.x = event.clientX
    drag.y = event.clientY
    if (!drag.started && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5) {
      drag.started = true
      suppressClickRef.current = true
      if (!selectedStepIds.includes(drag.id)) onSelectStep(drag.id)
      setDraggingIds(drag.ids)
      startScrollTimer()
    }
    updateDrop()
  }

  function renderSteps(siblings: readonly WorkflowStep[], parent?: WorkflowContainerStep, parentOrder?: string,
    branch: StepBranch | null = null): React.ReactNode {
    const isTargetContainer = drop?.parentId === (parent?.id ?? null) && drop.branch === branch
    const dragging = paletteDragControl !== null || draggingIds.length > 0
    const locationLabel = parent
      ? `${parent.type.toUpperCase()} ${parentOrder ?? parent.id} (${parent.id}) · ${branch ? branch.toUpperCase() : 'Body'}`
      : 'Root Workflow'
    const showEndZone = dragging && (paletteDragControl !== null
      ? !paletteDragControl || !parent || containerPath(steps, parent.id).length + 1 < 8
      : canRelocateSteps(steps, draggingIds, parent?.id ?? null, branch))
    return (
      <ol className={`sequence-steps${isTargetContainer ? ' sequence-drop-container-active' : ''}${isTargetContainer && drop?.index === siblings.length ? ' sequence-drop-end' : ''}`}
        data-step-container={parent?.id ?? ''} data-step-branch={branch ?? ''}
        data-step-count={siblings.length} aria-label={parent ? `${branch ? branch.toUpperCase() : 'Body'} of ${parent.id}` : 'Root steps'}>
        {siblings.length === 0 && parent && <li className="sequence-body-empty">No steps. Drop steps here or select this container and add from the palette.</li>}
        {siblings.map((step, index) => {
          const result = runResults?.find(result => result.step_id === step.id)
          const order = parentOrder ? `${parentOrder}.${index + 1}` : `${index + 1}`
          const children = step.type === 'if'
            ? [...allWorkflowSteps(step.then_steps), ...allWorkflowSteps(step.else_steps)]
            : step.type === 'for' || step.type === 'while' ? allWorkflowSteps(step.steps) : []
          const isContainer = step.type === 'for' || step.type === 'while' || step.type === 'if'
          const collapsed = collapsedStepIds.has(step.id)
          const hiddenSelected = collapsed && children.some(child => selectedStepIds.includes(child.id))
          const hiddenInvalid = collapsed && children.some(child => child.id === validationIssue?.step_id)
          const hiddenFailed = collapsed && children.some(child => runResults?.some(result =>
            result.step_id === child.id && (result.any_failed || result.status === 'failed')))
          const countLabel = step.type === 'if'
            ? `THEN ${allWorkflowSteps(step.then_steps).length} · ELSE ${allWorkflowSteps(step.else_steps).length}`
            : isContainer ? `${children.length} nested Steps` : null
          let outputSummary: string | null = null
          if (!parent && result?.status === 'succeeded') {
            outputSummary = formatMeasurement(result.output)
            if (outputSummary !== null && result.output_omitted) outputSummary += ' …'
            if (step.type === 'output' && (
              result.output === null ||
              typeof result.output === 'number' ||
              typeof result.output === 'string' ||
              typeof result.output === 'boolean'
            )) {
              outputSummary = result.output_omitted && result.output === null
                ? 'Preview omitted'
                : `${JSON.stringify(result.output)}${result.output_omitted ? ' …' : ''}`
            } else if (result.output_omitted && outputSummary === null) {
              outputSummary = 'Preview omitted'
            }
          }

          return (
            <li key={step.id} className="sequence-step-row">
              <div className={`sequence-step-main${drop?.parentId === (parent?.id ?? null) && drop.branch === branch && drop.index === index ? ' sequence-drop-before' : ''}${draggingIds.includes(step.id) ? ' sequence-dragging' : ''}`}
                data-step-drop-id={step.id}>
                {isTargetContainer && drop?.index === index && (
                  <span className="sequence-drop-caption" role="status">
                    ▸ {locationLabel} · {index === 0 ? 'Start' : `Before ${stepLabel(step)} (${step.id})`}
                  </span>
                )}
                <button className="sequence-drag-handle" type="button" disabled={workflowBusy}
                  aria-label={`Drag ${step.id} to reorder`} title="Drag to reorder Steps or move them between workflow levels"
                  onPointerDown={event => {
                    if (workflowBusy || event.button !== 0 || dragRef.current || palettePointRef.current) return
                    suppressClickRef.current = false
                    event.currentTarget.setPointerCapture(event.pointerId)
                    dragRef.current = {
                      ids: selectedStepIds.includes(step.id) ? [...selectedStepIds] : [step.id],
                      id: step.id, pointerId: event.pointerId, handle: event.currentTarget,
                      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, started: false,
                    }
                  }}
                  onPointerMove={pointerMove}
                  onPointerUp={event => {
                    const drag = dragRef.current
                    if (!drag || drag.pointerId !== event.pointerId) return
                    drag.x = event.clientX
                    drag.y = event.clientY
                    updateDrop()
                    const target = dropRef.current
                    if (drag.started && target && !workflowBusy) onReorderSteps(drag.ids, target.parentId, target.index, target.branch)
                    finishDrag()
                  }}
                  onPointerCancel={finishDrag}
                  onLostPointerCapture={finishDrag}
                  onClick={() => {
                    if (!suppressClickRef.current) onSelectStep(step.id)
                    suppressClickRef.current = false
                  }}>
                  <svg aria-hidden="true" focusable="false" width="16" height="18" viewBox="0 0 16 18">
                    <circle cx="5" cy="4" r="1.5" /><circle cx="11" cy="4" r="1.5" />
                    <circle cx="5" cy="9" r="1.5" /><circle cx="11" cy="9" r="1.5" />
                    <circle cx="5" cy="14" r="1.5" /><circle cx="11" cy="14" r="1.5" />
                  </svg>
                  <span aria-hidden="true">Drag</span>
                </button>
                <button
                  className={`sequence-step-card${validationIssue?.step_id === step.id ? ' sequence-step-invalid' : ''}`}
                  aria-invalid={validationIssue?.step_id === step.id || undefined}
                  type="button"
                  aria-label={`Step ${order}: ${stepLabel(step)}, ${step.id}`}
                  aria-describedby={result ? `sequence-result-${step.id}` : undefined}
                  aria-pressed={selectedStepIds.includes(step.id)}
                  onClick={event => onSelectStep(step.id, { ctrlKey: event.ctrlKey, shiftKey: event.shiftKey })}
                >
                  <span className="sequence-step-order">{order}</span>
                  <span className="sequence-step-identity">
                    <span className="sequence-step-label">{stepLabel(step)}
                      {validationIssue?.step_id === step.id && <span className="sequence-validation-warning" role="img" aria-label="Validation warning" title={validationIssue.message}> ⚠</span>}
                    </span>
                    {countLabel && collapsed && <span className="sequence-container-count">{countLabel}</span>}
                    <span className="sequence-step-summary" title={stepSummary(step, instances)}>
                      {stepSummary(step, instances)}
                    </span>
                    <code>{step.id}</code>
                    {result && (
                      <span id={`sequence-result-${step.id}`} className="sequence-step-result">
                        <span className={`run-result-status run-result-${result.status}`}>
                          <span aria-hidden="true">
                            {result.status === 'succeeded' ? '✓' : result.status === 'failed' ? '✕' : '–'}
                          </span>{' '}
                          {result.status}
                        </span>
                        {outputSummary !== null && (
                          <span className="sequence-step-output">{outputSummary}</span>
                        )}
                      </span>
                    )}
                  </span>
                </button>
                {isContainer && (
                  <button className="sequence-collapse-button" type="button"
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${step.type.toUpperCase()} ${step.id}`}
                    aria-expanded={!collapsed}
                    title={collapsed ? 'Expand nested Steps' : 'Collapse nested Steps'}
                    onClick={() => onToggleContainer(step.id)}>
                    <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                  </button>
                )}
              </div>
              {isContainer && collapsed && (hiddenSelected || hiddenInvalid || hiddenFailed) && (
                <div className="sequence-hidden-status" role="status">
                  {hiddenSelected && <span>Selected Step inside</span>}
                  {hiddenInvalid && <span className="sequence-hidden-warning">Validation warning inside</span>}
                  {hiddenFailed && <span className="sequence-hidden-warning">Failed Step inside</span>}
                </div>
              )}
              <div className="sequence-step-actions" role="group" aria-label={`Actions for ${step.id}`} data-step-drop-id={step.id}>
                <button className="action-button" type="button"
                  disabled={workflowBusy || !canMoveSteps(steps, selectedStepIds.includes(step.id) ? selectedStepIds : [step.id], -1)}
                  onClick={() => onMoveStep(step.id, -1)}>
                  Up
                </button>
                <button className="action-button" type="button"
                  disabled={workflowBusy || !canMoveSteps(steps, selectedStepIds.includes(step.id) ? selectedStepIds : [step.id], 1)}
                  onClick={() => onMoveStep(step.id, 1)}>
                  Down
                </button>
                <button className="action-button action-button-danger" type="button"
                  disabled={workflowBusy}
                  onClick={() => onDeleteStep(step.id)}>
                  Delete
                </button>
              </div>
              {(step.type === 'for' || step.type === 'while') && !collapsed && (
                <div className="sequence-nested-body">{renderSteps(step.steps, step, order)}</div>
              )}
              {step.type === 'if' && !collapsed && (
                <div className="sequence-nested-body">
                  {(['then', 'else'] as const).map(ifBranch => {
                    const branchSteps = ifBranch === 'then' ? step.then_steps : step.else_steps
                    const branchChildren = allWorkflowSteps(branchSteps)
                    const branchCollapsed = collapsedBranches.has(`${step.id}:${ifBranch}`)
                    const branchHiddenSelected = branchCollapsed && branchChildren.some(child => selectedStepIds.includes(child.id))
                    const branchHiddenInvalid = branchCollapsed && branchChildren.some(child => child.id === validationIssue?.step_id)
                    const branchHiddenFailed = branchCollapsed && branchChildren.some(child => runResults?.some(result =>
                      result.step_id === child.id && (result.any_failed || result.status === 'failed')))
                    return (
                      <div key={ifBranch} className="sequence-if-branch">
                        <div className="sequence-branch-heading">
                          <h5>{ifBranch.toUpperCase()} ({branchChildren.length} Steps)</h5>
                          {(branchHiddenSelected || branchHiddenInvalid || branchHiddenFailed) && (
                            <span className="sequence-branch-status" role="status">
                              {branchHiddenSelected ? 'Selected inside' : ''}
                              {branchHiddenInvalid ? ' · Validation warning' : ''}
                              {branchHiddenFailed ? ' · Failed Step' : ''}
                            </span>
                          )}
                          <button type="button" className="sequence-branch-toggle"
                            aria-label={`${branchCollapsed ? 'Expand' : 'Collapse'} ${ifBranch.toUpperCase()} of ${step.id}`}
                            aria-expanded={!branchCollapsed}
                            onClick={() => onToggleBranch(step.id, ifBranch)}>
                            <span aria-hidden="true">{branchCollapsed ? '▸' : '▾'}</span>
                          </button>
                        </div>
                        {!branchCollapsed && renderSteps(branchSteps, step, order, ifBranch)}
                      </div>
                    )
                  })}
                </div>
              )}
            </li>
          )
        })}
        {showEndZone && (
          <li className={`sequence-drop-zone${isTargetContainer && drop?.index === siblings.length ? ' sequence-drop-zone-active' : ''}`}
            data-step-end-target="" data-step-container={parent?.id ?? ''} data-step-branch={branch ?? ''}
            data-step-count={siblings.length} role="presentation">
            <span title={`${locationLabel} · End`} role={isTargetContainer && drop?.index === siblings.length ? 'status' : undefined}>
              ▸ {locationLabel} · End
            </span>
          </li>
        )}
      </ol>
    )
  }

  return (
    <section ref={editorRef} className="sequence-editor" aria-labelledby="sequence-editor-title"
      data-step-density={density}>
      <div className="section-header sequence-header">
        <h3 id="sequence-editor-title">Sequence</h3>
        <div className="sequence-header-actions">
          <button className="action-button action-button-danger" type="button"
            disabled={workflowBusy || steps.length === 0}
            onClick={onClearWorkflow}>
            Clear Workflow
          </button>
          <label className="sequence-density-setting">Step height
            <select aria-label="Step Display Density" value={density}
              onChange={event => onDensityChange(event.target.value as StepDensity)}>
              <option value="compact">Compact</option>
              <option value="standard">Standard</option>
              <option value="comfortable">Comfortable</option>
            </select>
          </label>
        </div>
      </div>
      <div className="sequence-bulk-actions">
        <button className="action-button" type="button" disabled={!hasContainers}
          onClick={() => onSetAllExpanded(true)}>Expand All</button>
        <button className="action-button" type="button" disabled={!hasContainers}
          onClick={() => onSetAllExpanded(false)}>Collapse All</button>
      </div>
      {steps.length === 0 ? (
        <div className="sequence-empty">
          <h4>Create your first workflow</h4>
          <p>Add steps from the palette to build a workflow. Configure each selected step in Properties.</p>
          <h4>Examples</h4>
          <ul className="sequence-examples">
            <li>
              <strong>Measure Only</strong>
              <p>Meter Measure → Output</p>
              <p>Take one measurement and publish the result.</p>
            </li>
            <li>
              <strong>Power and Measure</strong>
              <p>Power Set Output → Power Output ON → Wait → Meter Measure → Output → Power Output OFF</p>
              <p>Power a DUT, wait for settling, measure it, then turn power off.</p>
            </li>
            <li>
              <strong>Reuse a Variable</strong>
              <p>Set Variable → Power Set Output</p>
              <p>Define a value once and reuse it in a later step.</p>
            </li>
          </ul>
        </div>
      ) : null}
      {renderSteps(steps)}
    </section>
  )
}

export default SequenceEditor
