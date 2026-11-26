import type { CoachProviderId, CoachSettings } from "./types";

export const DEFAULT_COACH_TIMEOUT_MS = 8000;

export const PROVIDER_DEFAULTS: Record<
  CoachProviderId,
  { label: string; endpoint: string; defaultModel: string; requiresKey: boolean }
> = {
  openrouter: { label: "OpenRouter（首推 · 支持 PKCE）", endpoint: "https://openrouter.ai/api/v1/chat/completions", defaultModel: "openai/gpt-4o-mini", requiresKey: true },
  gemini: { label: "Google Gemini（OpenAI 兼容）", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", defaultModel: "gemini-2.5-flash", requiresKey: true },
  openai: { label: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", defaultModel: "gpt-4o-mini", requiresKey: true },
  anthropic: { label: "Anthropic Claude", endpoint: "https://api.anthropic.com/v1/messages", defaultModel: "claude-sonnet-4-20250514", requiresKey: true },
  ollama: { label: "本地 Ollama（零费用隐私）", endpoint: "http://localhost:11434/v1/chat/completions", defaultModel: "qwen2.5:7b", requiresKey: false },
  custom: { label: "自定义兼容 Base URL", endpoint: "", defaultModel: "gpt-4o-mini", requiresKey: false },
};

export interface CoachAdapterRequest {
  settings: CoachSettings;
  apiKey?: string;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  coachFetch?: typeof fetch;
  timeoutMs?: number;
  refererOrigin?: string;
}

export class CoachHttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "CoachHttpError";
  }
}

function stripKeyQueryParams(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  for (const param of ["key", "api_key", "apikey", "token", "access_token"]) {
    parsed.searchParams.delete(param);
  }
  return parsed.toString();
}

function resolveCustomChatEndpoint(base: string): string {
  const clean = stripKeyQueryParams(base).replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean) || /\/openai$/i.test(clean)) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

export function resolveOpenAICompatEndpoint(provider: CoachProviderId, customBaseUrl: string): string {
  const base = customBaseUrl.trim().replace(/\/+$/, "");
  if (provider !== "custom") {
    return base ? resolveCustomChatEndpoint(base) : PROVIDER_DEFAULTS[provider].endpoint;
  }
  if (!base) throw new Error("请填写自定义兼容 Base URL");
  return resolveCustomChatEndpoint(base);
}

function parseJsonPayload<T>(rawText: string): T {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(cleaned) as T;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  coachFetch: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await coachFetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/** Thin native-fetch adapter for OpenRouter, Gemini OpenAI-compat, OpenAI, Ollama, and custom Base URLs. */
export const OpenAICompatibleAdapter = {
  async completeJson<T = Record<string, unknown>>(req: CoachAdapterRequest): Promise<T> {
    const url = resolveOpenAICompatEndpoint(req.settings.provider, req.settings.baseUrl);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (req.apiKey?.trim()) headers.Authorization = `Bearer ${req.apiKey.trim()}`;
    if (req.settings.provider === "openrouter") {
      headers["HTTP-Referer"] = req.refererOrigin ?? globalThis.location?.origin ?? "https://piano.local";
      headers["X-Title"] = "Piano Auto-Fingering Studio";
    }
    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: req.settings.model || PROVIDER_DEFAULTS[req.settings.provider].defaultModel,
          temperature: 0.3,
          messages: [
            { role: "system", content: req.systemPrompt },
            { role: "user", content: req.userPrompt },
          ],
          response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
        }),
      },
      req.coachFetch ?? globalThis.fetch,
      req.timeoutMs ?? DEFAULT_COACH_TIMEOUT_MS,
    );
    if (!resp.ok) throw new CoachHttpError(resp.status, `HTTP ${resp.status}`);
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty model response");
    return parseJsonPayload<T>(content);
  },
};

/** Thin native-fetch adapter for Anthropic Messages API with browser direct-access & version headers. */
export const AnthropicMessagesAdapter = {
  async completeJson<T = Record<string, unknown>>(req: CoachAdapterRequest): Promise<T> {
    const url = req.settings.baseUrl.trim()
      ? stripKeyQueryParams(req.settings.baseUrl.trim())
      : PROVIDER_DEFAULTS.anthropic.endpoint;
    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": (req.apiKey ?? "").trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: req.settings.model || PROVIDER_DEFAULTS.anthropic.defaultModel,
          max_tokens: 400,
          system: req.systemPrompt,
          messages: [{ role: "user", content: req.userPrompt }],
          output_config: { format: { type: "json_schema", schema: req.schema } },
        }),
      },
      req.coachFetch ?? globalThis.fetch,
      req.timeoutMs ?? DEFAULT_COACH_TIMEOUT_MS,
    );
    if (!resp.ok) throw new CoachHttpError(resp.status, `HTTP ${resp.status}`);
    const data = (await resp.json()) as { content?: Array<{ type?: string; text?: string }> };
    const textBlock = data.content?.find((b) => b.type === "text" && typeof b.text === "string");
    if (!textBlock?.text) throw new Error("Empty Anthropic response");
    return parseJsonPayload<T>(textBlock.text);
  },
};

function toBase64Url(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function buildOpenRouterPkceChallenge(verifier?: string): Promise<{
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}> {
  const codeVerifier = verifier ?? toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return { codeVerifier, codeChallenge: toBase64Url(new Uint8Array(digest)), codeChallengeMethod: "S256" };
}

export function createOpenRouterPkceAuthUrl(params: {
  callbackUrl: string;
  codeChallenge: string;
  codeChallengeMethod?: "S256";
}): string {
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", params.callbackUrl);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", params.codeChallengeMethod ?? "S256");
  return url.toString();
}

export async function exchangeOpenRouterPkceCode(params: {
  code: string;
  codeVerifier: string;
  coachFetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ key: string }> {
  const resp = await fetchWithTimeout(
    "https://openrouter.ai/api/v1/auth/keys",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: params.code, code_verifier: params.codeVerifier, code_challenge_method: "S256" }),
    },
    params.coachFetch ?? globalThis.fetch,
    params.timeoutMs ?? DEFAULT_COACH_TIMEOUT_MS,
  );
  if (!resp.ok) throw new CoachHttpError(resp.status, `PKCE exchange HTTP ${resp.status}`);
  const data = (await resp.json()) as { key?: string };
  if (!data.key) throw new Error("OpenRouter PKCE response missing key");
  return { key: data.key };
}
