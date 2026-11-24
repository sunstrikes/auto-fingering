import { useEffect, useMemo, useRef, useState } from "react";
import { useStudioStore, type StudioState } from "../store/useStudioStore";
import { exportMxlContainer } from "../musicxml/mxl";
import { createIndexedDbStorage } from "../persistence/indexedDbStorage";
import { createInMemoryStorage } from "../persistence/inMemoryStorage";
import type { PieceProfile, PracticeStoragePort } from "../persistence/storagePort";
import { claimBackupReminder, requestPracticeDurability, saveWorkspace, type CurrentWorkspace } from "../persistence/studioPersistence";

type Prefs = CurrentWorkspace["prefs"];
interface ActivePiece {
  profile: PieceProfile;
  freePracticeMinutes: number;
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
  const last = useRef<{ active: ActivePiece; source: Omit<CurrentWorkspace, "prefs" | "repair">;
    prefs: Prefs; history: StudioState["history"]; minutes: number } | null>(null);
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

  function persistCurrent() {
    if (!storage) return queue.current;
    const binding = activeRef.current;
    const { scoreDoc, rawXmlText, history, fileName, exportFormat, mxlContainer, anchors, removedRawAnchorUids } = useStudioStore.getState();
    if (!binding || !scoreDoc || !rawXmlText) return queue.current;
    const source = { scoreDoc, rawXmlText, fileName, exportFormat, mxlContainer, anchors, removedRawAnchorUids };
    const next = { active: binding, source, history, prefs: prefsRef.current, minutes: binding.freePracticeMinutes };
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

  function activate(profile: PieceProfile, freePracticeMinutes = 0) {
    const binding = { profile, freePracticeMinutes };
    activeRef.current = binding;
    setActive(binding);
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
