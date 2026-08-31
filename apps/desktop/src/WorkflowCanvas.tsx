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
}

type WorkflowCanvasProps = {
  steps: WorkflowCanvasStep[]
  positions: CanvasPositionMap
  selectedStepId: string | null
  layoutRevision: number
  onPositionChanges: (changes: CanvasPositionChange[]) => void
  onSelectStep: (stepId: string) => void
}

type WorkflowCanvasNode = Node<{ label: ReactNode }>

function defaultPosition(index: number): XYPosition {
  return { x: 180, y: 40 + index * 120 }
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
  onPositionChanges,
  onSelectStep,
}: WorkflowCanvasProps) {
  const nodes = useMemo<WorkflowCanvasNode[]>(
    () =>
      steps.map((step, index) => ({
        id: step.id,
        position: positions[step.id] ?? defaultPosition(index),
        data: {
          label: (
            <div className="workflow-canvas-node-label">
              <span>{step.label}</span>
              <code>{step.id}</code>
            </div>
          ),
        },
        ariaLabel: `${step.label}, ${step.id}`,
        connectable: false,
        deletable: false,
        selected: selectedStepId === step.id,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
      })),
    [positions, selectedStepId, steps],
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
        <Controls />
      </ReactFlow>

      {steps.length === 0 && <p className="workflow-canvas-empty">No workflow steps yet.</p>}
    </div>
  )
}

export default WorkflowCanvas
