import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const ALLOWED = /\.(musicxml|xml|mxl)$/i;
const MAX_BYTES = 50 * 1024 * 1024;

/** Shared score library on disk so every device on the LAN sees uploaded scores. */
export function scoreLibraryPlugin(dir = path.resolve(process.cwd(), "uploaded-scores")): Plugin {
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/scores")) return next();
    const send = (code: number, body: unknown, type = "application/json") => {
      res.statusCode = code;
      res.setHeader("Content-Type", type);
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const rest = decodeURIComponent(url.pathname.slice("/api/scores".length)).replace(/^\//, "");
    const name = rest ? path.basename(rest) : "";
    fs.mkdirSync(dir, { recursive: true });

    if (req.method === "GET" && !name) {
      const items = fs
        .readdirSync(dir)
        .filter((f) => ALLOWED.test(f))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      return send(200, items);
    }
    if (!name || !ALLOWED.test(name)) return send(400, { error: "invalid file name" });
    const file = path.join(dir, name);
    if (req.method === "GET") {
      if (!fs.existsSync(file)) return send(404, { error: "not found" });
      return send(200, fs.readFileSync(file), "application/octet-stream");
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BYTES) chunks.push(c);
      });
      req.on("end", () => {
        if (size > MAX_BYTES) return send(413, { error: "too large" });
        fs.writeFileSync(file, Buffer.concat(chunks));
        send(200, { name });
      });
      return;
    }
    if (req.method === "DELETE") {
      fs.rmSync(file, { force: true });
      return send(200, { name });
    }
    send(405, { error: "method not allowed" });
  };
  return {
    name: "score-library",
    configureServer: (s) => void s.middlewares.use(handler),
    configurePreviewServer: (s) => void s.middlewares.use(handler),
  };
}
