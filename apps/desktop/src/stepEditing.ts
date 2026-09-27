import { allWorkflowSteps, loopPath, mapWorkflowSteps, outputDefinitions, outputPages } from './workflow.ts'
import type { WorkflowStep } from './workflow'
import type { ExpressionOperandWire, InputValueWire } from './inputValue'

export type StepSelection = { ids: string[]; active: string | null; anchor: string | null }

export function singleSelection(id: string | null): StepSelection {
  return { ids: id ? [id] : [], active: id, anchor: id }
}

export function stepContainer(steps: readonly WorkflowStep[], id: string): {
  siblings: readonly WorkflowStep[]; parentId: string | null
} | undefined {
  if (steps.some(step => step.id === id)) return { siblings: steps, parentId: null }
  for (const step of steps) {
    if (step.type !== 'for' && step.type !== 'while') continue
    const found = stepContainer(step.steps, id)
    if (found) return { ...found, parentId: found.parentId ?? step.id }
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
  if (!current.active || stepContainer(steps, current.active)?.parentId !== container.parentId) return singleSelection(id)
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

function replaceSiblings(steps: WorkflowStep[], parentId: string | null, siblings: WorkflowStep[]) {
  return parentId === null ? siblings : mapWorkflowSteps(steps, step =>
    step.id === parentId && (step.type === 'for' || step.type === 'while') ? { ...step, steps: siblings } : step)
}

export function canMoveSteps(steps: readonly WorkflowStep[], ids: readonly string[], offset: -1 | 1): boolean {
  const container = selectedContainer(steps, ids)
  if (!container) return false
  return !ids.includes(container.siblings[offset === -1 ? 0 : container.siblings.length - 1].id)
}

export function moveSteps(steps: WorkflowStep[], ids: readonly string[], offset: -1 | 1): WorkflowStep[] {
  if (!canMoveSteps(steps, ids, offset)) return steps
  const { siblings, parentId } = selectedContainer(steps, ids)!
  const next = [...siblings]
  const indices = next.flatMap((step, index) => ids.includes(step.id) ? [index] : [])
  if (offset === 1) indices.reverse()
  for (const index of indices) [next[index], next[index + offset]] = [next[index + offset], next[index]]
  return replaceSiblings(steps, parentId, next)
}

export function reorderSteps(steps: WorkflowStep[], ids: readonly string[], targetId: string, after: boolean): WorkflowStep[] {
  const container = selectedContainer(steps, ids)
  if (!container || ids.includes(targetId) || !container.siblings.some(step => step.id === targetId)) return steps
  const { siblings, parentId } = container
  const boundary = siblings.findIndex(step => step.id === targetId) + (after ? 1 : 0)
  const moving = siblings.filter(step => ids.includes(step.id))
  const remaining = siblings.filter(step => !ids.includes(step.id))
  const index = siblings.slice(0, boundary).filter(step => !ids.includes(step.id)).length
  const next = [...remaining.slice(0, index), ...moving, ...remaining.slice(index)]
  if (next.every((step, index) => step === siblings[index])) return steps
  return replaceSiblings(steps, parentId, next)
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
  reservedIds: ReadonlySet<string> = new Set()): {
  steps: WorkflowStep[]; selection: StepSelection
} {
  const current = reconcileSelection(steps, selection)
  if (!clipboard.length) return { steps, selection: current }
  const container = current.active ? stepContainer(steps, current.active)! : { siblings: steps, parentId: null }
  const usedIds = new Set([...reservedIds, ...allWorkflowSteps(steps).map(step => step.id)])
  const idMap = new Map<string, string>()
  for (const step of allWorkflowSteps(clipboard)) {
    const base = `${step.id}-copy`
    idMap.set(step.id, uniqueName(base, usedIds, index => `${base}-${index + 1}`))
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
      case 'while': return { ...next, left: operand(next.left), right: operand(next.right) }
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
  const destinationScope = container.parentId
    ? [...loopPath(steps, container.parentId).map(loop => loop.id), container.parentId] : []
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
  return { steps: replaceSiblings(steps, container.parentId, next),
    selection: { ids, active: ids.at(-1)!, anchor: ids[0] } }
}

export function stepClipboardShortcut(event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string },
  inWorkflow: boolean, editable: boolean): 'copy' | 'paste' | null {
  if (!inWorkflow || editable || !event.ctrlKey || event.altKey || event.shiftKey) return null
  return event.key.toLowerCase() === 'c' ? 'copy' : event.key.toLowerCase() === 'v' ? 'paste' : null
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && (target.closest('input, textarea, select') !== null ||
    (target instanceof HTMLElement ? target.isContentEditable : target.parentElement?.isContentEditable === true))
}
