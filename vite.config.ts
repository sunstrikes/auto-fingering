import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { scoreLibraryPlugin } from "./server/scoreLibrary";

function ensureHttpsCert() {
  const certDir = path.resolve(import.meta.dirname, ".certs");
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    fs.mkdirSync(certDir, { recursive: true });
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "3650",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

const httpsConfig = ensureHttpsCert();

export default defineConfig({
  plugins: [react(), tailwindcss(), scoreLibraryPlugin()],
  // host: true => listen on 0.0.0.0 so other LAN devices can open the page
  server: { host: true, port: 5173, https: httpsConfig },
  preview: { host: true, port: 4173, https: httpsConfig },
  worker: {
    format: "es",
  },
});
