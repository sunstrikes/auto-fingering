import type { PracticeMode } from "../domain/types";
import type { PedalHardwareKind } from "../guided/acousticProfile";

export type CoachEvidenceDimension =
  | "evenness"
  | "voicing"
  | "handSync"
  | "articulation"
  | "pedalClarity";

export type CoachEvidenceSeverity = "issue" | "watch";

export interface CoachEvidence {
  id: string;
  dimension: CoachEvidenceDimension;
  severity: CoachEvidenceSeverity;
  /** 1-based measure numbers within piece.measureRange. */
  measures: number[];
  fact: string;
  cues: string[];
}

export interface CoachStrengthAnchor {
  id: string;
  fact: string;
  /** 1-based measure numbers anchored by this strength. */
  measures?: number[];
}

export interface CoachTelemetryPayload {
  schemaVersion: "1.0";
  piece: {
    title: string;
    practiceMode: PracticeMode;
    speedMultiplier: number;
    /** 1-based inclusive measure range [startMeasure, endMeasure]. */
    measureRange: [number, number];
    timeSignature: string;
    passIndexInSegment: number;
    midiSource: "midi" | "virtual" | "qwerty" | "mixed";
    pedalHardware: PedalHardwareKind;
  };
  metrics: {
    evenness: {
      status: "ok" | "watch" | "issue";
      nPVI: number;
      worstMeasure?: number;
    };
    voicing: {
      status: "ok" | "watch" | "issue" | "skipped";
      deltaDb?: number;
      melodyDominancePct?: number;
      reason?: string;
    };
    handSync: {
      status: "ok" | "watch" | "issue" | "skipped";
      medianEffOffsetMs?: number;
      heavySplitPct?: number;
      reason?: string;
    };
    articulation: {
      status: "ok" | "watch" | "issue" | "skipped";
      kor?: number;
      reason?: string;
    };
    pedalClarity: {
      status: "ok" | "watch" | "issue" | "skipped";
      cleanChangePct?: number;
      reason?: string;
    };
  };
  evidences: CoachEvidence[];
  strengthAnchor: CoachStrengthAnchor;
}

export interface CoachFocusCue {
  evidenceId: string;
  /** 1-based measure numbers matching the referenced evidence. */
  measures: number[];
  soundCue: string;
}

export interface CoachResponse {
  praise: string;
  focusCues: CoachFocusCue[];
  nextPassListeningGoal: string;
}

export interface CoachVerificationResult {
  ok: boolean;
  violations: string[];
}

export type CoachProviderId =
  | "openrouter"
  | "gemini"
  | "openai"
  | "anthropic"
  | "ollama"
  | "custom";

export type CoachCadence = "on-demand" | "end-of-session" | "every-3-bouts";

export type KeyStorageMode = "session" | "local";

export interface CoachSettings {
  enabled: boolean;
  provider: CoachProviderId;
  model: string;
  baseUrl: string;
  cadence: CoachCadence;
  keyStorageMode: KeyStorageMode;
}

export type CoachDiagnosticCode =
  | "openai-401-or-cors"
  | "ollama-origin-cors"
  | "chrome-lna-permission"
  | "safari-mixed-content"
  | "anthropic-cors-or-key"
  | "timeout"
  | "http-error"
  | "network-error";

export interface CoachDiagnostic {
  code: CoachDiagnosticCode;
  title: string;
  message: string;
  command?: string;
  hint?: string;
}

export interface CoachResult {
  source: "template" | "llm" | "fallback";
  response: CoachResponse;
  telemetry: CoachTelemetryPayload;
  retried: boolean;
  fallbackReason?: string;
  violations?: string[];
  diagnostic?: CoachDiagnostic;
}
