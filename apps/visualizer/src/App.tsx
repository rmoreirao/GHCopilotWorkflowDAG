import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type {
  CreateRunRequest,
  RunSummary,
  TaskState,
  WorkflowDefinition,
  WorkflowEvent,
} from "@story/shared";
import { storyUrl } from "./api.js";
import { DagView } from "./DagView.js";
import { useDashboard } from "./useDashboard.js";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : dateFormatter.format(date);
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function elapsed(start?: string, end?: string): string {
  if (!start) return "—";
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : Date.now();
  return formatDuration(endMs - startMs);
}

function titleCase(value: string): string {
  return value.replaceAll(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function JsonBlock({ value, empty = "No manifest recorded." }: { value: unknown; empty?: string }) {
  const isEmpty =
    value === undefined ||
    value === null ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
  if (isEmpty) return <p className="muted inset-empty">{empty}</p>;
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function CreateRunForm({
  busy,
  workflows,
  onCreate,
}: {
  busy: boolean;
  workflows: WorkflowDefinition[];
  onCreate: (input: CreateRunRequest) => Promise<boolean>;
}) {
  const [prompt, setPrompt] = useState("");
  const [sceneCount, setSceneCount] = useState(4);
  const [visualStyle, setVisualStyle] = useState("cinematic storybook");
  const [maxParallelScenes, setMaxParallelScenes] = useState(3);
  const [executor, setExecutor] = useState<"copilot" | "deterministic">("copilot");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim()) return;
    const created = await onCreate({
      storyPrompt: prompt.trim(),
      sceneCount,
      visualStyle: visualStyle.trim() || undefined,
      maxParallelScenes,
      executor,
    });
    if (created) setPrompt("");
  };

  return (
    <form className="create-form" onSubmit={(event) => void submit(event)}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">New workflow</span>
          <h2>Create a story run</h2>
        </div>
        <Badge tone="accent">
          {workflows.length ? `${workflows.length} workflow${workflows.length === 1 ? "" : "s"}` : "Local"}
        </Badge>
      </div>
      <label className="field prompt-field">
        <span>Story prompt</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="A lighthouse keeper discovers the stars are sending a message…"
          rows={4}
          required
        />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>Scenes</span>
          <input
            type="number"
            min={1}
            max={24}
            value={sceneCount}
            onChange={(event) => setSceneCount(Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Parallel scenes</span>
          <input
            type="number"
            min={1}
            max={12}
            value={maxParallelScenes}
            onChange={(event) => setMaxParallelScenes(Number(event.target.value))}
          />
        </label>
        <label className="field field-wide">
          <span>Visual style</span>
          <input
            value={visualStyle}
            onChange={(event) => setVisualStyle(event.target.value)}
            placeholder="Watercolor, noir, pixel art…"
          />
        </label>
        <label className="field field-wide">
          <span>Executor</span>
          <select
            value={executor}
            onChange={(event) =>
              setExecutor(event.target.value as "copilot" | "deterministic")
            }
          >
            <option value="copilot">Copilot</option>
            <option value="deterministic">Deterministic</option>
          </select>
        </label>
      </div>
      <button className="button button-primary create-button" disabled={busy || !prompt.trim()}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">✦</span>}
        {busy ? "Starting run…" : "Create & start run"}
      </button>
    </form>
  );
}

function RunList({
  runs,
  selectedId,
  loading,
  onSelect,
}: {
  runs: RunSummary[];
  selectedId?: string;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="run-history" aria-labelledby="history-title">
      <div className="section-heading compact-heading">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2 id="history-title">Run history</h2>
        </div>
        <span className="count-pill">{runs.length}</span>
      </div>
      {loading && !runs.length ? (
        <div className="run-list skeleton-list" aria-label="Loading runs">
          {[0, 1, 2].map((item) => <div className="skeleton run-skeleton" key={item} />)}
        </div>
      ) : !runs.length ? (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">◇</span>
          <strong>No story runs yet</strong>
          <span>Create one above to start building.</span>
        </div>
      ) : (
        <div className="run-list">
          {runs.map((run) => {
            const { state } = run;
            const progress = run.taskCount ? Math.round((run.completedTasks / run.taskCount) * 100) : 0;
            return (
              <button
                type="button"
                className={`run-list-item${selectedId === state.runId ? " active" : ""}`}
                key={state.runId}
                onClick={() => onSelect(state.runId)}
                aria-pressed={selectedId === state.runId}
              >
                <span className="run-item-top">
                  <span className="run-item-title">{state.storyPrompt || state.workflowName}</span>
                  <span className={`status-dot status-fill-${state.status}`} aria-label={state.status} />
                </span>
                <span className="run-item-meta">
                  <span>{formatDate(state.createdAt)}</span>
                  <span>{progress}%</span>
                </span>
                <span className="mini-progress" aria-hidden="true">
                  <span style={{ width: `${progress}%` }} />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Metrics({ run }: { run: RunSummary }) {
  const { state } = run;
  const totalAttempts = Object.values(state.tasks).reduce(
    (sum, task) => sum + Math.max(task.attempts.length, task.attempt),
    0,
  );
  const active = run.runningTasks || Object.values(state.tasks).filter((task) => task.status === "ready").length;
  const metrics = [
    { label: "Tasks", value: `${run.completedTasks}/${run.taskCount}`, hint: "completed", icon: "✓" },
    { label: "Active", value: active, hint: "running or ready", icon: "↗" },
    { label: "Attempts", value: totalAttempts, hint: `${run.failedTasks} failed`, icon: "↻" },
    { label: "Duration", value: formatDuration(run.durationMs), hint: "elapsed", icon: "◷" },
  ];
  return (
    <div className="metrics-grid" aria-label="Run metrics">
      {metrics.map((metric) => (
        <article className="metric-card" key={metric.label}>
          <span className="metric-icon" aria-hidden="true">{metric.icon}</span>
          <span>
            <span className="metric-label">{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.hint}</small>
          </span>
        </article>
      ))}
    </div>
  );
}

function RunHeader({
  run,
  busyAction,
  selectedTaskId,
  onAction,
}: {
  run: RunSummary;
  busyAction?: string;
  selectedTaskId?: string;
  onAction: (action: "retry" | "resume" | "cancel", taskId?: string) => void;
}) {
  const { state } = run;
  const progress = run.taskCount ? Math.round((run.completedTasks / run.taskCount) * 100) : 0;
  const outputUrl = storyUrl(state);
  return (
    <section className="run-header panel">
      <div className="run-title-row">
        <div className="run-title-copy">
          <div className="run-kicker">
            <Badge tone={state.status}>{titleCase(state.status)}</Badge>
            <span>{state.workflowName} v{state.workflowVersion}</span>
            <span className="mono">#{state.runId.slice(0, 8)}</span>
          </div>
          <h1>{state.storyPrompt || "Untitled story run"}</h1>
          <p>Updated {formatDate(state.updatedAt)} · {run.taskCount} workflow tasks</p>
        </div>
        <div className="run-actions" aria-label="Run controls">
          {selectedTaskId && state.tasks[selectedTaskId]?.status === "failed" && (
            <button
              className="button button-primary"
              disabled={Boolean(busyAction)}
              onClick={() => onAction("retry", selectedTaskId)}
              title={selectedTaskId ? "Retry the selected task" : "Retry failed work"}
            >
              {busyAction === "retry" ? "Retrying…" : "Retry task"}
            </button>
          )}
          {state.status === "interrupted" && (
            <button
              className="button button-primary"
              disabled={Boolean(busyAction)}
              onClick={() => onAction("resume")}
            >
              {busyAction === "resume" ? "Resuming…" : "Resume"}
            </button>
          )}
          {state.status === "running" && (
            <button
              className="button button-danger"
              disabled={Boolean(busyAction)}
              onClick={() => onAction("cancel")}
            >
              {busyAction === "cancel" ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {outputUrl && (
            <a className="button button-secondary" href={outputUrl} target="_blank" rel="noreferrer">
              Open story <span aria-hidden="true">↗</span>
            </a>
          )}
        </div>
      </div>
      <div className="progress-row">
        <div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <strong>{progress}%</strong>
      </div>
    </section>
  );
}

function inputManifest(task: TaskState, events: WorkflowEvent[]): unknown {
  const taskEvents = events.filter((event) => event.taskId === task.id);
  for (const event of [...taskEvents].reverse()) {
    const data = event.data;
    if (!data) continue;
    for (const key of ["inputManifest", "inputs", "input"]) {
      if (data[key] !== undefined) return data[key];
    }
  }
  if (task.item !== undefined) return { item: task.item, itemIndex: task.itemIndex };
  return undefined;
}

function TaskDetail({
  task,
  events,
  onClose,
}: {
  task?: TaskState;
  events: WorkflowEvent[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "manifests" | "attempts">("overview");
  useEffect(() => setTab("overview"), [task?.id]);
  if (!task) {
    return (
      <aside className="task-detail panel">
        <div className="empty detail-empty">
          <span className="empty-icon" aria-hidden="true">⌁</span>
          <strong>Select a task</strong>
          <span>Inspect dependencies, attempts, manifests, errors, and timing.</span>
        </div>
      </aside>
    );
  }
  return (
    <aside className="task-detail panel" aria-label={`Task details for ${task.id}`}>
      <div className="detail-header">
        <div>
          <span className="eyebrow">Task detail</span>
          <h2>{task.id}</h2>
          <Badge tone={task.status}>{titleCase(task.status)}</Badge>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close task details">×</button>
      </div>
      <div className="tabs" role="tablist" aria-label="Task detail sections">
        {(["overview", "manifests", "attempts"] as const).map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "active" : ""}
            onClick={() => setTab(name)}
          >
            {titleCase(name)}
          </button>
        ))}
      </div>
      <div className="detail-body">
        {tab === "overview" && (
          <>
            <p className="task-description">{task.description || "No task description provided."}</p>
            <dl className="definition-list">
              <div><dt>Base task</dt><dd className="mono">{task.baseTaskId}</dd></div>
              <div><dt>Attempt</dt><dd>{task.attempt || "Not started"}</dd></div>
              <div><dt>Started</dt><dd>{formatDate(task.startedAt)}</dd></div>
              <div><dt>Completed</dt><dd>{formatDate(task.completedAt)}</dd></div>
              <div><dt>Duration</dt><dd>{elapsed(task.startedAt, task.completedAt)}</dd></div>
              {task.subagent && <div><dt>Subagent</dt><dd>{task.subagent}</dd></div>}
            </dl>
            <h3>Dependencies</h3>
            {task.dependsOn.length ? (
              <div className="chip-list">
                {task.dependsOn.map((dependency) => <span className="chip mono" key={dependency}>{dependency}</span>)}
              </div>
            ) : <p className="muted">No dependencies — this is a root task.</p>}
            {task.error && (
              <div className="error-box" role="alert">
                <strong>Task error</strong>
                <pre>{task.error}</pre>
              </div>
            )}
          </>
        )}
        {tab === "manifests" && (
          <>
            <h3>Input manifest</h3>
            <JsonBlock value={inputManifest(task, events)} />
            <h3>Output manifest</h3>
            <JsonBlock value={task.outputs} empty="No output artifacts recorded." />
          </>
        )}
        {tab === "attempts" && (
          <div className="attempt-list">
            {!task.attempts.length ? (
              <p className="muted inset-empty">No attempts recorded.</p>
            ) : task.attempts.map((attempt) => (
              <article className="attempt-card" key={attempt.number}>
                <div>
                  <strong>Attempt {attempt.number}</strong>
                  <Badge tone={attempt.error ? "failed" : attempt.completedAt ? "completed" : "running"}>
                    {attempt.error ? "Failed" : attempt.completedAt ? "Completed" : "Running"}
                  </Badge>
                </div>
                <dl className="definition-list">
                  <div><dt>Started</dt><dd>{formatDate(attempt.startedAt)}</dd></div>
                  <div><dt>Duration</dt><dd>{elapsed(attempt.startedAt, attempt.completedAt)}</dd></div>
                </dl>
                {attempt.error && <pre className="attempt-error">{attempt.error}</pre>}
              </article>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function Timeline({
  events,
  tasks,
  onTaskSelect,
}: {
  events: WorkflowEvent[];
  tasks: TaskState[];
  onTaskSelect: (id: string) => void;
}) {
  const [source, setSource] = useState("all");
  const [taskId, setTaskId] = useState("all");
  const [query, setQuery] = useState("");
  const sources = Array.from(new Set(events.map((event) => event.source))).sort();
  const filtered = events
    .filter((event) => source === "all" || event.source === source)
    .filter((event) => taskId === "all" || event.taskId === taskId)
    .filter((event) => {
      const text = `${event.type} ${event.taskId ?? ""} ${JSON.stringify(event.data ?? {})}`.toLowerCase();
      return text.includes(query.toLowerCase());
    })
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return (
    <section className="timeline panel" aria-labelledby="timeline-title">
      <div className="section-heading timeline-heading">
        <div>
          <span className="eyebrow">Observability</span>
          <h2 id="timeline-title">Unified event timeline</h2>
        </div>
        <Badge tone="neutral">{filtered.length} events</Badge>
      </div>
      <div className="timeline-filters">
        <label>
          <span className="sr-only">Filter events by source</span>
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="all">All sources</option>
            {sources.map((item) => <option value={item} key={item}>{titleCase(item)}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter events by task</span>
          <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
            <option value="all">All tasks</option>
            {tasks.map((task) => <option value={task.id} key={task.id}>{task.id}</option>)}
          </select>
        </label>
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <span className="sr-only">Search events</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search event data" />
        </label>
      </div>
      {!events.length ? (
        <div className="empty compact">
          <strong>Waiting for events</strong>
          <span>Live workflow, Copilot, hook, and telemetry events will stream here.</span>
        </div>
      ) : !filtered.length ? (
        <div className="empty compact">No events match these filters.</div>
      ) : (
        <ol className="event-list">
          {filtered.map((event) => (
            <li key={event.id}>
              <span className={`event-source source-${event.source}`} aria-hidden="true" />
              <div className="event-content">
                <div className="event-title">
                  <strong>{titleCase(event.type)}</strong>
                  <time dateTime={event.timestamp}>{formatDate(event.timestamp)}</time>
                </div>
                <div className="event-meta">
                  <Badge tone={event.source}>{event.source}</Badge>
                  {event.taskId && (
                    <button className="task-link mono" onClick={() => onTaskSelect(event.taskId!)}>
                      {event.taskId}
                    </button>
                  )}
                  {event.attempt !== undefined && <span>Attempt {event.attempt}</span>}
                </div>
                {event.data && Object.keys(event.data).length > 0 && (
                  <details>
                    <summary>Event data</summary>
                    <JsonBlock value={event.data} />
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Dashboard({
  run,
  events,
  busyAction,
  onAction,
}: {
  run: RunSummary;
  events: WorkflowEvent[];
  busyAction?: string;
  onAction: (action: "retry" | "resume" | "cancel", taskId?: string) => void;
}) {
  const tasks = useMemo(() => Object.values(run.state.tasks), [run.state.tasks]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  useEffect(() => {
    setSelectedTaskId((current) =>
      current && run.state.tasks[current] ? current : tasks.find((task) => task.status === "running")?.id,
    );
  }, [run.state.runId, run.state.tasks, tasks]);
  const selectedTask = selectedTaskId ? run.state.tasks[selectedTaskId] : undefined;
  return (
    <main className="dashboard">
      <RunHeader
        run={run}
        busyAction={busyAction}
        selectedTaskId={selectedTaskId}
        onAction={onAction}
      />
      <Metrics run={run} />
      <section className="workflow-section">
        <div className="graph-panel panel">
          <div className="section-heading graph-heading">
            <div>
              <span className="eyebrow">Execution map</span>
              <h2>Workflow DAG</h2>
            </div>
            <div className="status-legend" aria-label="Task status legend">
              {["running", "completed", "failed", "pending"].map((status) => (
                <span key={status}><i className={`status-fill-${status}`} />{titleCase(status)}</span>
              ))}
            </div>
          </div>
          <DagView tasks={tasks} selectedTaskId={selectedTaskId} onSelect={setSelectedTaskId} />
        </div>
        <TaskDetail task={selectedTask} events={events} onClose={() => setSelectedTaskId(undefined)} />
      </section>
      <Timeline events={events} tasks={tasks} onTaskSelect={setSelectedTaskId} />
    </main>
  );
}

export function App() {
  const dashboard = useDashboard();
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="StoryForge home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span><strong>StoryForge</strong><small>Workflow studio</small></span>
        </a>
        <div className="connection-status">
          <span className="live-dot" aria-hidden="true" />
          Local orchestration
        </div>
      </header>
      {dashboard.error && (
        <div className="global-error" role="alert">
          <span><strong>Request failed.</strong> {dashboard.error}</span>
          <button onClick={dashboard.dismissError} aria-label="Dismiss error">×</button>
        </div>
      )}
      <div className="workspace">
        <aside className="sidebar">
          <CreateRunForm
            busy={dashboard.busyAction === "create"}
            workflows={dashboard.workflows}
            onCreate={dashboard.create}
          />
          <RunList
            runs={dashboard.runs}
            selectedId={dashboard.selectedRunId}
            loading={dashboard.loading}
            onSelect={dashboard.selectRun}
          />
        </aside>
        {dashboard.loading && !dashboard.selectedRun ? (
          <main className="dashboard loading-dashboard" aria-label="Loading dashboard">
            <div className="skeleton hero-skeleton" />
            <div className="metrics-grid">
              {[0, 1, 2, 3].map((item) => <div className="skeleton metric-skeleton" key={item} />)}
            </div>
            <div className="skeleton graph-skeleton" />
          </main>
        ) : dashboard.selectedRun ? (
          <Dashboard
            key={dashboard.selectedRun.state.runId}
            run={dashboard.selectedRun}
            events={dashboard.events}
            busyAction={dashboard.busyAction}
            onAction={(action, taskId) => void dashboard.act(action, taskId)}
          />
        ) : (
          <main className="welcome">
            <div className="welcome-art" aria-hidden="true">
              <span>✦</span><span>◇</span><span>✧</span>
            </div>
            <span className="eyebrow">Local-first story orchestration</span>
            <h1>Turn one idea into a visual workflow.</h1>
            <p>Create a run to watch scenes fan out in parallel, converge into a generated story, and stream every event live.</p>
          </main>
        )}
      </div>
    </div>
  );
}
