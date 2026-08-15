import type { TaskState, TaskStatus } from "@story/shared";

interface PositionedTask {
  task: TaskState;
  x: number;
  y: number;
}

const NODE_WIDTH = 210;
const NODE_HEIGHT = 82;
const COLUMN_GAP = 92;
const ROW_GAP = 28;
const PADDING = 26;

function taskLayers(tasks: TaskState[]): TaskState[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const byBaseId = new Map<string, TaskState[]>();
  tasks.forEach((task) => {
    const group = byBaseId.get(task.baseTaskId) ?? [];
    group.push(task);
    byBaseId.set(task.baseTaskId, group);
  });
  const dependencies = (task: TaskState) =>
    task.dependsOn.flatMap((id) => {
      const exact = byId.get(id);
      return exact ? [exact] : (byBaseId.get(id) ?? []);
    }).filter((dependency) => dependency.id !== task.id);
  const depths = new Map<string, number>();
  const visit = (task: TaskState, trail = new Set<string>()): number => {
    const cached = depths.get(task.id);
    if (cached !== undefined) return cached;
    if (trail.has(task.id)) return 0;
    const nextTrail = new Set(trail).add(task.id);
    const dependencyDepths = dependencies(task).map((dependency) => visit(dependency, nextTrail));
    const depth = dependencyDepths.length ? Math.max(...dependencyDepths) + 1 : 0;
    depths.set(task.id, depth);
    return depth;
  };
  tasks.forEach((task) => visit(task));
  const layers: TaskState[][] = [];
  tasks.forEach((task) => {
    const depth = depths.get(task.id) ?? 0;
    (layers[depth] ??= []).push(task);
  });
  layers.forEach((layer) =>
    layer.sort((a, b) => (a.itemIndex ?? Number.MAX_SAFE_INTEGER) - (b.itemIndex ?? Number.MAX_SAFE_INTEGER)),
  );
  return layers;
}

function statusLabel(status: TaskStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function shortName(task: TaskState): string {
  if (task.itemIndex !== undefined) return `${task.baseTaskId} · ${task.itemIndex + 1}`;
  return task.id;
}

export function DagView({
  tasks,
  selectedTaskId,
  onSelect,
}: {
  tasks: TaskState[];
  selectedTaskId?: string;
  onSelect: (taskId: string) => void;
}) {
  if (!tasks.length) {
    return <div className="empty compact">Tasks will appear here when the run is prepared.</div>;
  }

  const layers = taskLayers(tasks);
  const maxRows = Math.max(...layers.map((layer) => layer.length));
  const width =
    PADDING * 2 + layers.length * NODE_WIDTH + Math.max(0, layers.length - 1) * COLUMN_GAP;
  const height = PADDING * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  const positioned: PositionedTask[] = [];

  layers.forEach((layer, column) => {
    const layerHeight = layer.length * NODE_HEIGHT + Math.max(0, layer.length - 1) * ROW_GAP;
    const offset = (height - layerHeight) / 2;
    layer.forEach((task, row) => {
      positioned.push({
        task,
        x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
        y: offset + row * (NODE_HEIGHT + ROW_GAP),
      });
    });
  });

  const positions = new Map(positioned.map((item) => [item.task.id, item]));
  const positionsByBaseId = new Map<string, PositionedTask[]>();
  positioned.forEach((item) => {
    const group = positionsByBaseId.get(item.task.baseTaskId) ?? [];
    group.push(item);
    positionsByBaseId.set(item.task.baseTaskId, group);
  });
  const edges = positioned.flatMap((target) =>
    target.task.dependsOn.flatMap((dependencyId) => {
      const source = positions.get(dependencyId);
      const sources = source ? [source] : (positionsByBaseId.get(dependencyId) ?? []);
      return sources
        .filter((candidate) => candidate.task.id !== target.task.id)
        .map((candidate) => ({ source: candidate, target }));
    }),
  );

  return (
    <div className="dag-scroll" role="group" aria-label="Workflow dependency graph">
      <div className="dag-canvas" style={{ width, height }}>
        <svg className="dag-edges" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" className="arrow-head" />
            </marker>
          </defs>
          {edges.map(({ source, target }) => {
            const x1 = source.x + NODE_WIDTH;
            const y1 = source.y + NODE_HEIGHT / 2;
            const x2 = target.x;
            const y2 = target.y + NODE_HEIGHT / 2;
            const bend = Math.max(34, (x2 - x1) * 0.5);
            return (
              <path
                key={`${source.task.id}-${target.task.id}`}
                className={`dag-edge edge-${target.task.status}`}
                d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                markerEnd="url(#arrow)"
              />
            );
          })}
        </svg>
        {positioned.map(({ task, x, y }) => (
          <button
            key={task.id}
            type="button"
            className={`dag-node status-${task.status}${selectedTaskId === task.id ? " selected" : ""}`}
            style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}
            onClick={() => onSelect(task.id)}
            aria-pressed={selectedTaskId === task.id}
          >
            <span className="node-topline">
              <span className="node-name">{shortName(task)}</span>
              <span className="status-dot" aria-hidden="true" />
            </span>
            <span className="node-description">{task.description || task.baseTaskId}</span>
            <span className="node-meta">
              {statusLabel(task.status)}
              {task.attempt > 0 ? ` · attempt ${task.attempt}` : ""}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
