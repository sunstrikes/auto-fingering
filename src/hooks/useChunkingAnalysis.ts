import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PracticeMode, ScoreCoord, ScoreDocument, SolveResult } from "../domain/types";
import type {
  ChunkOverrides,
  PassageInstance,
  PerformanceCueKind,
  PerformanceCueOverrideEntry,
  PerformanceCueOverrides,
  StaticChunkingResult,
} from "../chunking/types";
import { analyzeMotorOverlay } from "../chunking/motorOverlay";
import {
  applyChunkOverrides,
  applyPerformanceCueOverrides,
  mergeChunksAtBoundary,
  removePerformanceCueOverride,
  resetChunkOverrides,
  resetPerformanceCueOverrides,
  splitChunkAtCoord,
  upsertPerformanceCueOverride,
} from "../chunking/chunkOverrides";
import { formatClusterInstanceLabel } from "../components/TransportPracticeBar";
import type { PieceProfile } from "../persistence/storagePort";
import {
  ChunkingCancelledError,
  createChunkingClient,
  type ChunkingClient,
  type ChunkingWorkerLike,
} from "../workers/chunkingClient";
import { handleChunkingWorkerRequest } from "../workers/chunking.worker";
import type { ChunkingWorkerRequest, ChunkingWorkerResponse } from "../workers/chunkingProtocol";

function defaultChunkingClientFactory(): ChunkingClient {
  if (typeof Worker !== "undefined") {
    return createChunkingClient();
  }
  const fallbackWorker: ChunkingWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(rawMsg: unknown) {
      const req = rawMsg as ChunkingWorkerRequest;
      const resp = handleChunkingWorkerRequest(req);
      queueMicrotask(() => {
        fallbackWorker.onmessage?.({ data: resp } as MessageEvent<ChunkingWorkerResponse>);
      });
    },
    terminate() {},
  };
  return createChunkingClient(() => fallbackWorker);
}

export interface UseChunkingAnalysisOptions {
  chunkingClientFactory?: () => ChunkingClient;
  scoreDoc: ScoreDocument | null;
  solveResult: SolveResult | null;
  practiceMode: PracticeMode;
  updatePieceProfileOverrides: (patch: {
    chunkOverrides?: PieceProfile["chunkOverrides"];
    performanceCueOverrides?: PieceProfile["performanceCueOverrides"];
  }) => void;
}

/**
 * Coordinates the static symbolic chunking Web Worker on score load, applies
 * ScoreCoord boundary-delta overrides, and runs synchronous < 2 ms analyzeMotorOverlay
 * on solve, FingerAnchor edit, HandSpanProfile change, and PracticeMode switch.
 */
