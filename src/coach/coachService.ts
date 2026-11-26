import type { PerformanceCueKind } from "../chunking/types";
import {
  AnthropicMessagesAdapter,
  CoachHttpError,
  DEFAULT_COACH_TIMEOUT_MS,
  OpenAICompatibleAdapter,
  PROVIDER_DEFAULTS,
} from "./adapters";
import { diagnoseCoachError } from "./diagnostics";
import {
  buildOfflineExternalFocusCueLabel,
  generateOfflineCoachFeedback,
} from "./templates";
import type {
  CoachResponse,
  CoachResult,
  CoachSettings,
  CoachTelemetryPayload,
} from "./types";
import {
  normalizeCoachResponse,
  verifyCoachResponse,
  verifyPerformanceCueLabel,
} from "./verifier";

export const COACH_SYSTEM_PROMPT = [
  "你是专注于「外部注意焦点（External Focus of Attention）」的钢琴声学教练。",
  "必须严格遵守以下规则：",
  "1. 封闭世界：只能引用输入 evidences 和 strengthAnchor 中出现的 evidenceId、1-based 小节号与客观声学事实。若 evidences 为空，focusCues 必须为空数组 []。",
  "2. 外部注意：所有 soundCue 与 nextPassListeningGoal 必须指向声音效果、乐句线条、声部距离感、和声清澈度或琴键/踏板发声结果。",
  "3. 严禁身体部位微操词（禁止出现：手腕、手指、指尖、指关节、掌关节、虎口、小臂、手臂、肩膀、肌肉、四指、五指、大拇指、抬指、塌指、发力、僵硬）。",
  "4. 极简规范：praise + focusCues + nextPassListeningGoal 总中文字数不超过 140 字。",
].join("\n");

export const COACH_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["praise", "focusCues", "nextPassListeningGoal"],
  properties: {
    praise: {
      type: "string",
      description: "1 句基于 strengthAnchor 的声音肯定（不超过 30 中文字）",
    },
    focusCues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId", "measures", "soundCue"],
        properties: {
          evidenceId: { type: "string" },
          measures: { type: "array", items: { type: "integer" } },
          soundCue: {
            type: "string",
            description: "指向声音、乐句、和声清澈度的外部注意提示（不超过 45 中文字）",
          },
        },
      },
    },
    nextPassListeningGoal: {
      type: "string",
      description: "下一遍用耳朵自检的目标（不超过 35 中文字）",
    },
  },
};

export const CUE_POLISH_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["label"],
  properties: {
    label: {
      type: "string",
      description: "不超过 16 个中文字的外部注意记忆口诀（禁止任何身体部位/手指词）",
    },
  },
};

export function canUseRemoteCoach(settings: CoachSettings, apiKey: string): boolean {
  if (!settings.enabled) return false;
  if (settings.provider === "custom") {
    return settings.baseUrl.trim().length > 0;
  }
  if (!PROVIDER_DEFAULTS[settings.provider].requiresKey) {
    return true;
  }
  return apiKey.trim().length > 0;
}

function callConfiguredAdapter<T>(params: {
  settings: CoachSettings;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  coachFetch?: typeof fetch;
  timeoutMs?: number;
  currentOrigin?: string;
}): Promise<T> {
  const adapter =
    params.settings.provider === "anthropic"
      ? AnthropicMessagesAdapter
      : OpenAICompatibleAdapter;
  return adapter.completeJson<T>({
    settings: params.settings,
    apiKey: params.apiKey,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
    schemaName: params.schemaName,
    schema: params.schema,
    coachFetch: params.coachFetch,
    timeoutMs: params.timeoutMs ?? DEFAULT_COACH_TIMEOUT_MS,
    refererOrigin: params.currentOrigin,
  });
}

export interface RequestCoachFeedbackInput {
  payload: CoachTelemetryPayload;
  settings: CoachSettings;
  apiKey?: string;
  coachFetch?: typeof fetch;
  timeoutMs?: number;
  currentOrigin?: string;
  userAgent?: string;
}

/**
 * Generates External-Focus Coach feedback. Returns 0 ms deterministic Chinese templates
 * when offline or unconfigured; when BYOK/Ollama is enabled, verifies closed-world
 * evidenceId/measure whitelists and body-mechanics blacklist, retries at most once on
 * violation, and silently falls back to the local template on second violation, error, or 8 s timeout.
 */
