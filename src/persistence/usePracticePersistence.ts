import { useEffect, useMemo, useRef, useState } from "react";
import { useStudioStore, type StudioState } from "../store/useStudioStore";
import { createIndexedDbStorage } from "./indexedDbStorage";
import { createInMemoryStorage } from "./inMemoryStorage";
import type { PieceProfile, PracticeStoragePort } from "./storagePort";
import { isBackupReminderDue, requestPracticeDurability, saveWorkspace, type CurrentWorkspace } from "./studioPersistence";

type Prefs = CurrentWorkspace["prefs"];
interface ActivePiece {
  profile: PieceProfile;
  freePracticeMinutes: number;
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
  const startup = useRef<{ storage: PracticeStoragePort; run: Promise<void> } | undefined>(undefined);
  const queue = useRef(Promise.resolve());
  const last = useRef<{ active: ActivePiece; state: StudioState; prefs: Prefs; minutes: number } | null>(null);
  const refs = useRef({ prefs, playing });
  refs.current = { prefs, playing };
  const scoreDoc = useStudioStore((s) => s.scoreDoc);
  const rawXmlText = useStudioStore((s) => s.rawXmlText);
  const anchors = useStudioStore((s) => s.anchors);
  const removedRawAnchorUids = useStudioStore((s) => s.removedRawAnchorUids);
  const history = useStudioStore((s) => s.history);
  const exportFormat = useStudioStore((s) => s.exportFormat);
  const clock = useRef<{ active: ActivePiece; from: number } | null>(null);

  function enqueue(task: () => Promise<void>) {
    const run = queue.current.then(task);
    queue.current = run.catch(() => { setSaveError(true); });
    return run;
  }

  function persistCurrent() {
    if (!storage) return queue.current;
    const binding = activeRef.current;
    const state = useStudioStore.getState();
    if (!binding || !state.scoreDoc || !state.rawXmlText) return queue.current;
    const next = { active: binding, state, prefs: refs.current.prefs, minutes: binding.freePracticeMinutes };
    const previous = last.current;
    const opened = previous?.active !== binding;
    const sourceChanged = opened || previous?.state.rawXmlText !== next.state.rawXmlText;
    const cache = sourceChanged || previous?.state.exportFormat !== state.exportFormat;
    const draft = sourceChanged || previous?.state.anchors !== state.anchors || previous?.state.removedRawAnchorUids !== state.removedRawAnchorUids;
    const preferences = cache || previous?.prefs !== next.prefs || previous?.state.history !== state.history || next.minutes !== previous?.minutes;
    if (!preferences && !draft) return queue.current;
    last.current = next;
    return enqueue(async () => {
      binding.profile = await saveWorkspace(storage, binding.profile, {
        state, prefs: { ...next.prefs, freePracticeMinutes: next.minutes },
      }, { profile: opened, prefs: preferences, draft, cache, lastOpened: opened });
      setSaveError(false);
    });
  }

  function activate(profile: PieceProfile, freePracticeMinutes = 0) {
    const binding = { profile, freePracticeMinutes };
    activeRef.current = binding;
    setActive(binding);
  }

  useEffect(() => {
    if (!storage) return;
    let mounted = true;
    if (startup.current?.storage !== storage) {
      startup.current = { storage, run: (async () => {
        const persisted = await requestPracticeDurability(storage);
        if (!persisted && await isBackupReminderDue(storage)) {
          await storage.commit({ meta: [{ key: "lastBackupReminderAtMs", value: Date.now() }] });
          showReminder.current = true;
        }
      })() };
    }
    void startup.current.run.then(() => {
      if (mounted && showReminder.current) setBackupReminder(true);
    }).catch(() => { if (mounted) setSaveError(true); });
    return () => { mounted = false; };
  }, [storage]);
  const showReminder = useRef(false);

  useEffect(() => {
    if (!active) return;
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
    storage, activate, persistCurrent, saveError, backupReminder, dismissReminder: () => setBackupReminder(false),
    getActive: () => activeRef.current,
  };
}
