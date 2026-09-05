import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "telegram-mini-app",
  base: "/mini/",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  build: {
    outDir: "../dist/mini",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: path.resolve(__dirname, "telegram-mini-app/index.html") }
  },
  server: { port: 5174, host: "127.0.0.1" }
});
