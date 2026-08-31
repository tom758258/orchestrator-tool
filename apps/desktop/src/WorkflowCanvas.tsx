import { useCallback, useMemo, type ReactNode } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react'

export type CanvasPositionMap = Record<string, XYPosition>

export type CanvasPositionChange = {
  id: string
  position: XYPosition
}

type WorkflowCanvasStep = {
  id: string
  label: string
  result: {
    status: 'succeeded' | 'failed' | 'cancelled'
    measurement: string | null
  } | null
}

type WorkflowCanvasProps = {
  steps: WorkflowCanvasStep[]
  positions: CanvasPositionMap
  selectedStepId: string | null
  layoutRevision: number
  workflowBusy: boolean
  onPositionChanges: (changes: CanvasPositionChange[]) => void
  onSelectStep: (stepId: string) => void
  onMoveStep: (stepId: string, offset: -1 | 1) => void
  onDeleteStep: (stepId: string) => void
}

type WorkflowCanvasNode = Node<{ label: ReactNode }>

function defaultPosition(index: number): XYPosition {
  return { x: 180, y: 40 + index * 200 }
}

export function createCanvasPositions(
  steps: readonly { id: string }[],
): CanvasPositionMap {
  return Object.fromEntries(steps.map((step, index) => [step.id, defaultPosition(index)]))
}

export function reconcileCanvasPositions(
  steps: readonly { id: string }[],
  current: CanvasPositionMap,
): CanvasPositionMap {
  const currentIds = Object.keys(current)
  let changed = currentIds.length !== steps.length
  const next: CanvasPositionMap = {}

  steps.forEach((step, index) => {
    const position = current[step.id]
    if (position) {
      next[step.id] = position
    } else {
      next[step.id] = defaultPosition(index)
      changed = true
    }
  })

  return changed ? next : current
}

function WorkflowCanvas({
  steps,
  positions,
  selectedStepId,
  layoutRevision,
  workflowBusy,
  onPositionChanges,
  onSelectStep,
  onMoveStep,
  onDeleteStep,
}: WorkflowCanvasProps) {
  const nodes = useMemo<WorkflowCanvasNode[]>(
    () =>
      steps.map((step, index) => ({
        id: step.id,
        position: positions[step.id] ?? defaultPosition(index),
        data: {
          label: (
            <div className="workflow-canvas-node-content">
              <div className="workflow-canvas-node-heading">
                <span className="workflow-canvas-node-order">{index + 1}</span>
                <div className="workflow-canvas-node-identity">
                  <span className="workflow-canvas-node-title">
                    {step.result && (
                      <span aria-hidden="true">
                        {step.result.status === 'succeeded'
                          ? '✓ '
                          : step.result.status === 'failed'
                            ? '✕ '
                            : '— '}
                      </span>
                    )}
                    {step.label}
                  </span>
                  <code>{step.id}</code>
                </div>
              </div>

              {step.result && (
                <div
                  className={`workflow-canvas-node-result workflow-canvas-node-result-${step.result.status}`}
                >
                  <span>
                    {step.result.status === 'succeeded'
                      ? 'Success'
                      : step.result.status === 'failed'
                        ? 'Failed'
                        : 'Cancelled'}
                  </span>
                  {step.result.measurement && (
                    <span className="workflow-canvas-node-measurement">
                      {step.result.measurement}
                    </span>
                  )}
                </div>
              )}

              <div className="workflow-canvas-node-actions nodrag nopan">
                <button
                  className="action-button"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onMoveStep(step.id, -1)
                  }}
                  disabled={index === 0 || workflowBusy}
                >
                  Earlier
                </button>
                <button
                  className="action-button"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onMoveStep(step.id, 1)
                  }}
                  disabled={index === steps.length - 1 || workflowBusy}
                >
                  Later
                </button>
                <button
                  className="action-button"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onDeleteStep(step.id)
                  }}
                  disabled={workflowBusy}
                >
                  Delete
                </button>
              </div>
            </div>
          ),
        },
        ariaLabel: `Step ${index + 1}: ${step.label}, ${step.id}`,
        connectable: false,
        deletable: false,
        selected: selectedStepId === step.id,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
      })),
    [onDeleteStep, onMoveStep, positions, selectedStepId, steps, workflowBusy],
  )

  const edges = useMemo<Edge[]>(
    () =>
      steps.slice(0, -1).map((step, index) => {
        const nextStep = steps[index + 1]
        return {
          id: `linear:${step.id}:${nextStep.id}`,
          source: step.id,
          target: nextStep.id,
          ariaLabel: `${step.id} to ${nextStep.id}`,
          deletable: false,
          focusable: false,
          markerEnd: { type: MarkerType.ArrowClosed },
          reconnectable: false,
          selectable: false,
        }
      }),
    [steps],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange<WorkflowCanvasNode>[]) => {
      const positionChanges = changes.flatMap<CanvasPositionChange>((change) =>
        change.type === 'position' && change.position
          ? [{ id: change.id, position: change.position }]
          : [],
      )

      if (positionChanges.length > 0) {
        onPositionChanges(positionChanges)
      }
    },
    [onPositionChanges],
  )

  return (
    <div className="workflow-canvas" role="region" aria-label="Workflow canvas">
      <ReactFlow
        key={layoutRevision}
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onNodeClick={(_event, node) => onSelectStep(node.id)}
        nodesConnectable={false}
        edgesFocusable={false}
        edgesReconnectable={false}
        connectOnClick={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2 }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>

      {steps.length === 0 && <p className="workflow-canvas-empty">No workflow steps yet.</p>}
    </div>
  )
}

export default WorkflowCanvas
