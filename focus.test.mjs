import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, firefox } from "@playwright/test";
import { replay, validate } from "./focus.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const engine = process.env.FOCUS_BROWSER === "firefox" ? firefox : chromium;

test("the same route catches the deleted invoker and verifies the full repair", () => {
  function run(...override) {
    return spawnSync(process.execPath, ["cli.mjs", "examples/archive-flow.json", ...override],
      { cwd: root, encoding: "utf8", timeout: 45000 });
  }
  const broken = run("inbox.html#regression");
  assert.equal(broken.status, 1, broken.stderr);
  const failure = JSON.parse(broken.stdout);
  assert.equal(failure.passed, false);
  assert.equal(failure.checks.length, 8);
  assert.deepEqual(failure.checks.at(-1), {
    step: 8, key: "Enter", expected: { role: "button", name: "封存 到貨紀錄" },
    passed: false, reason: "wrong-focus", matches: 1, active: { tag: "body", id: null }
  });
  const fixed = run();
  assert.equal(fixed.status, 0, fixed.stderr);
  const report = JSON.parse(fixed.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.planned, 11);
  assert.deepEqual(report.checks.map(c => c.active.id),
    ["stock", "cancel", "confirm", "cancel", "stock", "cancel", "confirm", "deliveries", "cancel", "confirm", "queue"]);
  const missing = run("missing-fixture.html");
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
});

test("reports missing and duplicate accessible targets, including duplicated labels", async t => {
  const browser = await engine.launch();
  t.after(() => browser.close());
  for (const [labels, reason, matches] of [[["Other"], "missing-target", 0], [["Next", "Next"], "ambiguous-target", 2]]) {
    const page = await browser.newPage();
    await page.setContent(labels.map(label => '<button aria-label="' + label + '">→</button>').join(""));
    const result = await replay(page, [{key: "Tab", role: "button", name: "Next"}], 150);
    assert.deepEqual([result.checks[0].reason, result.checks[0].matches], [reason, matches]);
    await page.close();
  }
});

test("recognizes a delayed focus move inside an open shadow root", async t => {
  const browser = await engine.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<button>Open</button><div id="host"></div>');
  await page.evaluate(() => {
    const root = document.getElementById("host").attachShadow({mode: "open"});
    root.innerHTML = '<span id="label">Next item</span><button id="next" aria-labelledby="label">→</button>';
    document.querySelector("button").onclick = () => setTimeout(() => root.getElementById("next").focus(), 60);
  });
  const report = await replay(page, [{key: "Tab", role: "button", name: "Open"},
    {key: "Enter", role: "button", name: "Next item"}]);
  assert.equal(report.passed, true);
  assert.equal(report.checks[1].active.id, "next");
});

test("rejects empty routes, unsupported keys and missing expectations", () => {
  for (const steps of [[], [null], [{key: "PageUp", role: "button", name: "A"}],
    [{key: "Tab", role: "", name: "A"}], [{key: "Tab", role: "button"}]]) {
    assert.throws(() => validate({page: "inbox.html", steps}));
  }
});
