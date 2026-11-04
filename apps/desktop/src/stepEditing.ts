import { allWorkflowSteps, containerPath, loopPath, mapWorkflowSteps, outputDefinitions, outputPages } from './workflow.ts'
import type { StepBranch, WorkflowStep } from './workflow'
import type { ExpressionOperandWire, InputValueWire } from './inputValue'

export type StepSelection = { ids: string[]; active: string | null; anchor: string | null }

export function singleSelection(id: string | null): StepSelection {
  return { ids: id ? [id] : [], active: id, anchor: id }
}

export type StepContainer = { siblings: readonly WorkflowStep[]; parentId: string | null; branch: StepBranch | null }

export function stepContainer(steps: readonly WorkflowStep[], id: string): StepContainer | undefined {
  if (steps.some(step => step.id === id)) return { siblings: steps, parentId: null, branch: null }
  for (const step of steps) {
    if (step.type === 'if') {
      for (const branch of ['then', 'else'] as const) {
        const body = branch === 'then' ? step.then_steps : step.else_steps
        const found = stepContainer(body, id)
        if (found) return found.parentId === null
          ? { siblings: found.siblings, parentId: step.id, branch } : found
      }
    } else if (step.type === 'for' || step.type === 'while') {
      const found = stepContainer(step.steps, id)
      if (found) return found.parentId === null
        ? { siblings: found.siblings, parentId: step.id, branch: null } : found
    }
  }
}

export function reconcileSelection(steps: readonly WorkflowStep[], selection: StepSelection): StepSelection {
  const existing = new Set(allWorkflowSteps(steps).map(step => step.id))
  const active = selection.active && existing.has(selection.active) && selection.ids.includes(selection.active)
    ? selection.active : selection.ids.find(id => existing.has(id)) ?? null
  if (!active) return singleSelection(null)
  const siblings = stepContainer(steps, active)!.siblings
  const ids = siblings.filter(step => selection.ids.includes(step.id)).map(step => step.id)
  const anchor = siblings.some(step => step.id === selection.anchor) ? selection.anchor : active
  if (active === selection.active && anchor === selection.anchor &&
    ids.length === selection.ids.length && ids.every((id, index) => id === selection.ids[index])) return selection
  return { ids, active, anchor }
}

export function selectStep(steps: readonly WorkflowStep[], selection: StepSelection, id: string,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}): StepSelection {
  const container = stepContainer(steps, id)
  if (!container) return reconcileSelection(steps, selection)
  const current = reconcileSelection(steps, selection)
  if (!current.active ||
    stepContainer(steps, current.active)?.parentId !== container.parentId ||
    stepContainer(steps, current.active)?.branch !== container.branch) return singleSelection(id)
  const { siblings } = container
  if (modifiers.shiftKey && current.anchor) {
    const anchorIndex = siblings.findIndex(step => step.id === current.anchor)
    const index = siblings.findIndex(step => step.id === id)
    return { ids: siblings.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1).map(step => step.id),
      active: id, anchor: current.anchor }
  }
  if (modifiers.ctrlKey) {
    const ids = siblings.filter(step => step.id === id ? !current.ids.includes(id) : current.ids.includes(step.id)).map(step => step.id)
    return { ids, active: ids.includes(id) ? id : ids.includes(current.active) ? current.active : ids.at(-1) ?? null,
      anchor: ids.length ? current.anchor : null }
  }
  return singleSelection(id)
}

function selectedContainer(steps: readonly WorkflowStep[], ids: readonly string[]) {
  const container = ids.length ? stepContainer(steps, ids[0]) : undefined
  return container && ids.every(id => container.siblings.some(step => step.id === id)) ? container : undefined
}

