import { useEffect, useMemo, useRef, useState } from "react";
import { useStudioStore, type StudioState } from "../store/useStudioStore";
import { exportMxlContainer } from "../musicxml/mxl";
import { importPracticeBackup } from "../persistence/backupMerge";
import { createIndexedDbStorage } from "../persistence/indexedDbStorage";
import { createInMemoryStorage } from "../persistence/inMemoryStorage";
import type { PieceProfile, PracticeStoragePort } from "../persistence/storagePort";
import { claimBackupReminder, requestPracticeDurability, saveWorkspace, type CurrentWorkspace } from "../persistence/studioPersistence";

type Prefs = CurrentWorkspace["prefs"];
interface ActivePiece {
  profile: PieceProfile;
  freePracticeMinutes: number;
  needsBaseline: boolean;
}

interface WorkspaceSnapshot {
  active: ActivePiece;
  source: Omit<CurrentWorkspace, "prefs" | "repair"> & Pick<StudioState, "mxlContainer">;
  prefs: Prefs;
  history: StudioState["history"];
  minutes: number;
}

function repairInHistory(rawXmlText: string, history: StudioState["history"]): CurrentWorkspace["repair"] {
  const isAlternate = (snapshot: StudioState["history"]["past"][number]) =>
    snapshot.scoreDoc && snapshot.rawXmlText && snapshot.rawXmlText !== rawXmlText;
  const future = history.future.find(isAlternate);
  // Future takes precedence after an Undo, so the repair can be redone after refresh.
  const alternate = future ?? [...history.past].reverse().find(isAlternate);
  if (!alternate?.scoreDoc || !alternate.rawXmlText) return undefined;
  return { direction: future ? "redo" : "undo", alternate: {
    scoreDoc: alternate.scoreDoc, rawXmlText: alternate.rawXmlText,
    anchors: alternate.anchors, removedRawAnchorUids: alternate.removedRawAnchorUids,
  } };
}

/** Root-owned persistence. Every local write is ordered; playback does not
 * write Practice Events or run an IndexedDB transaction for every frame. */
