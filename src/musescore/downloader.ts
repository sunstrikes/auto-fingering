import { createHash } from "node:crypto";
import { svgsAndMidiToMusicXml } from "./index";
import type { ConversionOptions, ConversionResult } from "./types";

const DEFAULT_BASE_ORIGIN = "https://musescore.com";
const FALLBACK_AUTH_SUFFIX = "9654,4e";
const DEFAULT_MAX_PAGES = 200;

export interface MuseScoreInputTarget {
  scoreId: number;
  scoreUrl: string;
}

export interface MuseScoreDownloadOptions {
  /** Base origin used for numeric IDs and /api/jmuse requests (default: https://musescore.com) */
  baseOrigin?: string;
  /** Optional browser-session Cookie header sent only to the MuseScore origin */
  cookie?: string;
  /** Optional extra headers sent only to the MuseScore origin */
  headers?: Record<string, string>;
  /** Override jmuse auth suffix instead of extracting from page JS bundles */
  authSuffix?: string;
  /** Maximum pages to fetch when totalPages is unknown (default: 200) */
  maxPages?: number;
  /** Injectable fetch implementation for testing (defaults to globalThis.fetch) */
  fetchImpl?: typeof fetch;
}

export interface MuseScorePageMetadata {
  id: number;
  title: string;
  viewerSrc?: string;
  totalPages?: number;
  jsBundleUrls: string[];
}

export interface DownloadedMuseScoreAssets {
  id: number;
  title: string;
  scoreUrl: string;
  totalPages?: number;
  pages: Uint8Array[];
  midiBuffer: Uint8Array;
}

export interface MuseScoreDownloadAndConvertOptions
  extends MuseScoreDownloadOptions,
    ConversionOptions {}

export interface MuseScoreImportResult extends ConversionResult {
  assets: DownloadedMuseScoreAssets;
}

function md5Prefix4(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 4);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10))
    );
}

/**
 * Parse a MuseScore URL or numeric score ID into a canonical scoreId + scoreUrl.
 */
export function parseMuseScoreInput(
  input: string | number,
  baseOrigin = DEFAULT_BASE_ORIGIN
): MuseScoreInputTarget {
  const normalizedOrigin = baseOrigin.replace(/\/+$/, "");

  if (typeof input === "number") {
    if (!Number.isInteger(input) || input <= 0) {
      throw new Error(`Invalid MuseScore score ID: ${input}`);
    }
    return {
      scoreId: input,
      scoreUrl: `${normalizedOrigin}/scores/${input}`,
    };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("MuseScore URL or score ID must not be empty.");
  }

  if (/^\d+$/.test(trimmed)) {
    const scoreId = Number(trimmed);
    if (!Number.isSafeInteger(scoreId) || scoreId <= 0) {
      throw new Error(`Invalid MuseScore score ID: "${trimmed}"`);
    }
    return {
      scoreId,
      scoreUrl: `${normalizedOrigin}/scores/${scoreId}`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid MuseScore URL or score ID: "${trimmed}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol "${parsed.protocol}" for "${trimmed}"`);
  }

  const match = parsed.pathname.match(/\/scores\/(\d+)(?:\/|$)/);
  if (!match) {
    throw new Error(`Could not extract numeric score ID from URL: "${trimmed}"`);
  }

  const scoreId = Number(match[1]);
  return {
    scoreId,
    scoreUrl: parsed.toString(),
  };
}

function buildOriginHeaders(
  targetUrl: string,
  scoreOrigin: string,
  options?: MuseScoreDownloadOptions,
  extraHeaders?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  const targetOrigin = new URL(targetUrl).origin;
  if (targetOrigin === scoreOrigin) {
    if (options?.headers) {
      Object.assign(out, options.headers);
    }
    if (options?.cookie) {
      out["Cookie"] = options.cookie;
    }
  }
  if (extraHeaders) {
    Object.assign(out, extraHeaders);
  }
  return out;
}

function extractMetaContent(html: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta\\b[^>]*property=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta\\b[^>]*content=["']([^"']*)["'][^>]*property=["']${escaped}["'][^>]*>`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match?.[1] !== undefined) {
      return decodeHtmlEntities(match[1]);
    }
  }
  return undefined;
}

/**
 * Parse MuseScore score page HTML for score ID, title, viewer image URL, totalPages, and JS bundle URLs.
 */
