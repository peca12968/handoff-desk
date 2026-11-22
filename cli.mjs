import { readFileSync, writeFileSync } from "node:fs";
import { capture, resolve } from "./anchor.mjs";

function readText(path) {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}

function run(args) {
  const [command, path, ...rest] = args;
  if (command === "capture" && rest.length === 3) {
    const [start, end, output] = rest;
    if (![start, end].every(value => /^\d+$/.test(value))) throw new Error("Expected decimal offsets");
    const selector = capture(readText(path), Number(start), Number(end));
    writeFileSync(output, JSON.stringify(selector, null, 2) + "\n", { flag: "wx" });
  } else if (command === "resolve" && rest.length === 1) {
    const report = resolve(readText(path), JSON.parse(readText(rest[0])));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "attached") process.exitCode = 1;
  } else {
    throw new Error("Usage: node cli.mjs capture TEXT START END NEW_SELECTOR | resolve TEXT SELECTOR");
  }
}

try {
  run(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
