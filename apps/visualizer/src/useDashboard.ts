import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreateRunRequest,
  RunSummary,
  WorkflowDefinition,
  WorkflowEvent,
} from "@story/shared";
import {
  createRun,
  getRun,
  listRuns,
  listWorkflows,
  parseEvent,
  runAction,
} from "./api.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function useDashboard() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string>();
  const [error, setError] = useState<string>();
  const refreshTimer = useRef<number | undefined>(undefined);

  const mergeRun = useCallback((summary: RunSummary) => {
    setRuns((current) =>
      [summary, ...current.filter((run) => run.state.runId !== summary.state.runId)].sort(
        (a, b) => Date.parse(b.state.updatedAt) - Date.parse(a.state.updatedAt),
      ),
    );
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await listRuns();
      setRuns(next);
      setSelectedRunId((current) =>
        current && next.some((run) => run.state.runId === current)
          ? current
          : next[0]?.state.runId,
      );
      setError(undefined);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void listWorkflows().then(setWorkflows).catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!selectedRunId) {
      setEvents([]);
      return;
    }

    let active = true;
    void getRun(selectedRunId)
      .then(({ summary, events: history }) => {
        if (!active) return;
        mergeRun(summary);
        setEvents(history);
      })
      .catch((cause: unknown) => {
        if (active) setError(messageOf(cause));
      });

    const source = new EventSource(`/api/runs/${encodeURIComponent(selectedRunId)}/events`);
    const receive = (event: MessageEvent<string>) => {
      try {
        const parsed = parseEvent(JSON.parse(event.data) as unknown);
        if (!parsed) return;
        setEvents((current) => {
          const next = current.filter((item) => item.id !== parsed.id);
          return [...next, parsed].sort(
            (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
          );
        });
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          void getRun(selectedRunId).then(({ summary }) => mergeRun(summary)).catch(() => undefined);
        }, 180);
      } catch {
        // Ignore SSE keep-alives and non-JSON messages.
      }
    };
    source.onmessage = receive;
    for (const name of ["workflow", "task", "run", "copilot", "hook", "otel"]) {
      source.addEventListener(name, receive as EventListener);
    }

    return () => {
      active = false;
      source.close();
      window.clearTimeout(refreshTimer.current);
    };
  }, [mergeRun, selectedRunId]);

  const create = useCallback(
    async (input: CreateRunRequest) => {
      setBusyAction("create");
      setError(undefined);
      try {
        const summary = await createRun(input);
        mergeRun(summary);
        setSelectedRunId(summary.state.runId);
        return true;
      } catch (cause) {
        setError(messageOf(cause));
        return false;
      } finally {
        setBusyAction(undefined);
      }
    },
    [mergeRun],
  );

  const act = useCallback(
    async (
      action: "retry" | "resume" | "cancel",
      taskId?: string,
    ) => {
      if (!selectedRunId) return;
      setBusyAction(action);
      setError(undefined);
      try {
        const summary = await runAction(selectedRunId, action, taskId);
        if (summary) mergeRun(summary);
        else mergeRun((await getRun(selectedRunId)).summary);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusyAction(undefined);
      }
    },
    [mergeRun, selectedRunId],
  );

  return {
    runs,
    workflows,
    selectedRunId,
    selectedRun: runs.find((run) => run.state.runId === selectedRunId),
    selectRun: setSelectedRunId,
    events,
    loading,
    busyAction,
    error,
    dismissError: () => setError(undefined),
    refresh,
    create,
    act,
  };
}