export function replaceSiblings(steps: WorkflowStep[], parentId: string | null, siblings: WorkflowStep[],
  branch: StepBranch | null = null): WorkflowStep[] {
  return parentId === null ? siblings : mapWorkflowSteps(steps, step => {
    if (step.id !== parentId) return step
    if (step.type === 'if' && branch) return { ...step, [branch === 'then' ? 'then_steps' : 'else_steps']: siblings }
    return step.type === 'for' || step.type === 'while' ? { ...step, steps: siblings } : step
  })
}

export function canMoveSteps(steps: readonly WorkflowStep[], ids: readonly string[], offset: -1 | 1): boolean {
  const container = selectedContainer(steps, ids)
  if (!container) return false
  return !ids.includes(container.siblings[offset === -1 ? 0 : container.siblings.length - 1].id)
}

export function moveSteps(steps: WorkflowStep[], ids: readonly string[], offset: -1 | 1): WorkflowStep[] {
  if (!canMoveSteps(steps, ids, offset)) return steps
  const { siblings, parentId, branch } = selectedContainer(steps, ids)!
  const next = [...siblings]
  const indices = next.flatMap((step, index) => ids.includes(step.id) ? [index] : [])
  if (offset === 1) indices.reverse()
  for (const index of indices) [next[index], next[index + offset]] = [next[index + offset], next[index]]
  return replaceSiblings(steps, parentId, next, branch)
}

export function canRelocateSteps(steps: readonly WorkflowStep[], ids: readonly string[],
  parentId: string | null, branch: StepBranch | null = null): boolean {
  const source = selectedContainer(steps, ids)
  if (!source) return false
  const moving = source.siblings.filter(step => ids.includes(step.id))
  const descendants = allWorkflowSteps(moving)
  const parent = parentId === null ? null : allWorkflowSteps(steps).find(step => step.id === parentId)
  if ((parentId === null && branch !== null) ||
      (parentId !== null && (!parent || descendants.some(step => step.id === parentId) ||
        (parent.type === 'if' ? branch === null :
          (parent.type !== 'for' && parent.type !== 'while') || branch !== null)))) return false
  const ancestors = parentId === null ? [] : [...containerPath(steps, parentId).map(node => node.step), parent!]
  const depth = ancestors.length
  return descendants.every(step => {
    if (step.type !== 'for' && step.type !== 'while' && step.type !== 'if') return true
    const inside = containerPath(moving, step.id).map(node => node.step)
    if (depth + inside.length + 1 > 8) return false
    if (step.type === 'while' && step.max_iterations === null &&
        [...ancestors, ...inside].some(parent => parent.type === 'for' || parent.type === 'while')) return false
    return true
  })
}

// The boundary is measured in the destination list before removing the source.
export function relocateSteps(steps: WorkflowStep[], ids: readonly string[], parentId: string | null,
  boundary: number, branch: StepBranch | null = null): WorkflowStep[] {
  if (!canRelocateSteps(steps, ids, parentId, branch)) return steps
  const source = selectedContainer(steps, ids)!
  const destinationParent = parentId === null ? null : allWorkflowSteps(steps).find(step => step.id === parentId)
  const destination = destinationParent?.type === 'if'
    ? branch === 'then' ? destinationParent.then_steps : destinationParent.else_steps
    : destinationParent?.type === 'for' || destinationParent?.type === 'while' ? destinationParent.steps : steps
  if (!Number.isInteger(boundary) || boundary < 0 || boundary > destination.length) return steps
  const moving = source.siblings.filter(step => ids.includes(step.id))
  const same = source.parentId === parentId && source.branch === branch
  const index = same ? destination.slice(0, boundary).filter(step => !ids.includes(step.id)).length : boundary
  const removed = replaceSiblings(steps, source.parentId, source.siblings.filter(step => !ids.includes(step.id)), source.branch)
  const remainingParent = parentId === null ? null : allWorkflowSteps(removed).find(step => step.id === parentId)
  const remaining = remainingParent?.type === 'if'
    ? branch === 'then' ? remainingParent.then_steps : remainingParent.else_steps
    : remainingParent?.type === 'for' || remainingParent?.type === 'while' ? remainingParent.steps : removed
  const next = [...remaining.slice(0, index), ...moving, ...remaining.slice(index)]
  if (same && next.every((step, index) => step.id === destination[index]?.id)) return steps
  return replaceSiblings(removed, parentId, next, branch)
}

