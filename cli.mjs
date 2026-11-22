import { readFile } from "node:fs/promises";
import { merge, render } from "./merge.mjs";

async function read(path) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(path));
}

try {
  const [mode, ...paths] = process.argv.slice(2);
  if (mode === "plan" && paths.length === 3) {
    const plan = merge(...await Promise.all(paths.map(read)));
    console.log(JSON.stringify(plan, null, 2));
    process.exitCode = plan.conflicts ? 1 : 0;
  } else if (mode === "resolve" && paths.length === 1) {
    const plan = JSON.parse((await read(paths[0])).replace(/^\uFEFF/, ""));
    process.stdout.write(render(plan));
  } else throw new Error("Usage: node cli.mjs plan BASE LOCAL INCOMING | resolve PLAN.json");
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
