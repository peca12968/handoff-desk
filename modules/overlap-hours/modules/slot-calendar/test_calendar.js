import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import ICAL from "ical.js";

const upstream = path.resolve(process.env.OVERLAP_DIR || "../..");
const fixture = JSON.parse(readFileSync("examples/handoff-result.json", "utf8"));
const first = "2024-11-04T13:30Z";
const uid = "handoff-20241104@example.invalid";
let temp, api, server;

before(async () => {
  temp = mkdtempSync(path.join(tmpdir(), "slot-calendar-"));
  server = spawn("dotnet", [path.join(upstream, "src/bin/Release/net10.0/overlap-hours.dll"),
    "--urls", "http://127.0.0.1:0"], { stdio: ["ignore", "pipe", "inherit"] });
  const timer = setTimeout(() => server.kill(), 20_000);
  try {
    const lines = createInterface({ input: server.stdout });
    for await (const line of lines) {
      const match = line.match(/Now listening on: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { api = match[1]; break; }
    }
    assert.ok(api, "build the Overlap Hours API in Release mode before running tests");
    server.stdout.resume();
  } finally {
    clearTimeout(timer);
  }
});
after(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  if (temp) rmSync(temp, { recursive: true, force: true });
});

async function search(query) {
  const response = await fetch(api + "/availability/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query)
  });
  assert.equal(response.status, 200);
  return response.json();
}

function run(report, { start = first, title = "交班會議", revision = 0, ok = true } = {}) {
  const input = path.join(temp, "report.json"), output = path.join(temp, "handoff.ics");
  writeFileSync(input, JSON.stringify(report));
  const result = spawnSync(process.env.PYTHON || "python", ["slot_calendar.py", input, "--start", start,
    "--title", title, "--uid", uid, "--revision", String(revision), "-o", output], { encoding: "utf8" });
  assert.equal(result.status, ok ? 0 : 2, result.stderr);
  if (!ok) { assert.doesNotMatch(result.stderr, /Traceback/); return readFileSync(output); }
  const raw = readFileSync(output);
  const component = new ICAL.Component(ICAL.parse(raw.toString("utf8")));
  assert.equal(component.name, "vcalendar");
  const events = component.getAllSubcomponents("vevent");
  assert.equal(events.length, 1);
  return { raw, event: new ICAL.Event(events[0]) };
}

test("real two-city API response round-trips into one selected UTC event", async () => {
  const query = JSON.parse(readFileSync(path.join(upstream, "examples/support-handoff.json"), "utf8"));
  const report = await search(query);
  assert.deepEqual(report, fixture);
  const { event } = run(report, { start: "2024-11-04T21:30+08:00" });
  assert.equal(event.uid, uid);
  assert.equal(event.startDate.toJSDate().toISOString(), "2024-11-04T13:30:00.000Z");
  assert.equal(event.endDate.toJSDate().toISOString(), "2024-11-04T14:15:00.000Z");
  assert.equal(event.duration.toSeconds(), 45 * 60);
  assert.match(event.description, /design \(Asia\/Taipei\).*T21:30\+08:00/);
  assert.match(event.description, /engineering \(America\/New_York\).*T08:30-05:00/);
  assert.match(event.description, /support-west/);
  assert.doesNotMatch(event.description, /support-east/);
});

test("downloadable example has the same schedule and roster as a fresh export", () => {
  const component = new ICAL.Component(ICAL.parse(readFileSync("examples/handoff.ics", "utf8")));
  const bundled = new ICAL.Event(component.getFirstSubcomponent("vevent"));
  const fresh = run(fixture, { title: "跨站交班會議" }).event;
  for (const field of ["uid", "summary", "description", "sequence"]) assert.equal(bundled[field], fresh[field]);
  for (const field of ["startDate", "endDate"]) assert.equal(bundled[field].toString(), fresh[field].toString());
});

test("two occurrences of local 01:00 remain distinct across a fall clock change", async () => {
  const report = await search({ start: "2024-11-03T05:00Z", end: "2024-11-03T07:00Z",
    durationMinutes: 60, stepMinutes: 60, participants: [{ id: "support", zone: "America/New_York",
      working: [{ days: [7], start: "01:00", end: "02:00" }] }] });
  const early = run(report, { start: "2024-11-03T01:00-04:00" }).event;
  const late = run(report, { start: "2024-11-03T01:00-05:00", revision: 1 }).event;
  assert.equal(early.endDate.toJSDate().getTime(), late.startDate.toJSDate().getTime());
  assert.equal(late.startDate.toJSDate() - early.startDate.toJSDate(), 3600000);
  assert.equal(early.uid, late.uid);
  assert.equal(early.sequence, 0);
  assert.equal(late.sequence, 1);
  assert.match(early.description, /01:00-04:00 .* 2024-11-03T01:00-05:00/);
});

test("folds Unicode by byte length and round-trips punctuation and multiline TEXT", () => {
  const title = "跨班組📅".repeat(24) + "，討論, 分工; 路徑\\文件\n第二行";
  const { raw, event } = run(fixture, { title });
  assert.equal(event.summary, title);
  const text = raw.toString("utf8");
  assert.ok(text.endsWith("\r\n"));
  assert.doesNotMatch(text.replaceAll("\r\n", ""), /[\r\n]/);
  assert.match(text, /\r\n /);
  for (const line of text.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(raw.includes(Buffer.from("�")), false);
});

test("missing or ambiguous selection and inconsistent local rows preserve previous export", () => {
  const original = run(fixture).raw;
  const badRows = structuredClone(fixture);
  badRows.slots[0].local[0].start = "2024-11-04T21:31+08:00";
  const duplicate = { slots: [fixture.slots[0], fixture.slots[0]] };
  for (const [report, options] of [[fixture, { start: "2024-11-04T13:00Z" }], [duplicate, {}],
    [badRows, {}], [fixture, { start: "2024-11-04T13:30" }], [fixture, { revision: -1 }],
    [{ slots: [] }, {}], [fixture, { title: "  " }]]) {
    assert.deepEqual(run(report, { ...options, ok: false }), original);
  }
});
