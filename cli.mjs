import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, firefox } from "@playwright/test";
import { replay, validate } from "./focus.mjs";

async function main(args) {
  if (args.length < 1 || args.length > 2) throw new Error("Usage: node cli.mjs FLOW.json [PAGE]");
  const flowFile = pathToFileURL(resolve(args[0]));
  const flow = JSON.parse(await readFile(flowFile, "utf8"));
  validate(flow);
  const url = new URL(args[1] ?? flow.page, flowFile);
  const name = process.env.FOCUS_BROWSER || "chromium";
  const engine = new Map([["chromium", chromium], ["firefox", firefox]]).get(name);
  if (!engine) throw new Error("FOCUS_BROWSER expects chromium or firefox");
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    const response = await page.goto(url.href);
    if (response && !response.ok()) throw new Error("Page returned HTTP " + response.status());
    const result = await replay(page, flow.steps);
    console.log(JSON.stringify({ browser: name, ...result }, null, 2));
    return result.passed ? 0 : 1;
  } finally {
    await browser.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
