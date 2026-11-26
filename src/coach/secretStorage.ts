import type {
  CoachCadence,
  CoachProviderId,
  CoachSettings,
  KeyStorageMode,
} from "./types";

export const COACH_SECRET_STORAGE_KEY = "auto_fingering_coach_secret_v1";
export const COACH_SETTINGS_STORAGE_KEY = "auto_fingering_coach_settings_v1";
export const COACH_PKCE_VERIFIER_KEY = "auto_fingering_openrouter_pkce_verifier_v1";

export const SHARED_DEVICE_SECRET_WARNING =
  "密钥仅保存在您的浏览器本地，绝不会写入 IndexedDB、导出 JSON 备份或 URL 参数；请勿在公共/共享电脑勾选「在本设备记住密钥」。";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SecretStorageDeps {
  sessionStorage?: StorageLike | null;
  localStorage?: StorageLike | null;
}

export const DEFAULT_COACH_SETTINGS: CoachSettings = {
  enabled: false,
  provider: "openrouter",
  model: "openai/gpt-4o-mini",
  baseUrl: "",
  cadence: "on-demand",
  keyStorageMode: "session",
};

function getSession(deps?: SecretStorageDeps): StorageLike | null {
  if (deps && "sessionStorage" in deps) return deps.sessionStorage ?? null;
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function getLocal(deps?: SecretStorageDeps): StorageLike | null {
  if (deps && "localStorage" in deps) return deps.localStorage ?? null;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads the BYOK API key from sessionStorage (default) or opt-in localStorage.
 * Secrets are never persisted to IndexedDB, JSON backups, or URL query strings.
 */
export function readCoachSecret(
  mode: KeyStorageMode,
  deps?: SecretStorageDeps,
): string {
  try {
    const primary = mode === "local" ? getLocal(deps) : getSession(deps);
    const val = primary?.getItem(COACH_SECRET_STORAGE_KEY);
    if (val) return val;
    const secondary = mode === "local" ? getSession(deps) : getLocal(deps);
    return mode === "local" ? secondary?.getItem(COACH_SECRET_STORAGE_KEY) ?? "" : "";
  } catch {
    return "";
  }
}

/**
 * Stores the BYOK API key strictly in the selected storage tier (`session` by default,
 * or opt-in `local`) and removes it from the other tier so downgrades wipe persistent copies.
 */
export function writeCoachSecret(
  secret: string,
  mode: KeyStorageMode,
  deps?: SecretStorageDeps,
): void {
  const trimmed = secret.trim();
  const session = getSession(deps);
  const local = getLocal(deps);
  try {
    if (!trimmed) {
      session?.removeItem(COACH_SECRET_STORAGE_KEY);
      local?.removeItem(COACH_SECRET_STORAGE_KEY);
      return;
    }
    if (mode === "local") {
      local?.setItem(COACH_SECRET_STORAGE_KEY, trimmed);
      session?.removeItem(COACH_SECRET_STORAGE_KEY);
    } else {
      session?.setItem(COACH_SECRET_STORAGE_KEY, trimmed);
      local?.removeItem(COACH_SECRET_STORAGE_KEY);
    }
  } catch {
    // ignore storage quota/security errors
  }
}

export function clearCoachSecret(deps?: SecretStorageDeps): void {
  try {
    getSession(deps)?.removeItem(COACH_SECRET_STORAGE_KEY);
    getLocal(deps)?.removeItem(COACH_SECRET_STORAGE_KEY);
  } catch {
    // ignore storage access errors
  }
}

export function writePkceVerifier(verifier: string, deps?: SecretStorageDeps): void {
  try {
    if (!verifier) {
      getSession(deps)?.removeItem(COACH_PKCE_VERIFIER_KEY);
    } else {
      getSession(deps)?.setItem(COACH_PKCE_VERIFIER_KEY, verifier);
    }
  } catch {
    // ignore
  }
}

export function readPkceVerifier(deps?: SecretStorageDeps): string {
  try {
    return getSession(deps)?.getItem(COACH_PKCE_VERIFIER_KEY) ?? "";
  } catch {
    return "";
  }
}

const VALID_PROVIDERS: ReadonlySet<CoachProviderId> = new Set([
  "openrouter",
  "gemini",
  "openai",
  "anthropic",
  "ollama",
  "custom",
]);
const VALID_CADENCES: ReadonlySet<CoachCadence> = new Set([
  "on-demand",
  "end-of-session",
  "every-3-bouts",
]);

/**
 * Reads non-secret coach preferences (provider, model, baseUrl, cadence, keyStorageMode).
 */
export function readCoachSettings(deps?: SecretStorageDeps): CoachSettings {
  try {
    const raw = getLocal(deps)?.getItem(COACH_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COACH_SETTINGS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider = VALID_PROVIDERS.has(parsed.provider as CoachProviderId)
      ? (parsed.provider as CoachProviderId)
      : DEFAULT_COACH_SETTINGS.provider;
    const cadence = VALID_CADENCES.has(parsed.cadence as CoachCadence)
      ? (parsed.cadence as CoachCadence)
      : DEFAULT_COACH_SETTINGS.cadence;
    const keyStorageMode: KeyStorageMode =
      parsed.keyStorageMode === "local" ? "local" : "session";
    return {
      enabled: Boolean(parsed.enabled),
      provider,
      model:
        typeof parsed.model === "string" && parsed.model.trim()
          ? parsed.model.trim()
          : DEFAULT_COACH_SETTINGS.model,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "",
      cadence,
      keyStorageMode,
    };
  } catch {
    return { ...DEFAULT_COACH_SETTINGS };
  }
}

/**
 * Persists strictly non-secret coach preferences (never stores API keys or tokens).
 */
export function writeCoachSettings(
  settings: CoachSettings,
  deps?: SecretStorageDeps,
): void {
  const safePayload: CoachSettings = {
    enabled: Boolean(settings.enabled),
    provider: VALID_PROVIDERS.has(settings.provider)
      ? settings.provider
      : DEFAULT_COACH_SETTINGS.provider,
    model: settings.model.trim() || DEFAULT_COACH_SETTINGS.model,
    baseUrl: settings.baseUrl.trim(),
    cadence: VALID_CADENCES.has(settings.cadence)
      ? settings.cadence
      : DEFAULT_COACH_SETTINGS.cadence,
    keyStorageMode: settings.keyStorageMode === "local" ? "local" : "session",
  };
  try {
    getLocal(deps)?.setItem(COACH_SETTINGS_STORAGE_KEY, JSON.stringify(safePayload));
  } catch {
    // ignore storage access errors
  }
}
