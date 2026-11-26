import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AnthropicMessagesAdapter,
  OpenAICompatibleAdapter,
  buildOpenRouterPkceChallenge,
  createOpenRouterPkceAuthUrl,
  exchangeOpenRouterPkceCode,
} from "../src/coach/adapters";
import {
  polishPerformanceCueLabel,
  requestCoachFeedback,
} from "../src/coach/coachService";
import {
  buildOllamaOriginSetup,
  detectOllamaEnvironmentNotice,
  diagnoseCoachError,
} from "../src/coach/diagnostics";
import { buildCoachTelemetryPayload } from "../src/coach/payload";
import {
  SHARED_DEVICE_SECRET_WARNING,
  clearCoachSecret,
  readCoachSecret,
  readCoachSettings,
  writeCoachSecret,
  writeCoachSettings,
} from "../src/coach/secretStorage";
import type { CoachSettings } from "../src/coach/types";
import type { AcousticProfileResult } from "../src/guided/acousticProfile";
import { createInMemoryStorage } from "../src/persistence/inMemoryStorage";
import { createPracticeBackup } from "../src/persistence/backupMerge";
import { copyStorageRecord } from "../src/persistence/storageRecords";
import { BODY_MECHANICS_BLACKLIST_REGEX, verifyCoachResponse } from "../src/coach/verifier";

function makeProfile(): AcousticProfileResult {
  return {
    timingEvennessStatus: "green",
    timingNormNpvi: 3.1,
    secondaryDimension: "voicing",
    voicingDeltaDb: 1.1,
    melodyRankDominance: 0.56,
    voicingStatus: "red",
    tertiaryDimension: "pedal",
    pedalClarityRate: 0.68,
    pedalStatus: "amber",
    bleQuantizationRelaxed: false,
    pedalHardware: "continuous",
    capsules: [
      { id: "timing", label: "节奏均匀", valueText: "nPVI 3.1", status: "green" },
      { id: "voicing", label: "声部层次", valueText: "+1.1 dB · 主位 56%", status: "red" },
      { id: "pedal", label: "踏板清音", valueText: "68% (半踏)", status: "amber" },
    ],
    troubleMeasures: [
      { measureIndex: 9, severity: "red", reasons: ["声部层次偏平"] },
      { measureIndex: 10, severity: "amber", reasons: ["踏板换音浑浊"] },
    ],
  };
}

function makePayload() {
  return buildCoachTelemetryPayload({
    profile: makeProfile(),
    pieceTitle: "Nocturne Op.9 No.2",
    practiceMode: "both",
    speedMultiplier: 0.85,
    startMeasureIndex: 8,
    endMeasureIndex: 11,
  });
}

function makeMemoryWebStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