export function parseMuseScoreHtmlMetadata(
  html: string,
  fallbackId: number,
  pageOrigin: string
): MuseScorePageMetadata {
  const iosUrl = extractMetaContent(html, "al:ios:url");
  const idMatch = iosUrl?.match(/(\d+)\s*$/);
  const id = idMatch ? Number(idMatch[1]) : fallbackId;

  const ogTitle = extractMetaContent(html, "og:title")?.trim();
  const title = ogTitle || `score-${id}`;

  let viewerSrc: string | undefined;
  let totalPages: number | undefined;

  const imgTags = html.matchAll(/<img\b[^>]*>/gi);
  for (const [tag] of imgTags) {
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    const altMatch = tag.match(/\balt=["']([^"']*)["']/i);
    const src = srcMatch?.[1] ? decodeHtmlEntities(srcMatch[1]) : undefined;
    const alt = altMatch?.[1] ? decodeHtmlEntities(altMatch[1]) : "";

    if (src && /\/scoredata\/g\/[0-9a-f]+\/score_\d+\.(?:svg|png)/i.test(src)) {
      viewerSrc = new URL(src, pageOrigin).toString();
      const pagesMatch = alt.match(/of\s+(\d+)\s+pages?/i);
      if (pagesMatch?.[1]) {
        totalPages = Number(pagesMatch[1]);
      }
      break;
    }

    if (!totalPages && alt) {
      const pagesMatch = alt.match(/of\s+(\d+)\s+pages?/i);
      if (pagesMatch?.[1]) {
        totalPages = Number(pagesMatch[1]);
      }
    }
  }

  const jsBundleUrls: string[] = [];
  const linkTags = html.matchAll(/<link\b[^>]*>/gi);
  for (const [tag] of linkTags) {
    const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
    const href = hrefMatch?.[1] ? decodeHtmlEntities(hrefMatch[1]) : undefined;
    if (href && /\/static\/public\/build\/musescore.*?(?:_es6)?\/[^"']+\.js/i.test(href)) {
      jsBundleUrls.push(new URL(href, pageOrigin).toString());
    }
  }

  return {
    id,
    title,
    viewerSrc,
    totalPages,
    jsBundleUrls,
  };
}

async function resolveAuthSuffix(
  bundleUrls: readonly string[],
  scoreOrigin: string,
  fetchFn: typeof fetch,
  options?: MuseScoreDownloadOptions
): Promise<string | undefined> {
  if (options?.authSuffix !== undefined) {
    return options.authSuffix;
  }
  for (const url of bundleUrls) {
    try {
      const res = await fetchFn(url, {
        headers: buildOriginHeaders(url, scoreOrigin, options),
      });
      if (!res.ok) continue;
      const text = await res.text();
      const match = text.match(/"([^"]+)"\)\.substr\(0,4\)/);
      if (match?.[1]) {
        return match[1];
      }
    } catch {
      // Try next bundle URL
    }
  }
  return undefined;
}

async function fetchJmuseAssetUrl(params: {
  id: number;
  type: "img" | "midi";
  index: number;
  scoreOrigin: string;
  scoreUrl: string;
  suffix?: string;
  fetchFn: typeof fetch;
  options?: MuseScoreDownloadOptions;
}): Promise<string> {
  const { id, type, index, scoreOrigin, scoreUrl, suffix, fetchFn, options } = params;
  const candidateSuffixes = Array.from(
    new Set([suffix, FALLBACK_AUTH_SUFFIX].filter((s): s is string => Boolean(s)))
  );

  let lastError = "";
  for (const s of candidateSuffixes) {
    const auth = md5Prefix4(`${id}${type}${index}${s}`);
    const apiUrl = `${scoreOrigin}/api/jmuse?id=${id}&type=${type}&index=${index}`;
    const res = await fetchFn(apiUrl, {
      headers: buildOriginHeaders(apiUrl, scoreOrigin, options, {
        Authorization: auth,
        Referer: scoreUrl,
      }),
    });

    const text = await res.text();
    let json: { info?: { url?: string } } | null = null;
    try {
      json = JSON.parse(text) as { info?: { url?: string } };
    } catch {
      // Non-JSON error body
    }

    const assetUrl = json?.info?.url;
    if (res.ok && assetUrl) {
      return new URL(assetUrl, scoreOrigin).toString();
    }
    lastError = `HTTP ${res.status} ${text.slice(0, 160)}`;
  }

  throw new Error(
    `Failed to resolve /api/jmuse ${type}[${index}] for score ${id} (${lastError}).`
  );
}