export function useChunkingAnalysis({
  chunkingClientFactory = defaultChunkingClientFactory,
  scoreDoc,
  solveResult,
  practiceMode,
  updatePieceProfileOverrides,
}: UseChunkingAnalysisOptions) {
  const clientRef = useRef<ChunkingClient | null>(null);
  const updateOverridesRef = useRef(updatePieceProfileOverrides);
  updateOverridesRef.current = updatePieceProfileOverrides;
  const [rawStaticResult, setRawStaticResult] = useState<StaticChunkingResult | null>(null);
  const [chunkOverrides, setChunkOverrides] = useState<ChunkOverrides | undefined>(undefined);
  const [performanceCueOverrides, setPerformanceCueOverrides] = useState<
    PerformanceCueOverrides | undefined
  >(undefined);
  const [inspectedClusterInstanceId, setInspectedClusterInstanceId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    const client = chunkingClientFactory();
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, [chunkingClientFactory]);

  useEffect(() => {
    if (!scoreDoc || !clientRef.current) {
      setRawStaticResult(null);
      return;
    }
    let cancelled = false;
    void clientRef.current
      .analyzeStatic(scoreDoc)
      .then((res) => {
        if (!cancelled) {
          setRawStaticResult(res);
        }
      })
      .catch((err) => {
        if (!cancelled && !(err instanceof ChunkingCancelledError)) {
          setRawStaticResult(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scoreDoc]);

  const effectiveStaticResult = useMemo(
    () => (rawStaticResult ? applyChunkOverrides(rawStaticResult, chunkOverrides) : null),
    [rawStaticResult, chunkOverrides],
  );

  const motorOverlay = useMemo(
    () =>
      effectiveStaticResult && scoreDoc && solveResult
        ? analyzeMotorOverlay(effectiveStaticResult, scoreDoc, solveResult, practiceMode)
        : null,
    [effectiveStaticResult, scoreDoc, solveResult, practiceMode],
  );

  const effectiveCues = useMemo(
    () =>
      motorOverlay
        ? applyPerformanceCueOverrides(motorOverlay.performanceCues, performanceCueOverrides)
        : [],
    [motorOverlay, performanceCueOverrides],
  );

  const inspectedCluster = useMemo<{
    instance: PassageInstance | null;
    label: string | null;
  }>(() => {
    if (!inspectedClusterInstanceId || !motorOverlay) {
      return { instance: null, label: null };
    }
    for (let cIdx = 0; cIdx < motorOverlay.passageClusters.length; cIdx++) {
      const cluster = motorOverlay.passageClusters[cIdx];
      for (let iIdx = 0; iIdx < cluster.instances.length; iIdx++) {
        const inst = cluster.instances[iIdx];
        if (inst.instanceId === inspectedClusterInstanceId) {
          return {
            instance: inst,
            label: formatClusterInstanceLabel(cIdx, iIdx, inst),
          };
        }
      }
    }
    return { instance: null, label: null };
  }, [inspectedClusterInstanceId, motorOverlay]);

  const restoreProfileOverrides = useCallback((profile?: PieceProfile) => {
    setChunkOverrides(profile?.chunkOverrides);
    setPerformanceCueOverrides(profile?.performanceCueOverrides);
    setInspectedClusterInstanceId(null);
  }, []);

  const resetAllOverrides = useCallback(() => {
    setChunkOverrides(undefined);
    setPerformanceCueOverrides(undefined);
    setInspectedClusterInstanceId(null);
  }, []);

  const handleSplitChunkAtMeasure = useCallback(
    (measureIndex: number) => {
      if (!rawStaticResult) return;
      const next = splitChunkAtCoord(chunkOverrides, rawStaticResult, {
        measureIndex,
        beatNum: 0,
        beatDen: 1,
      });
      setChunkOverrides(next);
      updateOverridesRef.current({ chunkOverrides: next });
    },
    [rawStaticResult, chunkOverrides],
  );

  const handleMergeChunkBoundary = useCallback(
    (boundaryCoord: ScoreCoord) => {
      if (!rawStaticResult) return;
      const next = mergeChunksAtBoundary(chunkOverrides, rawStaticResult, boundaryCoord);
      setChunkOverrides(next);
      updateOverridesRef.current({ chunkOverrides: next });
    },
    [rawStaticResult, chunkOverrides],
  );

  const handleResetChunkOverrides = useCallback(() => {
    const next = resetChunkOverrides();
    setChunkOverrides(next);
    updateOverridesRef.current({ chunkOverrides: next });
  }, []);

  const handleUpsertCueOverride = useCallback(
    (entry: PerformanceCueOverrideEntry) => {
      const next = upsertPerformanceCueOverride(performanceCueOverrides, entry);
      setPerformanceCueOverrides(next);
      updateOverridesRef.current({ performanceCueOverrides: next });
    },
    [performanceCueOverrides],
  );

  const handleRemoveCueOverride = useCallback(
    (coord: ScoreCoord, kind?: PerformanceCueKind) => {
      const next = removePerformanceCueOverride(performanceCueOverrides, coord, kind);
      setPerformanceCueOverrides(next);
      updateOverridesRef.current({ performanceCueOverrides: next });
    },
    [performanceCueOverrides],
  );

  const handleResetCueOverrides = useCallback(() => {
    const next = resetPerformanceCueOverrides();
    setPerformanceCueOverrides(next);
    updateOverridesRef.current({ performanceCueOverrides: next });
  }, []);

  const toggleInspectClusterInstance = useCallback((instanceId: string) => {
    setInspectedClusterInstanceId((prev) => (prev === instanceId ? null : instanceId));
  }, []);

  const closeInspectCluster = useCallback(() => {
    setInspectedClusterInstanceId(null);
  }, []);

  return {
    macroSections: effectiveStaticResult?.macroSections ?? [],
    motorChunks: effectiveStaticResult?.motorChunks ?? [],
    chunkJunctions: motorOverlay?.chunkJunctions ?? [],
    passageClusters: motorOverlay?.passageClusters ?? [],
    performanceCues: effectiveCues,
    hasChunkOverrides: Boolean(
      chunkOverrides &&
        (chunkOverrides.addedBoundaries.length > 0 || chunkOverrides.removedBoundaries.length > 0),
    ),
    hasCueOverrides: Boolean(
      performanceCueOverrides && performanceCueOverrides.entries.length > 0,
    ),
    inspectedClusterInstanceId,
    inspectedClusterInstance: inspectedCluster.instance,
    inspectedClusterLabel: inspectedCluster.label,
    restoreProfileOverrides,
    resetAllOverrides,
    handleSplitChunkAtMeasure,
    handleMergeChunkBoundary,
    handleResetChunkOverrides,
    handleUpsertCueOverride,
    handleRemoveCueOverride,
    handleResetCueOverrides,
    toggleInspectClusterInstance,
    closeInspectCluster,
  };
}