export function usePracticePersistence(injected: PracticeStoragePort | null | undefined, prefs: Prefs, playing: boolean) {
  const storage = useMemo(() => injected === undefined
    ? globalThis.indexedDB ? createIndexedDbStorage() : createInMemoryStorage()
    : injected, [injected]);
  const [active, setActive] = useState<ActivePiece | null>(null);
  const activeRef = useRef(active);
  const [saveError, setSaveError] = useState(false);
  const [backupReminder, setBackupReminder] = useState(false);
  const mounted = useRef(false);
  const startup = useRef<{ storage: PracticeStoragePort; run: Promise<boolean> } | undefined>(undefined);
  const queue = useRef(Promise.resolve());
  const last = useRef<WorkspaceSnapshot | null>(null);
  const importing = useRef(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const scoreDoc = useStudioStore((s) => s.scoreDoc);
  const rawXmlText = useStudioStore((s) => s.rawXmlText);
  const anchors = useStudioStore((s) => s.anchors);
  const removedRawAnchorUids = useStudioStore((s) => s.removedRawAnchorUids);
  const history = useStudioStore((s) => s.history);
  const exportFormat = useStudioStore((s) => s.exportFormat);
  const clock = useRef<{ active: ActivePiece; from: number } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function enqueue(task: () => Promise<void>) {
    const run = queue.current.then(task);
    queue.current = run.catch(() => { if (mounted.current) setSaveError(true); });
    return run;
  }

  function snapshotCurrent(): WorkspaceSnapshot | undefined {
    const binding = activeRef.current;
    const { scoreDoc, rawXmlText, history, fileName, exportFormat, mxlContainer, anchors, removedRawAnchorUids } = useStudioStore.getState();
    if (!binding || !scoreDoc || !rawXmlText) return;
    return { active: binding, source: { scoreDoc, rawXmlText, fileName, exportFormat, mxlContainer, anchors, removedRawAnchorUids },
      history, prefs: prefsRef.current, minutes: binding.freePracticeMinutes };
  }

  function persistCurrent() {
    if (!storage || importing.current || activeRef.current?.needsBaseline) return queue.current;
    const next = snapshotCurrent();
    if (!next) return queue.current;
    const { active: binding, source, history } = next;
    const { rawXmlText, exportFormat, anchors, removedRawAnchorUids } = source;
    return enqueue(async () => {
      // Compare against the last committed snapshot, not an earlier queued attempt.
      const previous = last.current;
      const opened = previous?.active !== binding;
      const sourceChanged = opened || previous?.source.rawXmlText !== rawXmlText;
      const cache = sourceChanged || previous?.source.exportFormat !== exportFormat;
      const draft = sourceChanged || previous?.source.anchors !== anchors || previous?.source.removedRawAnchorUids !== removedRawAnchorUids;
      const preferences = cache || previous?.prefs !== next.prefs || previous?.history !== history || next.minutes !== previous?.minutes;
      if (!preferences && !draft) return;
      const { mxlContainer: container, ...workspace } = source;
      binding.profile = await saveWorkspace(storage, binding.profile, {
        ...workspace, prefs: { ...next.prefs, freePracticeMinutes: next.minutes },
        ...(preferences || cache ? { repair: repairInHistory(rawXmlText, history) } : {}),
      }, { profile: opened, prefs: preferences, draft, cache, lastOpened: opened,
        practiced: !opened && next.minutes > (previous?.minutes ?? 0) },
      (xml) => exportMxlContainer(xml, container));
      last.current = next;
      if (mounted.current) setSaveError(false);
    });
  }

  function activate(profile: PieceProfile, freePracticeMinutes = 0, mode: "open" | "restore" = "open") {
    const binding = { profile, freePracticeMinutes, needsBaseline: mode === "restore" };
    activeRef.current = binding;
    setActive(binding);
  }

  async function importBackup(json: string, restore: () => Promise<void>) {
    if (!storage || importing.current) return;
    const flush = persistCurrent();
    importing.current = true;
    try {
      await flush;
      await importPracticeBackup(storage, json);
      // Do not let the pre-import score write back after the merge (even if restore fails).
      activeRef.current = null;
      setActive(null);
      await restore();
    } finally {
      importing.current = false;
    }
  }

  useEffect(() => {
    if (!storage) {
      setBackupReminder(false);
      return;
    }
    let mounted = true;
    let checking = false;
    if (startup.current?.storage !== storage) {
      startup.current = { storage, run: requestPracticeDurability(storage) };
    }
    const durability = startup.current.run;
    const check = () => {
      if (checking) return;
      checking = true;
      void (async () => {
        if (await durability || !mounted) return;
        if (await claimBackupReminder(storage) && mounted) setBackupReminder(true);
      })().catch(() => { if (mounted) setSaveError(true); }).finally(() => { checking = false; });
    };
    const onVisibilityChange = () => { if (document.visibilityState === "visible") check(); };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mounted = false;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [storage]);
  useEffect(() => {
    if (!active || activeRef.current !== active) return;
    if (active.needsBaseline) {
      // The merged snapshot is already on disk. Capture its rendered preferences
      // as the baseline, without replacing any imported record or timestamp.
      last.current = snapshotCurrent() ?? null;
      active.needsBaseline = false;
      return;
    }
    void persistCurrent().catch(() => undefined);
  }, [active, scoreDoc, rawXmlText, anchors, removedRawAnchorUids, history, prefs, exportFormat]);

  useEffect(() => {
    if (!playing || !active) return;
    clock.current = { active, from: performance.now() };
    const tick = () => {
      const sample = clock.current;
      if (!sample || sample.active !== active) return;
      const now = performance.now();
      active.freePracticeMinutes += Math.max(0, now - sample.from) / 60000;
      sample.from = now;
      if (activeRef.current === active) void persistCurrent().catch(() => undefined);
    };
    const timer = setInterval(tick, 15000);
    globalThis.addEventListener("pagehide", tick);
    return () => {
      clearInterval(timer);
      globalThis.removeEventListener("pagehide", tick);
      tick();
      clock.current = null;
    };
  }, [storage, active, playing]);

  return {
    storage, activate, persistCurrent, importBackup, saveError, backupReminder, dismissReminder: () => setBackupReminder(false),
    getActive: () => activeRef.current,
  };
}