export function reorderSteps(steps: WorkflowStep[], ids: readonly string[], targetId: string, after: boolean): WorkflowStep[] {
  const container = stepContainer(steps, targetId)
  if (!container || ids.includes(targetId)) return steps
  return relocateSteps(steps, ids, container.parentId,
    container.siblings.findIndex(step => step.id === targetId) + (after ? 1 : 0), container.branch)
}

export function selectAllSteps(steps: readonly WorkflowStep[], selection: StepSelection): StepSelection {
  const current = reconcileSelection(steps, selection)
  const siblings = current.active ? stepContainer(steps, current.active)!.siblings : steps
  const ids = siblings.map(step => step.id)
  return { ids, active: current.active ?? ids[0] ?? null, anchor: current.anchor ?? ids[0] ?? null }
}

export function deleteSteps(steps: WorkflowStep[], ids: readonly string[]): WorkflowStep[] {
  return mapWorkflowSteps(steps, step => ids.includes(step.id) ? null : step)
}

export function copySteps(steps: readonly WorkflowStep[], selection: StepSelection): WorkflowStep[] {
  const current = reconcileSelection(steps, selection)
  if (!current.active) return []
  return structuredClone(stepContainer(steps, current.active)!.siblings.filter(step => current.ids.includes(step.id)))
}

function uniqueName(base: string, used: Set<string>, suffix: (index: number) => string): string {
  let index = 1
  let name = base
  while (used.has(name)) name = suffix(index++)
  used.add(name)
  return name
}

