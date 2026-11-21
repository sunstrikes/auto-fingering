import {
  createLumikeyPrior,
  EXPECTED_WEIGHT_BIN_BYTES,
  parseLumikeyWeightBinary,
} from "./lumikeyTransformer";
import type { FingeringPrior } from "./types";

export interface PriorLoadProgress {
  loadedBytes: number;
  totalBytes: number;
}

export interface LoadLumikeyPriorOptions {
  /**
   * Custom base URL (e.g. `"https://example.com/models"` or `"/models"`).
   * Expects `lumikey-prior-left.bin` and `lumikey-prior-right.bin` under this base path.
   */
  baseUrl?: string;
  /** Optional custom `fetch` implementation for tests. */
  fetchFn?: typeof fetch;
  /** Progress callback receiving `{ loadedBytes, totalBytes }`. */
  onProgress?: (progress: PriorLoadProgress) => void;
}

let cachedPrior: FingeringPrior | null = null;
let cachedBaseUrl: string | null = null;
let inFlightPromise: Promise<FingeringPrior> | null = null;

export function isBundledPriorDisabled(): boolean {
  try {
    const envVal = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_BUNDLE_PRIOR;
    return envVal === "0" || envVal === "false";
  } catch {
    return false;
  }
}

export function getCachedLumikeyPrior(): FingeringPrior | null {
  return cachedPrior;
}

export function clearCachedLumikeyPrior(): void {
  cachedPrior = null;
  cachedBaseUrl = null;
  inFlightPromise = null;
}

async function fetchBinaryWithProgress(
  url: string,
  fetchFn: typeof fetch,
  onChunk: (bytesDelta: number) => void
): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch model weights (${url}): HTTP ${res.status}`);
  }

  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalLen += value.byteLength;
        onChunk(value.byteLength);
      }
    }
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged;
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  onChunk(buf.byteLength);
  return buf;
}

/**
 * Lazily loads `lumikey-prior-left.bin` and `lumikey-prior-right.bin` (~809 KB total)
 * and constructs a cached `FingeringPrior` instance.
 *
 * Honors the `VITE_BUNDLE_PRIOR=0` build-time downgrade switch when no custom `baseUrl`
 * is provided.
 */
export async function loadLumikeyPrior(
  options?: LoadLumikeyPriorOptions
): Promise<FingeringPrior> {
  const rawBase = options?.baseUrl?.trim() || "";
  if (!rawBase && isBundledPriorDisabled()) {
    throw new Error(
      "Bundled pretrained prior is disabled (VITE_BUNDLE_PRIOR=0). Provide a custom model base URL to enable."
    );
  }

  const normalizedBase = (rawBase || "/models").replace(/\/+$/, "");
  if (cachedPrior && cachedBaseUrl === normalizedBase) {
    options?.onProgress?.({
      loadedBytes: EXPECTED_WEIGHT_BIN_BYTES * 2,
      totalBytes: EXPECTED_WEIGHT_BIN_BYTES * 2,
    });
    return cachedPrior;
  }

  if (inFlightPromise && cachedBaseUrl === normalizedBase) {
    return inFlightPromise;
  }

  const fetchFn =
    options?.fetchFn ??
    (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
  if (!fetchFn) {
    throw new Error("Global fetch is unavailable for loading pretrained prior weights.");
  }

  cachedBaseUrl = normalizedBase;
  const totalBytes = EXPECTED_WEIGHT_BIN_BYTES * 2;
  let loadedBytes = 0;
  const report = (delta: number) => {
    loadedBytes = Math.min(totalBytes, loadedBytes + delta);
    options?.onProgress?.({ loadedBytes, totalBytes });
  };

  inFlightPromise = (async () => {
    try {
      const [leftBytes, rightBytes] = await Promise.all([
        fetchBinaryWithProgress(`${normalizedBase}/lumikey-prior-left.bin`, fetchFn, report),
        fetchBinaryWithProgress(`${normalizedBase}/lumikey-prior-right.bin`, fetchFn, report),
      ]);
      const left = parseLumikeyWeightBinary(leftBytes);
      const right = parseLumikeyWeightBinary(rightBytes);
      const prior = createLumikeyPrior({ left, right });
      cachedPrior = prior;
      return prior;
    } catch (err) {
      if (cachedBaseUrl === normalizedBase) {
        cachedPrior = null;
        cachedBaseUrl = null;
      }
      throw err;
    } finally {
      inFlightPromise = null;
    }
  })();

  return inFlightPromise;
}
