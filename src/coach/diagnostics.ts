import type { CoachDiagnostic, CoachProviderId } from "./types";

export interface OllamaOriginSetup {
  origin: string;
  envVarLine: string;
  macCommand: string;
  linuxCommand: string;
  warning: string;
}

/**
 * Normalizes a browser origin string and rejects wildcards (`*`) so Ollama
 * never opens localhost GPU endpoints to arbitrary third-party tabs.
 */
export function normalizeExactOrigin(rawOrigin?: string): string {
  const candidate = (rawOrigin ?? globalThis.location?.origin ?? "http://localhost:5173").trim();
  if (!candidate || candidate === "*" || candidate.includes("*")) {
    return "http://localhost:5173";
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
  } catch {
    // Fallback for bare origin strings
  }
  return "http://localhost:5173";
}

/**
 * Generates exact-origin `OLLAMA_ORIGINS="https://<current-origin>"` setup commands.
 */
export function buildOllamaOriginSetup(currentOrigin?: string): OllamaOriginSetup {
  const origin = normalizeExactOrigin(currentOrigin);
  return {
    origin,
    envVarLine: `OLLAMA_ORIGINS="${origin}"`,
    macCommand: `launchctl setenv OLLAMA_ORIGINS "${origin}"`,
    linuxCommand: `OLLAMA_ORIGINS="${origin}" ollama serve`,
    warning: "请务必仅放行当前精确域名，严禁设为 *（防止其他任意网页静默盗用本机算力）。",
  };
}

/**
 * Returns browser-specific Local Network Access (Chrome 142+) or Safari Mixed Content notices
 * when connecting from an HTTPS static SPA to local http://localhost:11434 Ollama.
 */
export function detectOllamaEnvironmentNotice(params?: {
  currentOrigin?: string;
  userAgent?: string;
}): CoachDiagnostic | null {
  const origin = normalizeExactOrigin(params?.currentOrigin);
  const ua = params?.userAgent ?? globalThis.navigator?.userAgent ?? "";
  const isHttps = origin.startsWith("https://");

  const isSafari =
    /\bSafari\b/i.test(ua) && !/(Chrome|Chromium|Edg|CriOS|FxiOS|OPR)/i.test(ua);
  if (isHttps && isSafari) {
    return {
      code: "safari-mixed-content",
      title: "Safari 不支持 HTTPS 直连本地 Ollama",
      message:
        "Safari 会严格拦截 https:// 页面请求 http://localhost（Mixed Content），且不支持 Web MIDI API。请改用 Chrome 或 Edge，或使用 OpenRouter / Gemini。",
    };
  }

  const chromeMatch = ua.match(/(?:Chrome|Edg)\/(\d+)/i);
  const chromeMajor = chromeMatch ? Number.parseInt(chromeMatch[1], 10) : 0;
  if (isHttps && (chromeMajor >= 142 || chromeMajor === 0)) {
    return {
      code: "chrome-lna-permission",
      title: "Chrome 142+ Local Network Access（loopback-network）权限指引",
      message:
        "Chrome 142+ 首次从 HTTPS 站点连接本机 Ollama 时，会弹出「允许连接本机上的应用 (loopback-network)」权限提示，请点击「允许」并确保已配置 OLLAMA_ORIGINS。",
    };
  }

  return null;
}

export interface DiagnoseCoachErrorInput {
  provider: CoachProviderId;
  error: unknown;
  statusCode?: number;
  currentOrigin?: string;
  userAgent?: string;
}

/**
 * Produces actionable browser-direct diagnostics for OpenAI 401 missing-CORS opaque failures,
 * Ollama origin/LNA/Safari blocks, Anthropic browser headers, and 8 s timeouts.
 */
export function diagnoseCoachError(input: DiagnoseCoachErrorInput): CoachDiagnostic {
  const { provider, error, statusCode, currentOrigin, userAgent } = input;
  const errName = error instanceof Error ? error.name : "";
  const errMsg = error instanceof Error ? error.message : String(error ?? "");
  const isAbort = errName === "AbortError" || /abort|timeout/i.test(errMsg);
  if (isAbort) {
    return {
      code: "timeout",
      title: "请求超时（8 s）",
      message: "教练接口超过 8 秒未返回，已静默回退至 0 ms 本地外部注意模板。",
    };
  }

  const isOpaqueFetchFailure =
    error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(errMsg);

  if (provider === "openai" && (statusCode === 401 || isOpaqueFetchFailure)) {
    return {
      code: "openai-401-or-cors",
      title: "OpenAI 请求被拦截（可能是 401 缺失 CORS 头）",
      message:
        "浏览器抛出 TypeError: Failed to fetch 或 HTTP 401：OpenAI 官方在 401（Key 无效或额度不足）时省略了 CORS 响应头（Access-Control-Allow-Origin），导致浏览器吞掉原始报错。请核对 API Key、改用 OpenRouter / Gemini，或配置自定义兼容 Base URL。",
      hint: "推荐使用原生全CORS放行且支持 PKCE 的 OpenRouter。",
    };
  }

  if (provider === "ollama") {
    const setup = buildOllamaOriginSetup(currentOrigin);
    const envNotice = detectOllamaEnvironmentNotice({ currentOrigin, userAgent });
    return {
      code: envNotice?.code === "safari-mixed-content" ? "safari-mixed-content" : "ollama-origin-cors",
      title:
        envNotice?.code === "safari-mixed-content"
          ? envNotice.title
          : "本地 Ollama 连接受阻（CORS / LNA）",
      message:
        envNotice?.code === "safari-mixed-content"
          ? envNotice.message
          : `请确认本地 Ollama 已运行并设置精确源 ${setup.envVarLine}（禁止 *），然后重启 Ollama。`,
      command: setup.envVarLine,
      hint: envNotice?.code === "chrome-lna-permission" ? envNotice.message : setup.macCommand,
    };
  }

  if (provider === "anthropic" && (statusCode === 401 || statusCode === 403 || isOpaqueFetchFailure)) {
    return {
      code: "anthropic-cors-or-key",
      title: "Anthropic 直连校验失败",
      message:
        "请确认 API Key 有效；浏览器直连依赖请求头 anthropic-dangerous-direct-browser-access: true（内置适配器已自动附带）。",
    };
  }

  if (statusCode !== undefined && statusCode >= 400) {
    return {
      code: "http-error",
      title: `接口返回 HTTP ${statusCode}`,
      message: `请求返回状态码 ${statusCode}，已静默回退至本地外部注意模板。`,
    };
  }

  return {
    code: "network-error",
    title: "网络连接异常",
    message: errMsg || "无法连接至所选教练服务，已静默回退至本地外部注意模板。",
  };
}
