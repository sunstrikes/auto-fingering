import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  downloadAndConvertMuseScore,
  downloadMuseScoreAssets,
  downloadMuseScorePdf,
  parseMuseScoreInput,
} from "../src/musescore";
import { parseMusicXml } from "../src/musicxml/parser";
import { JSDOM } from "jsdom";

const FIXTURE_DIR = resolve(__dirname, "../test-corpus/ms4-fixtures");

function md5Prefix4(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 4);
}

interface TestServer {
  origin: string;
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Expected numeric server port");
  }
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

describe("MuseScore downloader & converter seam", () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()!;
      await s.close();
    }
  });

  it("parses numeric score IDs and MuseScore URLs, rejecting invalid inputs", () => {
    expect(parseMuseScoreInput(123456)).toEqual({
      scoreId: 123456,
      scoreUrl: "https://musescore.com/scores/123456",
    });
    expect(parseMuseScoreInput("  987654  ")).toEqual({
      scoreId: 987654,
      scoreUrl: "https://musescore.com/scores/987654",
    });
    expect(
      parseMuseScoreInput("https://musescore.com/user/42/scores/555111?from=search")
    ).toEqual({
      scoreId: 555111,
      scoreUrl: "https://musescore.com/user/42/scores/555111?from=search",
    });

    expect(() => parseMuseScoreInput("")).toThrow();
    expect(() => parseMuseScoreInput("https://example.com/not-a-score")).toThrow();
    expect(() => parseMuseScoreInput(-5)).toThrow();
  });

  it("fetches page metadata, /api/jmuse auth assets, SVG/PNG pages, and MIDI via local HTTP fixtures without leaking cookies to CDN", async () => {
    const svg0 = readFileSync(resolve(FIXTURE_DIR, "01-grand-staff-p1.svg"));
    const png1 = readFileSync(resolve(FIXTURE_DIR, "05-png-asset-p1.png"));
    const midiBuf = readFileSync(resolve(FIXTURE_DIR, "01-grand-staff.mid"));
    const suffix = "test_suf_42";
    const scoreId = 778899;

    const cdnCookiesSeen: Array<string | undefined> = [];
    const msCookiesSeen: Array<string | undefined> = [];
    const msCustomHeadersSeen: Array<string | undefined> = [];

    const cdn = await startServer((req, res) => {
      cdnCookiesSeen.push(req.headers.cookie);
      if (req.url === "/assets/page_0.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        res.end(svg0);
        return;
      }
      if (req.url === "/assets/page_1.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png1);
        return;
      }
      if (req.url === "/assets/score.mid") {
        res.writeHead(200, { "content-type": "audio/midi" });
        res.end(midiBuf);
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    });
    servers.push(cdn);

    const ms = await startServer((req, res) => {
      msCookiesSeen.push(req.headers.cookie);
      msCustomHeadersSeen.push(req.headers["x-test-session"] as string | undefined);

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (
        url.pathname === `/user/1/scores/${scoreId}` ||
        url.pathname === `/scores/${scoreId}`
      ) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
<head>
  <meta property="al:ios:url" content="musescore://score/${scoreId}">
  <meta property="og:title" content="Nocturne &amp; Etude">
  <link rel="preload" as="script" href="/static/public/build/musescore_es6/202601.js">
</head>
<body>
  <div id="jmuse-scroller-component">
    <img src="${cdn.origin}/scoredata/g/abc/score_0.svg?no-cache=1" alt="Score page 1 of 2 pages">
  </div>
</body>
</html>`);
        return;
      }

      if (url.pathname === "/static/public/build/musescore_es6/202601.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(`function sign(a){return md5(a+"${suffix}").substr(0,4)}`);
        return;
      }

      if (url.pathname === "/api/jmuse") {
        const id = url.searchParams.get("id");
        const type = url.searchParams.get("type");
        const index = url.searchParams.get("index") ?? "0";
        const expectedAuth = md5Prefix4(`${id}${type}${index}${suffix}`);
        if (req.headers.authorization !== expectedAuth) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad auth" }));
          return;
        }
        if (type === "img" && index === "0") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ info: { url: `${cdn.origin}/assets/page_0.svg` } }));
          return;
        }
        if (type === "img" && index === "1") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ info: { url: `${cdn.origin}/assets/page_1.png` } }));
          return;
        }
        if (type === "midi" && index === "0") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ info: { url: `${cdn.origin}/assets/score.mid` } }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });
    servers.push(ms);

    const assets = await downloadMuseScoreAssets(
      `${ms.origin}/user/1/scores/${scoreId}`,
      {
        cookie: "cf_clearance=abc123; ms_session=xyz",
        headers: { "x-test-session": "browser-token" },
      }
    );

    expect(assets.id).toBe(scoreId);
    expect(assets.title).toBe("Nocturne & Etude");
    expect(assets.totalPages).toBe(2);
    expect(assets.pages).toHaveLength(2);
    expect(assets.midiBuffer.subarray(0, 4)).toEqual(
      new Uint8Array([0x4d, 0x54, 0x68, 0x64])
    );

    // Cookies & custom headers sent to MuseScore origin, never leaked to CDN
    expect(msCookiesSeen.every((c) => c === "cf_clearance=abc123; ms_session=xyz")).toBe(true);
    expect(msCustomHeadersSeen.every((h) => h === "browser-token")).toBe(true);
    expect(cdnCookiesSeen.every((c) => c === undefined)).toBe(true);

    // End-to-end downloadAndConvertMuseScore produces valid MusicXML + diagnostics
    const result = await downloadAndConvertMuseScore(scoreId, {
      baseOrigin: ms.origin,
      cookie: "cf_clearance=abc123",
    });
    expect(result.diagnostics.svgPagesParsed).toBe(1);
    expect(result.diagnostics.pngPagesSkipped).toBe(1);
    expect(result.diagnostics.measuresAligned).toBeGreaterThan(0);
    expect(result.diagnostics.warnings.some((w) => w.code === "PNG_PAGE_SKIPPED")).toBe(true);

    const dom = new JSDOM();
    const doc = parseMusicXml(result.xml, { DOMParser: dom.window.DOMParser });
    expect(doc.title).toBe("Nocturne & Etude");
    expect(doc.noteEvents.length).toBeGreaterThan(0);
    expect(doc.measureCount).toBeGreaterThan(0);
  });

  it("falls back to static viewerSrc for pages and default authSuffix for MIDI when JS bundle & /api/jmuse img are unavailable", async () => {
    const svg0 = readFileSync(resolve(FIXTURE_DIR, "02-fingerings-p1.svg"));
    const midiBuf = readFileSync(resolve(FIXTURE_DIR, "02-fingerings.mid"));
    const scoreId = 334455;
    const defaultSuffix = "9654,4e";

    const server = await startServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === `/scores/${scoreId}`) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><head><meta property="og:title" content="Fallback Study"></head>
<body><img src="/scoredata/g/deadbeef/score_0.svg?no-cache=1" alt="of 1 pages"></body></html>`);
        return;
      }
      if (url.pathname === "/scoredata/g/deadbeef/score_0.svg") {
        if (url.searchParams.get("no-cache") !== "1") {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        res.writeHead(200, { "content-type": "image/svg+xml" });
        res.end(svg0);
        return;
      }
      if (url.pathname === "/api/jmuse") {
        const type = url.searchParams.get("type");
        if (type === "img") {
          res.writeHead(403);
          res.end("img disabled");
          return;
        }
        if (type === "midi") {
          const expected = md5Prefix4(`${scoreId}midi0${defaultSuffix}`);
          if (req.headers.authorization !== expected) {
            res.writeHead(403);
            res.end("bad auth");
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ info: { url: "/assets/fallback.mid" } }));
          return;
        }
      }
      if (url.pathname === "/assets/fallback.mid") {
        res.writeHead(200, { "content-type": "audio/midi" });
        res.end(midiBuf);
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });
    servers.push(server);

    const result = await downloadAndConvertMuseScore(scoreId, {
      baseOrigin: server.origin,
    });
    expect(result.assets.title).toBe("Fallback Study");
    expect(result.diagnostics.svgPagesParsed).toBe(1);
    expect(result.diagnostics.pngPagesSkipped).toBe(0);
    expect(result.diagnostics.measuresAligned).toBeGreaterThan(0);
  });

  it("downloads optional PDF asset via /api/jmuse type=pdf without leaking cookies to CDN", async () => {
    const pdfPayload = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const scoreId = 334455;
    const suffix = "pdf_suf";
    const cdnCookies: Array<string | undefined> = [];
    const msCookies: Array<string | undefined> = [];

    const cdn = await startServer((req, res) => {
      cdnCookies.push(req.headers.cookie);
      if (req.url === "/assets/score.pdf") {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(pdfPayload);
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    });
    servers.push(cdn);

    const ms = await startServer((req, res) => {
      msCookies.push(req.headers.cookie);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === `/scores/${scoreId}`) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<html><head>
<meta property="og:title" content="PDF Test">
<link rel="preload" href="/static/public/build/musescore_es6/pdf.js">
</head><body></body></html>`);
        return;
      }
      if (url.pathname === "/static/public/build/musescore_es6/pdf.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(`("${suffix}").substr(0,4)`);
        return;
      }
      if (url.pathname === "/api/jmuse") {
        const type = url.searchParams.get("type");
        const index = url.searchParams.get("index") ?? "0";
        if (type === "pdf" && index === "0") {
          const expected = md5Prefix4(`${scoreId}pdf0${suffix}`);
          if (req.headers.authorization !== expected) {
            res.writeHead(403);
            res.end("bad auth");
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ info: { url: `${cdn.origin}/assets/score.pdf` } }));
          return;
        }
      }
      res.writeHead(404);
      res.end("Not Found");
    });
    servers.push(ms);

    const bytes = await downloadMuseScorePdf(scoreId, {
      baseOrigin: ms.origin,
      cookie: "session=secret_pdf",
    });

    expect(new TextDecoder().decode(bytes)).toContain("%PDF-1.4");
    expect(msCookies.every((c) => c === "session=secret_pdf")).toBe(true);
    expect(cdnCookies).toEqual([undefined]);
  });
});
