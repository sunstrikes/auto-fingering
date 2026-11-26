import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildOpenRouterPkceChallenge,
  createOpenRouterPkceAuthUrl,
  exchangeOpenRouterPkceCode,
} from "../coach/adapters";
import {
  canUseRemoteCoach,
  polishPerformanceCueLabel,
  requestCoachFeedback,
} from "../coach/coachService";
import { buildCoachTelemetryPayload } from "../coach/payload";
import {
  clearCoachSecret,
  readCoachSecret,
  readCoachSettings,
  readPkceVerifier,
  writeCoachSecret,
  writeCoachSettings,
  writePkceVerifier,
} from "../coach/secretStorage";
import {
  buildFreeStudioOfflineTip,
  generateOfflineCoachFeedback,
} from "../coach/templates";
import type {
  CoachDiagnostic,
  CoachResult,
  CoachSettings,
  CoachTelemetryPayload,
} from "../coach/types";
import type { PerformanceCue, PerformanceCueOverrideEntry } from "../chunking/types";
import type { PracticeMode, ScoreDocument, SolveResult } from "../domain/types";
import type { AcousticProfileResult } from "../guided/acousticProfile";
import type { GuidedSessionPhase } from "../guided/pianoCommandKeys";
import type { GuidedBoutSummary } from "../store/useGuidedSessionStore";

export interface UseExternalFocusCoachOptions {
  coachFetch?: typeof fetch;
  scoreDoc: ScoreDocument | null;
  solveResult: SolveResult | null;
  scoreTitle: string;
  effectivePracticeMode: PracticeMode;
  studioMode: "free" | "guided";
  sessionPhase: GuidedSessionPhase;
  lastBoutSummary: GuidedBoutSummary | null;
  onUpsertCueOverride: (entry: PerformanceCueOverrideEntry) => void;
}

