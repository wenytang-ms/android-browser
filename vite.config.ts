import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const extension = mode === "extension";
  return {
    root: extension ? "extension" : "viewer",
    base: "./",
    publicDir: "public",
    build: {
      outDir: resolve(extension ? "dist/extension" : "dist/viewer"),
      emptyOutDir: true,
      target: "chrome118",
      rolldownOptions: {
        input: extension
          ? {
              index: resolve("extension/index.html"),
              background: resolve("src/extension/background.ts"),
            }
          : resolve("viewer/index.html"),
        output: {
          entryFileNames: extension ? "[name].js" : "assets/[name]-[hash].js",
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/ws": { target: "ws://127.0.0.1:3000", ws: true },
      },
    },
  };
});
