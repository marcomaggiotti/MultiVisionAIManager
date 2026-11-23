import { useCallback, useEffect, useRef, useState } from "react";
import { VlmInput, WorkflowGraph, WorkflowRun, answerRun, getRun, startRun, stopRun } from "./types";

const POLL_MS = 600;

/** A workflow run on the manager: start it, follow it (polling), answer its questions, stop it. */
export function useRun() {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const clearTimer = () => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; };
  const follow = useCallback((runId: string) => {
    clearTimer();
    timer.current = window.setTimeout(async () => {
      try {
        const latest = await getRun(runId);
        setRun((current) => ({ ...latest, pictures: current?.pictures }));
        if (latest.status === "running") follow(runId);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }, POLL_MS);
  }, []);
  useEffect(() => clearTimer, []);

  const act = async (action: () => Promise<WorkflowRun>, keepPictures = true) => {
    setBusy(true);
    setError(null);
    try {
      const latest = await action();
      setRun((current) => ({ ...latest, pictures: latest.pictures ?? (keepPictures ? current?.pictures : undefined) }));
      if (latest.status === "running") follow(latest.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    setBusy(false);
  };

  return {
    run, error, busy,
    start: (graph: WorkflowGraph, input: VlmInput | null) => act(() => startRun(graph, input), false),
    answer: (text: string) => run && act(() => answerRun(run.id, text)),
    stop: () => run && act(() => stopRun(run.id)),
    clear: () => { clearTimer(); setRun(null); setError(null); },
  };
}

export type RunControls = ReturnType<typeof useRun>;
