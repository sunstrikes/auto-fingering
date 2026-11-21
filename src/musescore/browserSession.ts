import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { DownloadedMuseScoreAssets, MuseScorePageMetadata } from "./downloader";

const FALLBACK_AUTH_SUFFIX = "9654,4e";
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_META_TIMEOUT_MS = 90_000;

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/opt/homebrew/bin/chromium",
];

const LAUNCH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=Translate,OptimizationHints",
];

export const DEFAULT_MSDL_PROFILE = join(homedir(), ".cache", "msdl", "profile");

export interface BrowserDownloadOptions {
  /** Run Chrome in headless mode (default: false, matching msdl so Cloudflare challenges can pass). */
  headless?: boolean;
  /** Persistent Chrome profile directory (default: ~/.cache/msdl/profile). */
  profile?: string;
  /** Timeout in ms waiting for Cloudflare challenge + score metadata (default: 90000). */
  timeoutMs?: number;
  /** Override jmuse auth suffix instead of extracting from page JS bundles. */
  authSuffix?: string;
  /** Maximum pages to fetch when totalPages is unknown (default: 200). */
  maxPages?: number;
}

function md5Prefix4(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 4);
}

/** Locate a system Chrome/Chromium executable if present. */
export function findChrome(): string | null {
  for (const candidate of CHROME_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Open a persistent real-Chrome context (same approach as msdl) so Cloudflare
 * cf_clearance and login cookies are cached across runs.
 */
export async function openMuseScoreBrowserSession(options?: {
  headless?: boolean;
  profile?: string;
}): Promise<BrowserContext> {
  const profile = options?.profile ?? DEFAULT_MSDL_PROFILE;
  mkdirSync(profile, { recursive: true });
  const exe = findChrome();

  const ctx = await chromium.launchPersistentContext(profile, {
    viewport: { width: 1400, height: 950 },
    locale: "en-US",
    timezoneId: "Asia/Shanghai",
    args: LAUNCH_ARGS,
    headless: Boolean(options?.headless ?? false),
    ...(exe ? { executablePath: exe } : { channel: "chrome" }),
  });
  ctx.setDefaultTimeout(60_000);
  return ctx;
}

/** Wait for Cloudflare challenge to clear and extract score metadata from the live DOM. */
export async function readScoreMetaInPage(
  page: Page,
  fallbackId: number,
  timeoutMs = DEFAULT_META_TIMEOUT_MS
): Promise<MuseScorePageMetadata> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await page
      .evaluate(() => {
        const metaContent = (sel: string) =>
          document.querySelector(sel)?.getAttribute("content") || null;
        const viewerImg =
          (document.querySelector("#jmuse-scroller-component img") as HTMLImageElement | null) ||
          Array.from(document.images).find((img) =>
            /\/scoredata\/g\/[0-9a-f]+\/score_\d+\.(?:svg|png)/.test(img.src)
          ) ||
          null;
        const alt = viewerImg?.alt || "";
        const totalMatch = alt.match(/of\s+(\d+)\s+pages?/i);
        return {
          iosUrl: metaContent("meta[property='al:ios:url']"),
          title: metaContent("meta[property='og:title']"),
          viewerSrc: viewerImg?.src || null,
          totalPages: totalMatch ? Number(totalMatch[1]) : null,
        };
      })
      .catch(() => null);

    if (raw?.iosUrl) {
      const idMatch = String(raw.iosUrl).match(/(\d+)\s*$/);
      const id = idMatch ? Number(idMatch[1]) : fallbackId;
      return {
        id,
        title: raw.title?.trim() || `score-${id}`,
        viewerSrc: raw.viewerSrc ?? undefined,
        totalPages: raw.totalPages ?? undefined,
        jsBundleUrls: [],
      };
    }

    await page.waitForTimeout(600);
  }

  const pageTitle = await page.title().catch(() => "?");
  throw new Error(
    `Timed out waiting for MuseScore score metadata (page title: ${pageTitle}). ` +
      `If Cloudflare challenge did not clear, retry without --headless and complete verification in the opened Chrome window.`
  );
}