async function fetchBinaryAsset(
  url: string,
  scoreOrigin: string,
  fetchFn: typeof fetch,
  options?: MuseScoreDownloadOptions
): Promise<Uint8Array> {
  const res = await fetchFn(url, {
    headers: buildOriginHeaders(url, scoreOrigin, options),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch asset HTTP ${res.status}: ${url}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function fetchPageAssets(params: {
  id: number;
  totalPages?: number;
  viewerSrc?: string;
  scoreOrigin: string;
  scoreUrl: string;
  suffix?: string;
  maxPages: number;
  fetchFn: typeof fetch;
  options?: MuseScoreDownloadOptions;
}): Promise<Uint8Array[]> {
  const {
    id,
    totalPages,
    viewerSrc,
    scoreOrigin,
    scoreUrl,
    suffix,
    maxPages,
    fetchFn,
    options,
  } = params;
  const limit = totalPages ? Math.min(totalPages, maxPages) : maxPages;
  const pages: Uint8Array[] = [];
  let lastErr = "";

  for (let i = 0; i < limit; i++) {
    try {
      const assetUrl = await fetchJmuseAssetUrl({
        id,
        type: "img",
        index: i,
        scoreOrigin,
        scoreUrl,
        suffix,
        fetchFn,
        options,
      });
      const bytes = await fetchBinaryAsset(assetUrl, scoreOrigin, fetchFn, options);
      pages.push(bytes);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  // Fallback: static viewerSrc URLs if /api/jmuse returned no pages
  if (pages.length === 0 && viewerSrc) {
    const qIdx = viewerSrc.indexOf("?");
    const query = qIdx >= 0 ? viewerSrc.slice(qIdx) : "";
    const prefix = viewerSrc.replace(/score_\d+\.(?:svg|png).*$/i, "");
    const extMatch = viewerSrc.match(/score_\d+\.(svg|png)/i);
    const ext = extMatch?.[1]?.toLowerCase() ?? "svg";

    for (let i = 0; i < limit; i++) {
      try {
        const bytes = await fetchBinaryAsset(
          `${prefix}score_${i}.${ext}${query}`,
          scoreOrigin,
          fetchFn,
          options
        );
        pages.push(bytes);
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        break;
      }
    }
  }

  if (pages.length === 0) {
    throw new Error(
      `No score page assets could be fetched for score ${id}${lastErr ? `: ${lastErr}` : ""}`
    );
  }

  return pages;
}

/**
 * Fetch MuseScore page metadata, SVG/PNG page assets, and MIDI buffer using pure Node.js fetch.
 */
export async function downloadMuseScoreAssets(
  input: string | number,
  options?: MuseScoreDownloadOptions
): Promise<DownloadedMuseScoreAssets> {
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  if (!fetchFn) {
    throw new Error("Global fetch is not available in this environment.");
  }

  const target = parseMuseScoreInput(input, options?.baseOrigin);
  const scoreOrigin = options?.baseOrigin
    ? new URL(options.baseOrigin).origin
    : new URL(target.scoreUrl).origin;

  const pageRes = await fetchFn(target.scoreUrl, {
    headers: buildOriginHeaders(target.scoreUrl, scoreOrigin, options),
  });
  if (!pageRes.ok) {
    throw new Error(
      `Failed to fetch MuseScore page HTTP ${pageRes.status}: ${target.scoreUrl}`
    );
  }
  const html = await pageRes.text();
  const meta = parseMuseScoreHtmlMetadata(html, target.scoreId, scoreOrigin);

  const suffix = await resolveAuthSuffix(meta.jsBundleUrls, scoreOrigin, fetchFn, options);
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;

  const pages = await fetchPageAssets({
    id: meta.id,
    totalPages: meta.totalPages,
    viewerSrc: meta.viewerSrc,
    scoreOrigin,
    scoreUrl: target.scoreUrl,
    suffix,
    maxPages,
    fetchFn,
    options,
  });

  const midiUrl = await fetchJmuseAssetUrl({
    id: meta.id,
    type: "midi",
    index: 0,
    scoreOrigin,
    scoreUrl: target.scoreUrl,
    suffix,
    fetchFn,
    options,
  });
  const midiBuffer = await fetchBinaryAsset(midiUrl, scoreOrigin, fetchFn, options);

  return {
    id: meta.id,
    title: meta.title,
    scoreUrl: target.scoreUrl,
    totalPages: meta.totalPages,
    pages,
    midiBuffer,
  };
}

/**
 * Download MuseScore score assets and convert them to MusicXML 4.0 via svgsAndMidiToMusicXml.
 */
export async function downloadAndConvertMuseScore(
  input: string | number,
  options?: MuseScoreDownloadAndConvertOptions
): Promise<MuseScoreImportResult> {
  const assets = await downloadMuseScoreAssets(input, options);
  const conversion = svgsAndMidiToMusicXml(assets.pages, assets.midiBuffer, {
    title: options?.title ?? assets.title,
    totalPages: options?.totalPages ?? assets.totalPages,
    pickupTicks: options?.pickupTicks,
    splitPitch: options?.splitPitch,
    alignmentConfidenceThreshold: options?.alignmentConfidenceThreshold,
  });

  return {
    ...conversion,
    assets,
  };
}