export function useExternalFocusCoach({
  coachFetch,
  scoreDoc,
  solveResult,
  scoreTitle,
  effectivePracticeMode,
  studioMode,
  sessionPhase,
  lastBoutSummary,
  onUpsertCueOverride,
}: UseExternalFocusCoachOptions) {
  const [settings, setSettings] = useState<CoachSettings>(() => readCoachSettings());
  const [apiKey, setApiKey] = useState<string>(() =>
    readCoachSecret(readCoachSettings().keyStorageMode),
  );
  const [coachResult, setCoachResult] = useState<CoachResult | null>(null);
  const [coachLoading, setCoachLoading] = useState(false);
  const [diagnostic, setDiagnostic] = useState<CoachDiagnostic | null>(null);
  const [pkceStatus, setPkceStatus] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [polishingCueId, setPolishingCueId] = useState<string | null>(null);

  const reqTokenRef = useRef(0);
  const continuousBoutCountRef = useRef(0);
  const lastSummaryRef = useRef<GuidedBoutSummary | null>(null);
  const summaryAutoFiredRef = useRef(false);

  const currentOrigin = globalThis.location?.origin;
  const userAgent = globalThis.navigator?.userAgent;

  const remoteConfigured = useMemo(
    () => canUseRemoteCoach(settings, apiKey),
    [settings, apiKey],
  );

  const transitionCues = useMemo(() => {
    if (!solveResult) return [];
    return solveResult.transitionCues.map((tc) => ({
      measureIndex: tc.measureIndex,
      kind: tc.type,
    }));
  }, [solveResult]);

  const buildPayloadFromSummary = useCallback(
    (summary: GuidedBoutSummary): CoachTelemetryPayload | null => {
      if (!summary.acousticProfile) return null;
      const tl = scoreDoc?.measureTimelines[summary.startMeasureIndex];
      const timeSignature = tl ? `${tl.timeBeats}/${tl.timeBeatType}` : "4/4";
      return buildCoachTelemetryPayload({
        profile: summary.acousticProfile,
        pieceTitle: scoreTitle || "当前乐曲",
        practiceMode: effectivePracticeMode,
        speedMultiplier: summary.speedMultiplier ?? 1.0,
        startMeasureIndex: summary.startMeasureIndex,
        endMeasureIndex: summary.endMeasureIndex,
        timeSignature,
        passIndexInSegment: summary.passAttempts,
        midiSource: "midi",
        transitionCues,
      });
    },
    [scoreDoc, scoreTitle, effectivePracticeMode, transitionCues],
  );

  const runRemoteCoach = useCallback(
    async (payload: CoachTelemetryPayload) => {
      const token = ++reqTokenRef.current;
      setCoachLoading(true);
      try {
        const res = await requestCoachFeedback({
          payload,
          settings,
          apiKey,
          coachFetch,
          currentOrigin,
          userAgent,
        });
        if (reqTokenRef.current !== token) return;
        setCoachResult(res);
        setDiagnostic(res.diagnostic ?? null);
      } finally {
        if (reqTokenRef.current === token) {
          setCoachLoading(false);
        }
      }
    },
    [settings, apiKey, coachFetch, currentOrigin, userAgent],
  );

  // Immediately render 0 ms local external-focus template whenever a continuous bout completes
  useEffect(() => {
    if (!lastBoutSummary || lastBoutSummary === lastSummaryRef.current) return;
    lastSummaryRef.current = lastBoutSummary;

    if (!lastBoutSummary.acousticProfile || lastBoutSummary.stage !== "continuous") {
      setCoachResult(null);
      return;
    }

    const payload = buildPayloadFromSummary(lastBoutSummary);
    if (!payload) return;

    continuousBoutCountRef.current += 1;
    summaryAutoFiredRef.current = false;
    setCoachResult({
      source: "template",
      response: generateOfflineCoachFeedback(payload),
      telemetry: payload,
      retried: false,
    });

    if (
      settings.cadence === "every-3-bouts" &&
      continuousBoutCountRef.current % 3 === 0 &&
      remoteConfigured
    ) {
      void runRemoteCoach(payload);
    }
  }, [lastBoutSummary, buildPayloadFromSummary, settings.cadence, remoteConfigured, runRemoteCoach]);

  // Optional end-of-session auto summary cadence
  useEffect(() => {
    if (studioMode !== "guided") {
      continuousBoutCountRef.current = 0;
      summaryAutoFiredRef.current = false;
      return;
    }
    if (
      sessionPhase === "summary" &&
      settings.cadence === "end-of-session" &&
      remoteConfigured &&
      !summaryAutoFiredRef.current &&
      lastBoutSummary?.acousticProfile
    ) {
      const payload = buildPayloadFromSummary(lastBoutSummary);
      if (payload) {
        summaryAutoFiredRef.current = true;
        void runRemoteCoach(payload);
      }
    }
  }, [
    studioMode,
    sessionPhase,
    settings.cadence,
    remoteConfigured,
    lastBoutSummary,
    buildPayloadFromSummary,
    runRemoteCoach,
  ]);

  const triggerCoach = useCallback(() => {
    if (!lastBoutSummary?.acousticProfile) return;
    const payload = buildPayloadFromSummary(lastBoutSummary);
    if (!payload) return;
    if (!remoteConfigured) {
      setCoachResult({
        source: "template",
        response: generateOfflineCoachFeedback(payload),
        telemetry: payload,
        retried: false,
      });
      return;
    }
    void runRemoteCoach(payload);
  }, [lastBoutSummary, buildPayloadFromSummary, remoteConfigured, runRemoteCoach]);

  const handleChangeSettings = useCallback(
    (next: CoachSettings) => {
      setSettings(next);
      writeCoachSettings(next);
      if (next.keyStorageMode !== settings.keyStorageMode && apiKey) {
        writeCoachSecret(apiKey, next.keyStorageMode);
      }
      setDiagnostic(null);
    },
    [settings.keyStorageMode, apiKey],
  );

  const handleChangeApiKey = useCallback(
    (nextKey: string) => {
      setApiKey(nextKey);
      writeCoachSecret(nextKey, settings.keyStorageMode);
      setDiagnostic(null);
    },
    [settings.keyStorageMode],
  );

  const handleClearApiKey = useCallback(() => {
    setApiKey("");
    clearCoachSecret();
    setDiagnostic(null);
  }, []);

  const handleStartOpenRouterPkce = useCallback(async () => {
    try {
      const pkce = await buildOpenRouterPkceChallenge();
      writePkceVerifier(pkce.codeVerifier);
      const callbackUrl = currentOrigin || "https://localhost";
      const authUrl = createOpenRouterPkceAuthUrl({
        callbackUrl,
        codeChallenge: pkce.codeChallenge,
      });
      setPkceStatus(`已生成 PKCE 授权链接（S256）：${authUrl}`);
      globalThis.open?.(authUrl, "_blank", "noopener,noreferrer");
    } catch {
      setPkceStatus("当前环境不支持 Web Crypto SHA-256，请直接粘贴 OpenRouter Key。");
    }
  }, [currentOrigin]);

  const handleExchangeOpenRouterPkceCode = useCallback(
    async (code: string) => {
      const verifier = readPkceVerifier();
      if (!verifier) {
        setPkceStatus("未找到 PKCE code_verifier，请先点击「发起 OpenRouter PKCE 授权」。");
        return;
      }
      try {
        const { key } = await exchangeOpenRouterPkceCode({
          code,
          codeVerifier: verifier,
          coachFetch,
        });
        writePkceVerifier("");
        handleChangeApiKey(key);
        setPkceStatus("OpenRouter PKCE 授权成功，Key 已安全存入当前会话。");
      } catch {
        setPkceStatus("OpenRouter PKCE 换取 Key 失败，请核对授权 code 后重试。");
      }
    },
    [coachFetch, handleChangeApiKey],
  );

  const handleTestConnection = useCallback(async () => {
    setTestingConnection(true);
    setDiagnostic(null);
    try {
      const probePayload = buildCoachTelemetryPayload({
        profile: {
          timingEvennessStatus: "green",
          timingNormNpvi: 2.5,
          secondaryDimension: "hidden",
          tertiaryDimension: "hidden",
          bleQuantizationRelaxed: false,
          pedalHardware: "none",
          capsules: [{ id: "timing", label: "节奏均匀", valueText: "nPVI 2.5", status: "green" }],
          troubleMeasures: [],
        },
        pieceTitle: "Connection Probe",
        practiceMode: "both",
        speedMultiplier: 1.0,
        startMeasureIndex: 0,
        endMeasureIndex: 0,
      });
      const res = await requestCoachFeedback({
        payload: probePayload,
        settings: { ...settings, enabled: true },
        apiKey,
        coachFetch,
        currentOrigin,
        userAgent,
      });
      if (res.diagnostic) {
        setDiagnostic(res.diagnostic);
      } else if (res.source === "fallback") {
        setDiagnostic({
          code: "network-error",
          title: "模型输出未通过封闭世界校验",
          message: res.fallbackReason ?? "已自动回退本地模板。",
        });
      } else {
        setDiagnostic(null);
        setPkceStatus("连通性检测通过：模型响应已通过封闭世界校验。");
      }
    } finally {
      setTestingConnection(false);
    }
  }, [settings, apiKey, coachFetch, currentOrigin, userAgent]);

  const polishCueLabel = useCallback(
    async (cue: PerformanceCue) => {
      setPolishingCueId(cue.cueId);
      try {
        const res = await polishPerformanceCueLabel({
          kind: cue.kind,
          measureIndex: cue.measureIndex,
          rawLabel: cue.customLabel ?? cue.label,
          settings,
          apiKey,
          coachFetch,
          currentOrigin,
        });
        onUpsertCueOverride({
          coord: cue.coord,
          kind: cue.kind,
          pinned: true,
          customLabel: res.label,
        });
      } finally {
        setPolishingCueId(null);
      }
    },
    [settings, apiKey, coachFetch, currentOrigin, onUpsertCueOverride],
  );

  const buildFreeOfflineTip = useCallback(
    (freeState: {
      profile: AcousticProfileResult;
      startMeasureIndex: number;
      endMeasureIndex: number;
      passCount: number;
    } | null): string | null => {
      if (!freeState) return null;
      const payload = buildCoachTelemetryPayload({
        profile: freeState.profile,
        pieceTitle: scoreTitle || "当前乐曲",
        practiceMode: effectivePracticeMode,
        speedMultiplier: 1.0,
        startMeasureIndex: freeState.startMeasureIndex,
        endMeasureIndex: freeState.endMeasureIndex,
        passIndexInSegment: freeState.passCount,
      });
      return buildFreeStudioOfflineTip(payload);
    },
    [scoreTitle, effectivePracticeMode],
  );

  return {
    settings,
    apiKey,
    coachResult,
    coachLoading,
    remoteConfigured,
    diagnostic,
    pkceStatus,
    testingConnection,
    polishingCueId,
    triggerCoach,
    polishCueLabel,
    buildFreeOfflineTip,
    coachSettingsProps: {
      settings,
      apiKey,
      currentOrigin,
      userAgent,
      diagnostic,
      pkceStatus,
      testingConnection,
      onChangeSettings: handleChangeSettings,
      onChangeApiKey: handleChangeApiKey,
      onClearApiKey: handleClearApiKey,
      onStartOpenRouterPkce: handleStartOpenRouterPkce,
      onExchangeOpenRouterPkceCode: handleExchangeOpenRouterPkceCode,
      onTestConnection: handleTestConnection,
    },
  };
}
