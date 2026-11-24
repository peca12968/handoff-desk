import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const api = process.env.HANDOFF_API_DIR || "modules/handoff-notes-api";
const assembly = resolve(api, "src/bin/Release/net10.0/HandoffNotes.dll");
const databaseDir = resolve(".test-db");
mkdirSync(databaseDir, { recursive: true });

export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://127.0.0.1:4177" },
  projects: [
    { name: "chromium", use: { browserName: "chromium", launchOptions: { executablePath: process.env.BROWSER_PATH || undefined } } },
    { name: "firefox", use: { browserName: "firefox" } }
  ],
  webServer: [
    {
      command: 'dotnet "' + assembly + '" --urls http://127.0.0.1:5087',
      port: 5087,
      env: { HANDOFF_DB: resolve(databaseDir, randomUUID() + ".db") }
    },
    { command: "npm run preview", url: "http://127.0.0.1:4177" }
  ]
});
