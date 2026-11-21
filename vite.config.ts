import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { scoreLibraryPlugin } from "./server/scoreLibrary";

export default defineConfig({
  plugins: [react(), tailwindcss(), scoreLibraryPlugin()],
  // host: true => listen on 0.0.0.0 so other LAN devices can open the page
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  worker: {
    format: "es",
  },
});