export function pasteSteps(steps: WorkflowStep[], clipboard: readonly WorkflowStep[], selection: StepSelection,
  reservedIds: ReadonlySet<string> = new Set(), preserveIds = false, preferredBranch: StepBranch = 'then'): {
  steps: WorkflowStep[]; selection: StepSelection
} {
  const current = reconcileSelection(steps, selection)
  if (!clipboard.length) return { steps, selection: current }
  const selected = current.active ? allWorkflowSteps(steps).find(step => step.id === current.active) : null
  const container: StepContainer = selected?.type === 'if'
    ? { siblings: preferredBranch === 'then' ? selected.then_steps : selected.else_steps,
        parentId: selected.id, branch: preferredBranch }
    : current.active ? stepContainer(steps, current.active)!
      : { siblings: steps, parentId: null, branch: null }
  const usedIds = new Set([...reservedIds, ...allWorkflowSteps(steps).map(step => step.id)])
  const keepIds = preserveIds && allWorkflowSteps(clipboard).every(step => !allWorkflowSteps(steps).some(existing => existing.id === step.id))
  const idMap = new Map<string, string>()
  for (const step of allWorkflowSteps(clipboard)) {
    const base = `${step.id}-copy`
    idMap.set(step.id, keepIds ? step.id : uniqueName(base, usedIds, index => `${base}-${index + 1}`))
  }
  const operand = (value: ExpressionOperandWire): ExpressionOperandWire => value.source === 'step-output'
    ? { ...value, step_id: idMap.get(value.step_id) ?? value.step_id } : value
  const input = (value: InputValueWire): InputValueWire => value.source === 'expression'
    ? { ...value, left: operand(value.left), right: operand(value.right) }
    : value.source === 'step-output' ? operand(value) : value
  const pasted = mapWorkflowSteps(structuredClone([...clipboard]), step => {
    const next = { ...step, id: idMap.get(step.id)! }
    switch (next.type) {
      case 'set-variable':
      case 'output': return { ...next, value: input(next.value) }
      case 'assert':
      case 'while':
      case 'if': return { ...next, left: operand(next.left), right: operand(next.right) }
      case 'show-message': return { ...next, fields: next.fields.map(field =>
        field.kind === 'output' ? { ...field, step_id: idMap.get(field.step_id) ?? field.step_id } : field) }
      case 'tool-action': return next.bindings
        ? { ...next, bindings: Object.fromEntries(Object.entries(next.bindings).map(([key, value]) => [key, input(value)])) }
        : next
      default: return next
    }
  })
  const usedNames = new Set(outputDefinitions(steps).map(step => step.name))
  const pages = outputPages(steps)
  const usedPages = new Set(pages.map(page => page.name.toLowerCase()))
  const pageMap = new Map<string, string>()
  const parent = container.parentId ? allWorkflowSteps(steps).find(step => step.id === container.parentId) : null
  const destinationScope = container.parentId
    ? [...loopPath(steps, container.parentId).map(loop => loop.id),
        ...(parent?.type === 'for' || parent?.type === 'while' ? [container.parentId] : [])] : []
  for (const output of outputDefinitions(pasted)) {
    const name = output.name
    output.name = uniqueName(name, usedNames, index => `${name} Copy${index === 1 ? '' : ` ${index}`}`)
    const scope = [...destinationScope, ...loopPath(pasted, output.id).map(loop => loop.id)]
    const key = JSON.stringify([output.page, scope])
    const mapped = pageMap.get(key)
    if (mapped) { output.page = mapped; continue }
    const existing = pages.find(page => page.name === output.page)
    const compatible = existing && JSON.stringify(existing.scope) === JSON.stringify(scope)
    let page = output.page
    if (!compatible && usedPages.has(page.toLowerCase())) {
      let index = 1
      do {
        const suffix = ` Copy${index === 1 ? '' : ` ${index}`}`
        page = Array.from(output.page).slice(0, 31 - suffix.length).join('').trimEnd() + suffix
        index++
      } while (usedPages.has(page.toLowerCase()))
    }
    pageMap.set(key, page)
    usedPages.add(page.toLowerCase())
    pages.push({ name: page, scope, outputs: [] })
    output.page = page
  }
  const last = current.ids.at(-1)
  const index = last ? container.siblings.findIndex(step => step.id === last) + 1 : container.siblings.length
  const next = [...container.siblings.slice(0, index), ...pasted, ...container.siblings.slice(index)]
  const ids = pasted.map(step => step.id)
  const ancestors = container.parentId
    ? [...containerPath(steps, container.parentId).map(node => node.step), parent!] : []
  const validDepth = allWorkflowSteps(pasted).every(step => {
    if (step.type !== 'if' && step.type !== 'for' && step.type !== 'while') return true
    const inside = containerPath(pasted, step.id).map(node => node.step)
    return ancestors.length + inside.length + 1 <= 8 &&
      !(step.type === 'while' && step.max_iterations === null &&
        [...ancestors, ...inside].some(node => node.type === 'for' || node.type === 'while'))
  })
  if (!validDepth) return { steps, selection: current }
  return { steps: replaceSiblings(steps, container.parentId, next, container.branch),
    selection: { ids, active: ids.at(-1)!, anchor: ids[0] } }
}

export function stepClipboardShortcut(event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string },
  inWorkflow: boolean, editable: boolean): 'copy' | 'paste' | 'cut' | 'delete' | 'select-all' | null {
  if (!inWorkflow || editable || event.altKey || event.shiftKey) return null
  if (!event.ctrlKey) return event.key === 'Delete' ? 'delete' : null
  switch (event.key.toLowerCase()) {
    case 'c': return 'copy'
    case 'v': return 'paste'
    case 'x': return 'cut'
    case 'a': return 'select-all'
    default: return null
  }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && (target.closest('input, textarea, select') !== null ||
    (target instanceof HTMLElement ? target.isContentEditable : target.parentElement?.isContentEditable === true))
}