describe("Ticket #37: Coach adapters (<250 LOC), retry/fallback, secrets & diagnostics", () => {
  it("keeps src/coach/adapters.ts strictly under 250 lines with zero third-party SDK imports", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/coach/adapters.ts"),
      "utf8",
    );
    const lines = src.split(/\r?\n/).length;
    expect(lines).toBeLessThan(250);
    expect(src).not.toMatch(/from\s+["'](?:openai|@anthropic-ai\/sdk|@google\/genai)/);
  });

  it("routes OpenAI-Compatible providers (OpenRouter, Gemini, OpenAI, Ollama, custom Base URL) without ?key= in URL", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, headers, body });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  praise: "第9-12小节跑动均匀稳健。",
                  focusCues: [
                    {
                      evidenceId: "ev-m10-voicing",
                      measures: [10],
                      soundCue: "第10小节让右手高音像独唱浮在轻柔伴奏上。",
                    },
                  ],
                  nextPassListeningGoal: "下一遍听清高声部是否持续明亮。",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const cases: Array<{ provider: CoachSettings["provider"]; baseUrl: string; expectedUrl: string; key: string }> = [
      {
        provider: "openrouter",
        baseUrl: "",
        expectedUrl: "https://openrouter.ai/api/v1/chat/completions",
        key: "sk-or-test",
      },
      {
        provider: "gemini",
        baseUrl: "",
        expectedUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        key: "AIza-test",
      },
      {
        provider: "openai",
        baseUrl: "",
        expectedUrl: "https://api.openai.com/v1/chat/completions",
        key: "sk-openai-test",
      },
      {
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        expectedUrl: "http://localhost:11434/v1/chat/completions",
        key: "",
      },
      {
        provider: "custom",
        baseUrl: "https://my-gateway.example/v1",
        expectedUrl: "https://my-gateway.example/v1/chat/completions",
        key: "sk-custom-test",
      },
    ];

    for (const c of cases) {
      calls.length = 0;
      const result = await OpenAICompatibleAdapter.completeJson({
        settings: {
          enabled: true,
          provider: c.provider,
          model: "test-model",
          baseUrl: c.baseUrl,
          cadence: "on-demand",
          keyStorageMode: "session",
        },
        apiKey: c.key,
        systemPrompt: "sys",
        userPrompt: "usr",
        schemaName: "external_focus_coach",
        schema: { type: "object" },
        coachFetch: mockFetch,
        refererOrigin: "https://piano.example.com",
      });

      expect(result.praise).toContain("第9-12小节");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(c.expectedUrl);
      expect(calls[0].url).not.toContain("?key=");
      expect(calls[0].url).not.toContain(c.key || "__never__");
      if (c.key) {
        expect(calls[0].headers.Authorization).toBe(`Bearer ${c.key}`);
      }
      if (c.provider === "openrouter") {
        expect(calls[0].headers["HTTP-Referer"]).toBe("https://piano.example.com");
      }
      expect(calls[0].body.response_format).toMatchObject({ type: "json_schema" });
    }
  });

  it("supports OpenRouter OAuth PKCE auth URL generation and key exchange via coachFetch", async () => {
    const pkce = await buildOpenRouterPkceChallenge("test-verifier-123");
    const authUrl = createOpenRouterPkceAuthUrl({
      callbackUrl: "https://piano.example.com/auth/callback",
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
    });
    expect(authUrl).toContain("https://openrouter.ai/auth?");
    expect(authUrl).toContain("code_challenge_method=S256");
    expect(authUrl).toContain("callback_url=");

    const fetchSpy = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ key: "sk-or-pkce-issued" }), { status: 200 }),
    );
    const exchanged = await exchangeOpenRouterPkceCode({
      code: "auth-code-99",
      codeVerifier: "test-verifier-123",
      coachFetch: fetchSpy,
    });
    expect(exchanged.key).toBe("sk-or-pkce-issued");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/auth/keys",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends Anthropic browser direct-access & version headers and Structured Outputs schema", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch: typeof fetch = async (_input, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                praise: "第9-12小节节奏很稳。",
                focusCues: [
                  {
                    evidenceId: "ev-m10-voicing",
                    measures: [10],
                    soundCue: "第10小节让旋律清亮浮出，伴奏柔化成背景。",
                  },
                ],
                nextPassListeningGoal: "下一遍听见声部明暗拉开距离。",
              }),
            },
          ],
        }),
        { status: 200 },
      );
    };

    const res = await AnthropicMessagesAdapter.completeJson({
      settings: {
        enabled: true,
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        baseUrl: "",
        cadence: "on-demand",
        keyStorageMode: "session",
      },
      apiKey: "sk-ant-test",
      systemPrompt: "sys",
      userPrompt: "usr",
      schemaName: "external_focus_coach",
      schema: { type: "object" },
      coachFetch: mockFetch,
    });

    expect(res.praise).toContain("第9-12小节");
    expect(capturedHeaders["x-api-key"]).toBe("sk-ant-test");
    expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
    expect(capturedHeaders["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(capturedBody.output_config).toBeTruthy();
  });

  it("retries at most once on verifier violation and silently falls back to 0 ms local template on second violation", async () => {
    const payload = makePayload();
    let callCount = 0;

    // Case A: first call violates body-mechanics blacklist, second call succeeds
    const recoverFetch: typeof fetch = async () => {
      callCount += 1;
      const responseObj =
        callCount === 1
          ? {
              praise: "节奏很稳。",
              focusCues: [
                {
                  evidenceId: "ev-m10-voicing",
                  measures: [10],
                  soundCue: "第10小节放松手腕不要僵硬。",
                },
              ],
              nextPassListeningGoal: "听清高声部。",
            }
          : {
              praise: "第9-12小节流动均匀。",
              focusCues: [
                {
                  evidenceId: "ev-m10-voicing",
                  measures: [10],
                  soundCue: "第10小节让旋律像独唱浮在柔和伴奏上。",
                },
              ],
              nextPassListeningGoal: "下一遍听高声部是否持续明亮。",
            };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(responseObj) } }] }),
        { status: 200 },
      );
    };

    const recovered = await requestCoachFeedback({
      payload,
      settings: {
        enabled: true,
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        baseUrl: "",
        cadence: "on-demand",
        keyStorageMode: "session",
      },
      apiKey: "sk-or-test",
      coachFetch: recoverFetch,
    });

    expect(callCount).toBe(2);
    expect(recovered.source).toBe("llm");
    expect(recovered.retried).toBe(true);
    expect(verifyCoachResponse(recovered.response, payload).ok).toBe(true);

    // Case B: both calls violate -> max 1 retry (total 2 calls) then silent fallback to local template
    callCount = 0;
    const alwaysBadFetch: typeof fetch = async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  praise: "节奏稳定。",
                  focusCues: [
                    {
                      evidenceId: "ev-wrong-id",
                      measures: [99],
                      soundCue: "第99小节注意手指抬指发力。",
                    },
                  ],
                  nextPassListeningGoal: "听清声音。",
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const fallback = await requestCoachFeedback({
      payload,
      settings: {
        enabled: true,
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        baseUrl: "",
        cadence: "on-demand",
        keyStorageMode: "session",
      },
      apiKey: "sk-or-test",
      coachFetch: alwaysBadFetch,
    });

    expect(callCount).toBe(2);
    expect(fallback.source).toBe("fallback");
    expect(fallback.retried).toBe(true);
    expect(verifyCoachResponse(fallback.response, payload).ok).toBe(true);
    expect(
      BODY_MECHANICS_BLACKLIST_REGEX.test(JSON.stringify(fallback.response)),
    ).toBe(false);
  });

  it("aborts cleanly at 8 s timeout via AbortController and falls back silently to local template", async () => {
    vi.useFakeTimers();
    try {
      const payload = makePayload();
      let wasAborted = false;
      const hangingFetch: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            wasAborted = true;
            const abortErr = new Error("Aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          });
        });

      const promise = requestCoachFeedback({
        payload,
        settings: {
          enabled: true,
          provider: "openrouter",
          model: "openai/gpt-4o-mini",
          baseUrl: "",
          cadence: "on-demand",
          keyStorageMode: "session",
        },
        apiKey: "sk-or-test",
        coachFetch: hangingFetch,
      });

      await vi.advanceTimersByTimeAsync(8001);
      const res = await promise;
      expect(wasAborted).toBe(true);
      expect(res.source).toBe("fallback");
      expect(res.diagnostic?.code).toBe("timeout");
      expect(verifyCoachResponse(res.response, payload).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("polishes PerformanceCue external-focus imagery via BYOK and rejects body-mechanics words", async () => {
    const cleanFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ label: "听见新声部清澈转弯" }) } }],
        }),
        { status: 200 },
      );

    const okPolish = await polishPerformanceCueLabel({
      kind: "switch",
      measureIndex: 9,
      rawLabel: "分叉口",
      settings: {
        enabled: true,
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        baseUrl: "",
        cadence: "on-demand",
        keyStorageMode: "session",
      },
      apiKey: "sk-or-test",
      coachFetch: cleanFetch,
    });
    expect(okPolish.source).toBe("llm");
    expect(okPolish.label).toBe("听见新声部清澈转弯");

    const dirtyFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ label: "五指发力抬指别僵硬" }) } }],
        }),
        { status: 200 },
      );
    const rejectedPolish = await polishPerformanceCueLabel({
      kind: "switch",
      measureIndex: 9,
      rawLabel: "分叉口",
      settings: {
        enabled: true,
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        baseUrl: "",
        cadence: "on-demand",
        keyStorageMode: "session",
      },
      apiKey: "sk-or-test",
      coachFetch: dirtyFetch,
    });
    expect(rejectedPolish.source).toBe("fallback");
    expect(BODY_MECHANICS_BLACKLIST_REGEX.test(rejectedPolish.label)).toBe(false);
  });

  it("stores API secrets in sessionStorage by default, supports opt-in localStorage, and bans secrets from IndexedDB & JSON backups", async () => {
    const session = makeMemoryWebStorage();
    const local = makeMemoryWebStorage();

    writeCoachSecret("sk-secret-abc", "session", {
      sessionStorage: session,
      localStorage: local,
    });
    expect(readCoachSecret("session", { sessionStorage: session, localStorage: local })).toBe(
      "sk-secret-abc",
    );
    expect(Object.keys(local.dump())).toHaveLength(0);

    // Opt-in localStorage persistence moves key cleanly out of sessionStorage
    writeCoachSecret("sk-secret-abc", "local", {
      sessionStorage: session,
      localStorage: local,
    });
    expect(readCoachSecret("local", { sessionStorage: session, localStorage: local })).toBe(
      "sk-secret-abc",
    );
    expect(Object.keys(session.dump())).toHaveLength(0);
    expect(SHARED_DEVICE_SECRET_WARNING).toContain("公共");

    clearCoachSecret({ sessionStorage: session, localStorage: local });
    expect(readCoachSecret("local", { sessionStorage: session, localStorage: local })).toBe("");

    // Non-secret settings never write API keys and normalize cadence
    writeCoachSettings(
      {
        enabled: true,
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        baseUrl: "",
        cadence: "every-3-bouts",
        keyStorageMode: "session",
      },
      { localStorage: local },
    );
    const loadedSettings = readCoachSettings({ localStorage: local });
    expect(loadedSettings.cadence).toBe("every-3-bouts");
    expect(JSON.stringify(local.dump())).not.toContain("sk-secret");

    // Storage record guard & JSON backup strictly strip/ban BYOK fields
    const dirtyPrefs = copyStorageRecord("workspacePrefs", {
      scopeKey: "__global__",
      apiKey: "sk-leaked",
      byokKey: "sk-leaked-2",
    } as never);
    expect(JSON.stringify(dirtyPrefs)).not.toContain("sk-leaked");

    const storage = createInMemoryStorage();
    await storage.commit({ workspacePrefs: [dirtyPrefs] });
    const backup = await createPracticeBackup(storage);
    expect(backup.fullJson).not.toContain("sk-leaked");
    expect(backup.metadataOnlyJson).not.toContain("sk-leaked");
  });

  it("provides exact-origin OLLAMA_ORIGINS (forbidding *), Chrome 142+ LNA / Safari notices, and OpenAI 401 missing-CORS diagnostics", () => {
    const setup = buildOllamaOriginSetup("https://piano.cishoon.top/practice?foo=1");
    expect(setup.origin).toBe("https://piano.cishoon.top");
    expect(setup.envVarLine).toBe('OLLAMA_ORIGINS="https://piano.cishoon.top"');
    expect(setup.envVarLine).not.toContain("*");
    expect(setup.macCommand).toContain('launchctl setenv OLLAMA_ORIGINS "https://piano.cishoon.top"');

    const chromeNotice = detectOllamaEnvironmentNotice({
      currentOrigin: "https://piano.cishoon.top",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    });
    expect(chromeNotice?.code).toBe("chrome-lna-permission");
    expect(chromeNotice?.message).toContain("loopback-network");

    const safariNotice = detectOllamaEnvironmentNotice({
      currentOrigin: "https://piano.cishoon.top",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    });
    expect(safariNotice?.code).toBe("safari-mixed-content");
    expect(safariNotice?.message).toContain("Safari");

    const openaiDiag = diagnoseCoachError({
      provider: "openai",
      error: new TypeError("Failed to fetch"),
      currentOrigin: "https://piano.cishoon.top",
    });
    expect(openaiDiag.code).toBe("openai-401-or-cors");
    expect(openaiDiag.message).toContain("401");
    expect(openaiDiag.message).toContain("CORS");

    const ollamaDiag = diagnoseCoachError({
      provider: "ollama",
      error: new TypeError("Failed to fetch"),
      currentOrigin: "https://piano.cishoon.top",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    });
    expect(ollamaDiag.code).toBe("ollama-origin-cors");
    expect(ollamaDiag.command).toBe('OLLAMA_ORIGINS="https://piano.cishoon.top"');
    expect(ollamaDiag.hint).toContain("loopback-network");
  });
});
