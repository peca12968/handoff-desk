import { defineConfig } from "vite";

const proxy = {
  "/api/notes": {
    target: "http://127.0.0.1:5087",
    rewrite: path => path.slice(4)
  }
};

export default defineConfig({
  root: "ui",
  build: { outDir: "../dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 4177, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 4177, strictPort: true, proxy }
});
