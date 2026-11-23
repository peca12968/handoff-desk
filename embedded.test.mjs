import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { chromium, firefox } from "@playwright/test";
import { replay, validate } from "./focus.mjs";

const engine = process.env.FOCUS_BROWSER === "firefox" ? firefox : chromium;
const fixture = name => readFile(new URL("./examples/" + name, import.meta.url), "utf8");

test("identical accessible names in nested cross-origin frames keep independent focus receipts", async t => {
  const [desk, delivery, contact, flow] = await Promise.all(
    ["desk.html", "delivery.html", "contact.html", "embedded-flow.json"].map(fixture));
  const steps = JSON.parse(flow).steps;
  const browser = await engine.launch();
  t.after(() => browser.close());
  let primary, secondary;
  async function serve(render) {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(render(req.url));
    });
    const ready = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await ready;
    t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
    return "http://127.0.0.1:" + server.address().port;
  }
  primary = await serve(path => path === "/contact.html" ? contact :
    desk.replace("delivery.html", secondary + (path === "/broken" ? "/skip" : "/delivery")));
  secondary = await serve(path => delivery.replace("contact.html", primary + "/contact.html")
    .replace('<iframe title="收件人"', (path === "/skip" ? '<iframe hidden' : '<iframe') + ' title="收件人"'));
  const page = await browser.newPage();
  await page.goto(primary);
  const fixed = await replay(page, steps);
  assert.equal(fixed.passed, true, JSON.stringify(fixed));
  assert.deepEqual(fixed.checks.map(check => check.active.id),
    ["start", "address", "contact-save", "delivery-save", "finish", "delivery-save", "contact-save"]);
  assert.deepEqual(fixed.checks[2].active.frames, ["配送資料", "收件人"]);
  assert.deepEqual(fixed.checks[3].active.frames, ["配送資料"]);
  await page.goto(primary);
  const stale = await replay(page, [...steps.slice(0, 3), steps[2]], 250);
  assert.equal(stale.passed, false);
  assert.equal(stale.checks[3].reason, "wrong-focus");
  assert.equal(stale.checks[3].active.id, "delivery-save");
  await page.goto(primary + "/broken");
  const broken = await replay(page, steps, 250);
  assert.equal(broken.passed, false);
  assert.equal(broken.checks.at(-1).step, 3);
  assert.deepEqual(broken.checks.at(-1).active, {tag: "button", id: "delivery-save", frames: ["配送資料"]});
});

test("frame diagnostics identify the failing path segment", async t => {
  const browser = await engine.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<button>Go</button><iframe title="A"></iframe><iframe title="A"></iframe>');
  for (const [title, reason, count] of [["A", "ambiguous-frame", 2], ["B", "missing-frame", 0]]) {
    const step = {key: "Tab", role: "button", name: "Go", frames: [title]};
    const report = await replay(page, [step], 150);
    assert.deepEqual([report.checks[0].reason, report.checks[0].frame, report.checks[0].matches], [reason, title, count]);
  }
  for (const frames of ["A", [null], [" "]]) {
    assert.throws(() => validate({page: "desk.html", steps: [{key: "Tab", role: "button", name: "Go", frames}]}));
  }
});