/** Extract the 4-char jmuse auth suffix from MuseScore's JS bundles inside the browser context. */
export async function resolveAuthSuffixInPage(page: Page): Promise<string | undefined> {
  const found = await page.evaluate(async () => {
    const urls = Array.from(
      document.head.innerHTML.matchAll(
        /link.+?href=["'](https:\/\/[^"']*\/static\/public\/build\/musescore.*?(?:_es6)?\/[^"']+\.js)["']/gi
      )
    ).map((m) => m[1]);

    for (const u of urls) {
      try {
        const text = await (await fetch(u)).text();
        const match = text.match(/"([^"]+)"\)\.substr\(0,4\)/);
        if (match?.[1]) {
          return match[1];
        }
      } catch {
        // Try next bundle URL
      }
    }
    return null;
  });
  return found ?? undefined;
}

/** Fetch binary asset inside page context with credentials omitted (avoids CDN CORS rejection). */
export async function fetchBufferInPage(page: Page, url: string): Promise<Uint8Array> {
  const res = await page.evaluate(async (targetUrl: string) => {
    try {
      const r = await fetch(targetUrl, { credentials: "omit" });
      if (!r.ok) {
        return { ok: false as const, status: r.status, error: "" };
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < buf.length; i += chunkSize) {
        binary += String.fromCharCode(...buf.subarray(i, i + chunkSize));
      }
      return { ok: true as const, status: r.status, b64: btoa(binary) };
    } catch (err) {
      return {
        ok: false as const,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, url);

  if (!res.ok) {
    throw new Error(`Failed to fetch asset HTTP ${res.status || "-"} ${res.error}: ${url}`);
  }
  return new Uint8Array(Buffer.from(res.b64, "base64"));
}

async function fetchJmuseAssetUrlInPage(params: {
  page: Page;
  id: number;
  type: "img" | "midi" | "pdf";
  index: number;
  suffix?: string;
}): Promise<string> {
  const { page, id, type, index, suffix } = params;
  const candidateSuffixes = Array.from(
    new Set([suffix, FALLBACK_AUTH_SUFFIX].filter((s): s is string => Boolean(s)))
  );

  let lastError = "";
  for (const s of candidateSuffixes) {
    const auth = md5Prefix4(`${id}${type}${index}${s}`);
    const res = await page.evaluate(
      async ({
        id: scoreId,
        type: assetType,
        index: assetIndex,
        authHeader,
      }: {
        id: number;
        type: string;
        index: number;
        authHeader: string;
      }) => {
        const r = await fetch(
          `/api/jmuse?id=${scoreId}&type=${assetType}&index=${assetIndex}`,
          { headers: { Authorization: authHeader } }
        );
        const text = await r.text();
        let json: { info?: { url?: string } } | null = null;
        try {
          json = JSON.parse(text) as { info?: { url?: string } };
        } catch {
          // Non-JSON error body
        }
        return {
          ok: r.ok,
          status: r.status,
          url: json?.info?.url ?? null,
          snippet: text.slice(0, 160),
        };
      },
      { id, type, index, authHeader: auth }
    );

    if (res.ok && res.url) {
      return new URL(res.url, page.url()).toString();
    }
    lastError = `HTTP ${res.status} ${res.snippet}`;
  }

  throw new Error(
    `Failed to resolve /api/jmuse ${type}[${index}] for score ${id} (${lastError}).`
  );
}

async function withMuseScorePage<T>(
  scoreUrl: string,
  options: BrowserDownloadOptions | undefined,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const ctx = await openMuseScoreBrowserSession({
    headless: options?.headless,
    profile: options?.profile,
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(scoreUrl, { waitUntil: "domcontentloaded" });
    return await fn(page);
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * Download MuseScore SVG/PNG pages and MIDI buffer using msdl's persistent Chrome session.
 */
export async function downloadMuseScoreAssetsViaBrowser(
  scoreUrl: string,
  fallbackId: number,
  options?: BrowserDownloadOptions
): Promise<DownloadedMuseScoreAssets> {
  return withMuseScorePage(scoreUrl, options, async (page) => {
    const meta = await readScoreMetaInPage(page, fallbackId, options?.timeoutMs);
    const suffix =
      options?.authSuffix !== undefined
        ? options.authSuffix
        : await resolveAuthSuffixInPage(page).catch(() => undefined);
    const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
    const limit = meta.totalPages ? Math.min(meta.totalPages, maxPages) : maxPages;

    const pages: Uint8Array[] = [];
    let lastErr = "";

    for (let i = 0; i < limit; i++) {
      try {
        const assetUrl = await fetchJmuseAssetUrlInPage({
          page,
          id: meta.id,
          type: "img",
          index: i,
          suffix,
        });
        pages.push(await fetchBufferInPage(page, assetUrl));
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    if (pages.length === 0 && meta.viewerSrc) {
      const qIdx = meta.viewerSrc.indexOf("?");
      const query = qIdx >= 0 ? meta.viewerSrc.slice(qIdx) : "";
      const prefix = meta.viewerSrc.replace(/score_\d+\.(?:svg|png).*$/i, "");
      const extMatch = meta.viewerSrc.match(/score_\d+\.(svg|png)/i);
      const ext = extMatch?.[1]?.toLowerCase() ?? "svg";

      for (let i = 0; i < limit; i++) {
        try {
          pages.push(await fetchBufferInPage(page, `${prefix}score_${i}.${ext}${query}`));
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          break;
        }
      }
    }

    if (pages.length === 0) {
      throw new Error(
        `No score page assets could be fetched for score ${meta.id}${lastErr ? `: ${lastErr}` : ""}`
      );
    }

    const midiUrl = await fetchJmuseAssetUrlInPage({
      page,
      id: meta.id,
      type: "midi",
      index: 0,
      suffix,
    });
    const midiBuffer = await fetchBufferInPage(page, midiUrl);

    return {
      id: meta.id,
      title: meta.title,
      scoreUrl,
      totalPages: meta.totalPages,
      pages,
      midiBuffer,
    };
  });
}

/**
 * Download MuseScore PDF via /api/jmuse using msdl's persistent Chrome session.
 */
export async function downloadMuseScorePdfViaBrowser(
  scoreUrl: string,
  fallbackId: number,
  options?: BrowserDownloadOptions
): Promise<Uint8Array> {
  const assets = await downloadMuseScoreAssetsViaBrowser(scoreUrl, fallbackId, options);
  return svgsToPdfViaBrowser(assets.pages);
}

function parseSvgPtDimensions(svgBytes: Uint8Array): { w: number; h: number } {
  const head = Buffer.from(svgBytes.subarray(0, 600)).toString("utf8");
  return {
    w: Number(head.match(/\bwidth="([\d.]+)"/)?.[1] || 595.28),
    h: Number(head.match(/\bheight="([\d.]+)"/)?.[1] || 841.89),
  };
}

/**
 * Render MuseScore vector SVG pages into a true vector PDF using headless Chrome (same as msdl).
 */
export async function svgsToPdfViaBrowser(
  pages: readonly Uint8Array[]
): Promise<Uint8Array> {
  if (pages.length === 0) {
    throw new Error("Cannot generate PDF: no SVG pages provided.");
  }

  const exe = findChrome();
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
    ...(exe ? { executablePath: exe } : { channel: "chrome" }),
  });

  try {
    const page = await browser.newPage();
    const { w, h } = parseSvgPtDimensions(pages[0]);
    const toPx = (pt: number) => `${(pt * 4) / 3}px`;

    const body = pages
      .map(
        (buf) =>
          `<div class="pg"><img src="data:image/svg+xml;base64,${Buffer.from(buf).toString(
            "base64"
          )}" style="display:block;width:${toPx(w)};height:${toPx(h)}"></div>`
      )
      .join("");

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: ${toPx(w)} ${toPx(h)}; margin: 0 }
      html, body { margin: 0; padding: 0; background: #fff }
      .pg { page-break-after: always; break-after: page; }
      .pg:last-child { page-break-after: auto; break-after: auto; }
      img { margin: 0 }
    </style></head><body>${body}</body></html>`;

    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() =>
      Promise.all(
        Array.from(document.images).map((img) =>
          img.complete ? Promise.resolve() : img.decode().catch(() => undefined)
        )
      )
    );

    const pdf = await page.pdf({
      width: toPx(w),
      height: toPx(h),
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      printBackground: true,
      preferCSSPageSize: true,
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}
