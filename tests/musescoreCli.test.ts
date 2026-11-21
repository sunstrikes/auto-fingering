import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { runCli } from "../src/musescore/cli";
import { readMxlContainer } from "../src/musicxml/mxl";
import { parseMusicXml } from "../src/musicxml/parser";

const execFileAsync = promisify(execFile);
const FIXTURE_DIR = resolve(__dirname, "../test-corpus/ms4-fixtures");

function md5Prefix4(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 4);
}

interface TestServer {
  origin: string;
  close: () => Promise<void>;
}

async function startFixtureServer(): Promise<TestServer> {
  const svg0 = readFileSync(resolve(FIXTURE_DIR, "04-partial-preview-p1.svg"));
  const png1 = readFileSync(resolve(FIXTURE_DIR, "05-png-asset-p1.png"));
  const midiBuf = readFileSync(resolve(FIXTURE_DIR, "04-partial-preview.mid"));
  const scoreId = 246810;
  const suffix = "cli_suf";

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === `/scores/${scoreId}` || url.pathname === `/user/9/scores/${scoreId}`) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><head>
<meta property="al:ios:url" content="musescore://score/${scoreId}">
<meta property="og:title" content="CLI Prelude">
<link rel="preload" href="/static/public/build/musescore_es6/202601.js">
</head><body>
<img src="/scoredata/g/1234/score_0.svg" alt="Page 1 of 2 pages">
</body></html>`);
      return;
    }
    if (url.pathname === "/static/public/build/musescore_es6/202601.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(`("${suffix}").substr(0,4)`);
      return;
    }
    if (url.pathname === "/api/jmuse") {
      const id = url.searchParams.get("id");
      const type = url.searchParams.get("type");
      const index = url.searchParams.get("index") ?? "0";
      if (req.headers.authorization !== md5Prefix4(`${id}${type}${index}${suffix}`)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      if (type === "img" && index === "0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ info: { url: "/cdn/p0.svg" } }));
        return;
      }
      if (type === "img" && index === "1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ info: { url: "/cdn/p1.png" } }));
        return;
      }
      if (type === "midi" && index === "0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ info: { url: "/cdn/score.mid" } }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (url.pathname === "/cdn/p0.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(svg0);
      return;
    }
    if (url.pathname === "/cdn/p1.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png1);
      return;
    }
    if (url.pathname === "/cdn/score.mid") {
      res.writeHead(200, { "content-type": "audio/midi" });
      res.end(midiBuf);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Expected numeric port");
  }
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

describe("MuseScore CLI entry point", () => {
  const servers: TestServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.close();
    }
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("writes .musicxml and prints structured diagnostic summary (svgPagesParsed, pngPagesSkipped, measuresAligned, fallbackMeasures, warnings)", async () => {
    const server = await startFixtureServer();
    servers.push(server);
    const dir = mkdtempSync(resolve(tmpdir(), "ms-cli-"));
    tempDirs.push(dir);
    const outPath = resolve(dir, "prelude.musicxml");

    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [`${server.origin}/user/9/scores/246810`, "-o", outPath],
      {
        stdout: (msg) => stdout.push(msg),
        stderr: (msg) => stderr.push(msg),
      }
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);

    const output = stdout.join("");
    expect(output).toContain("svgPagesParsed");
    expect(output).toContain("pngPagesSkipped");
    expect(output).toContain("measuresAligned");
    expect(output).toContain("fallbackMeasures");
    expect(output).toContain("warnings");
    expect(output).toContain("PNG_PAGE_SKIPPED");

    const xml = readFileSync(outPath, "utf8");
    const dom = new JSDOM();
    const doc = parseMusicXml(xml, { DOMParser: dom.window.DOMParser });
    expect(doc.title).toBe("CLI Prelude");
    expect(doc.noteEvents.length).toBeGreaterThan(0);
  });

  it("writes compressed .mxl archive when output path ends with .mxl", async () => {
    const server = await startFixtureServer();
    servers.push(server);
    const dir = mkdtempSync(resolve(tmpdir(), "ms-cli-mxl-"));
    tempDirs.push(dir);
    const outPath = resolve(dir, "prelude.mxl");

    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      ["246810", "--base-origin", server.origin, "-o", outPath, "--json"],
      {
        stdout: (msg) => stdout.push(msg),
        stderr: (msg) => stderr.push(msg),
      }
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);

    const summary = JSON.parse(stdout.join(""));
    expect(summary.svgPagesParsed).toBe(1);
    expect(summary.pngPagesSkipped).toBe(1);
    expect(typeof summary.measuresAligned).toBe("number");
    expect(typeof summary.fallbackMeasures).toBe("number");
    expect(Array.isArray(summary.warnings)).toBe(true);

    const mxlBytes = readFileSync(outPath);
    const dom = new JSDOM();
    const container = await readMxlContainer(mxlBytes, {
      DOMParser: dom.window.DOMParser,
    });
    const doc = parseMusicXml(container.xmlText, {
      DOMParser: dom.window.DOMParser,
    });
    expect(doc.title).toBe("CLI Prelude");
    expect(doc.noteEvents.length).toBeGreaterThan(0);
  });

  it("rejects legacy --musicxml-mode flag and missing target arguments", async () => {
    const stderr1: string[] = [];
    const code1 = await runCli(["12345", "--musicxml-mode", "midi"], {
      stdout: () => {},
      stderr: (m) => stderr1.push(m),
    });
    expect(code1).not.toBe(0);
    expect(stderr1.join("")).toContain("Unknown option");

    const stderr2: string[] = [];
    const code2 = await runCli([], {
      stdout: () => {},
      stderr: (m) => stderr2.push(m),
    });
    expect(code2).not.toBe(0);
  });

  it("executes bin/musescore-import.mjs via Node.js child process", async () => {
    const server = await startFixtureServer();
    servers.push(server);
    const dir = mkdtempSync(resolve(tmpdir(), "ms-cli-bin-"));
    tempDirs.push(dir);
    const outPath = resolve(dir, "bin-out.musicxml");
    const binPath = resolve(__dirname, "../bin/musescore-import.mjs");

    const { stdout, stderr } = await execFileAsync(process.execPath, [
      binPath,
      `${server.origin}/scores/246810`,
      "-o",
      outPath,
    ]);

    expect(stderr).toBe("");
    expect(stdout).toContain("svgPagesParsed: 1");
    expect(stdout).toContain("pngPagesSkipped: 1");
    const xml = readFileSync(outPath, "utf8");
    expect(xml).toContain("<score-partwise");
  });

  it("downloads optional PDF when --pdf <path> is provided", async () => {
    const pdfPayload = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
    const svg0 = readFileSync(resolve(FIXTURE_DIR, "04-partial-preview-p1.svg"));
    const midiBuf = readFileSync(resolve(FIXTURE_DIR, "04-partial-preview.mid"));
    const scoreId = 246810;
    const suffix = "cli_pdf";

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === `/scores/${scoreId}`) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<html><head>
<meta property="og:title" content="CLI PDF">
<link rel="preload" href="/static/public/build/musescore_es6/202601.js">
</head><body><img src="/scoredata/g/1234/score_0.svg" alt="Page 1 of 1 pages"></body></html>`);
        return;
      }
      if (url.pathname === "/static/public/build/musescore_es6/202601.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(`("${suffix}").substr(0,4)`);
        return;
      }
      if (url.pathname === "/api/jmuse") {
        const type = url.searchParams.get("type");
        const index = url.searchParams.get("index") ?? "0";
        if (req.headers.authorization !== md5Prefix4(`${scoreId}${type}${index}${suffix}`)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        if (type === "img" && index === "0") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ info: { url: "/cdn/p0.svg" } }));
          return;
        }
        if (type === "midi" && index === "0") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ info: { url: "/cdn/score.mid" } }));
          return;
        }
        if (type === "pdf" && index === "0") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ info: { url: "/cdn/score.pdf" } }));
          return;
        }
      }
      if (url.pathname === "/cdn/p0.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        res.end(svg0);
        return;
      }
      if (url.pathname === "/cdn/score.mid") {
        res.writeHead(200, { "content-type": "audio/midi" });
        res.end(midiBuf);
        return;
      }
      if (url.pathname === "/cdn/score.pdf") {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(pdfPayload);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Expected numeric port");
    const origin = `http://127.0.0.1:${addr.port}`;
    servers.push({
      origin,
      close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
    });

    const dir = mkdtempSync(resolve(tmpdir(), "ms-cli-pdf-"));
    tempDirs.push(dir);
    const outPath = resolve(dir, "out.musicxml");
    const pdfPath = resolve(dir, "out.pdf");
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCli(
      [`${origin}/scores/${scoreId}`, "-o", outPath, "--pdf", pdfPath, "--json"],
      {
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
      }
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(readFileSync(outPath, "utf8")).toContain("<score-partwise");
    expect(readFileSync(pdfPath, "utf8")).toContain("%PDF-1.4");
    const summary = JSON.parse(stdout.join(""));
    expect(summary.pdfPath).toBe(pdfPath);
  });
});