export async function requestCoachFeedback(
  input: RequestCoachFeedbackInput,
): Promise<CoachResult> {
  const {
    payload,
    settings,
    apiKey = "",
    coachFetch,
    timeoutMs = DEFAULT_COACH_TIMEOUT_MS,
    currentOrigin,
    userAgent,
  } = input;

  const localTemplate = generateOfflineCoachFeedback(payload);
  if (!canUseRemoteCoach(settings, apiKey)) {
    return {
      source: "template",
      response: localTemplate,
      telemetry: payload,
      retried: false,
    };
  }

  const baseUserPrompt = `请基于以下封闭世界演奏遥测摘要生成中文外部注意教练反馈：\n${JSON.stringify(payload)}`;
  let retried = false;

  try {
    const firstCandidate = await callConfiguredAdapter<CoachResponse>({
      settings,
      apiKey,
      systemPrompt: COACH_SYSTEM_PROMPT,
      userPrompt: baseUserPrompt,
      schemaName: "external_focus_coach",
      schema: COACH_RESPONSE_JSON_SCHEMA,
      coachFetch,
      timeoutMs,
      currentOrigin,
    });

    const firstCheck = verifyCoachResponse(firstCandidate, payload);
    if (firstCheck.ok) {
      return {
        source: "llm",
        response: normalizeCoachResponse(firstCandidate),
        telemetry: payload,
        retried: false,
      };
    }

    retried = true;
    const retryPrompt = `${baseUserPrompt}\n\n上次输出未通过校验（${firstCheck.violations.join("; ")}）。请严格修正：仅引用输入 evidenceId 与小节号、禁止一切身体部位词、总中文字数不超过 140 字。`;
    const secondCandidate = await callConfiguredAdapter<CoachResponse>({
      settings,
      apiKey,
      systemPrompt: COACH_SYSTEM_PROMPT,
      userPrompt: retryPrompt,
      schemaName: "external_focus_coach",
      schema: COACH_RESPONSE_JSON_SCHEMA,
      coachFetch,
      timeoutMs,
      currentOrigin,
    });

    const secondCheck = verifyCoachResponse(secondCandidate, payload);
    if (secondCheck.ok) {
      return {
        source: "llm",
        response: normalizeCoachResponse(secondCandidate),
        telemetry: payload,
        retried: true,
      };
    }

    return {
      source: "fallback",
      response: localTemplate,
      telemetry: payload,
      retried: true,
      fallbackReason: "verifier-rejected",
      violations: secondCheck.violations,
    };
  } catch (err) {
    const statusCode = err instanceof CoachHttpError ? err.statusCode : undefined;
    const diagnostic = diagnoseCoachError({
      provider: settings.provider,
      error: err,
      statusCode,
      currentOrigin,
      userAgent,
    });
    return {
      source: "fallback",
      response: localTemplate,
      telemetry: payload,
      retried,
      fallbackReason: err instanceof Error ? err.message : String(err),
      diagnostic,
    };
  }
}

export interface PolishPerformanceCueInput {
  kind: PerformanceCueKind;
  measureIndex: number;
  rawLabel?: string;
  settings: CoachSettings;
  apiKey?: string;
  coachFetch?: typeof fetch;
  timeoutMs?: number;
  currentOrigin?: string;
}

export interface PolishPerformanceCueResult {
  source: "template" | "llm" | "fallback";
  label: string;
  retried: boolean;
}

/**
 * 1-click BYOK/Ollama PerformanceCue external-focus imagery polish with strict
 * body-mechanics blacklist enforcement and offline template fallback.
 */
export async function polishPerformanceCueLabel(
  input: PolishPerformanceCueInput,
): Promise<PolishPerformanceCueResult> {
  const offlineLabel = buildOfflineExternalFocusCueLabel(
    input.kind,
    input.measureIndex,
    input.rawLabel,
  );
  const apiKey = input.apiKey ?? "";
  if (!canUseRemoteCoach(input.settings, apiKey)) {
    return { source: "template", label: offlineLabel, retried: false };
  }

  const cueSystemPrompt = [
    "你是钢琴记忆检索路标润色助手。",
    "请将给定的小节结构/技术路标改写为不超过 14 个中文字的「外部注意声音/画面意象口诀」。",
    "严禁出现任何身体部位或手指微操词（如手指、手腕、四指、五指、抬指、发力、僵硬等）。",
  ].join("\n");
  const basePrompt = `第 ${input.measureIndex + 1} 小节 · 类型 ${input.kind} · 原标签：${input.rawLabel || "无"}`;

  let retried = false;
  try {
    const first = await callConfiguredAdapter<{ label?: string }>({
      settings: input.settings,
      apiKey,
      systemPrompt: cueSystemPrompt,
      userPrompt: basePrompt,
      schemaName: "performance_cue_polish",
      schema: CUE_POLISH_JSON_SCHEMA,
      coachFetch: input.coachFetch,
      timeoutMs: input.timeoutMs ?? DEFAULT_COACH_TIMEOUT_MS,
      currentOrigin: input.currentOrigin,
    });
    const firstLabel = typeof first.label === "string" ? first.label.trim() : "";
    const firstCheck = verifyPerformanceCueLabel(firstLabel);
    if (firstCheck.ok) {
      return { source: "llm", label: firstLabel, retried: false };
    }

    retried = true;
    const second = await callConfiguredAdapter<{ label?: string }>({
      settings: input.settings,
      apiKey,
      systemPrompt: cueSystemPrompt,
      userPrompt: `${basePrompt}\n上次口诀违规（${firstCheck.violations.join("; ")}），请改用纯粹声音/呼吸意象且 <= 14 中文字。`,
      schemaName: "performance_cue_polish",
      schema: CUE_POLISH_JSON_SCHEMA,
      coachFetch: input.coachFetch,
      timeoutMs: input.timeoutMs ?? DEFAULT_COACH_TIMEOUT_MS,
      currentOrigin: input.currentOrigin,
    });
    const secondLabel = typeof second.label === "string" ? second.label.trim() : "";
    if (verifyPerformanceCueLabel(secondLabel).ok) {
      return { source: "llm", label: secondLabel, retried: true };
    }
    return { source: "fallback", label: offlineLabel, retried: true };
  } catch {
    return { source: "fallback", label: offlineLabel, retried };
  }
}
