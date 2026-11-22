import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { merge, render } from "./merge.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const fixture = name => readFileSync(join(root, "examples", name + ".txt"), "utf8");
const records = (...items) => items.map(item => item + "\n").join("");

test("two independent changes survive a manual decision on the delivery time", () => {
  const plan = merge(fixture("base"), fixture("local"), fixture("incoming"));
  assert.equal(plan.conflicts, 1);
  const conflict = plan.chunks.find(c => c.type === "conflict");
  assert.deepEqual(conflict, { type: "conflict", start: 2, end: 3, base: "送貨：預定下午\n",
    local: "送貨：延後至四點\n", incoming: "送貨：改到三點\n", resolution: null });
  assert.throws(() => render(plan), /Choose a resolution/);
  conflict.resolution = { text: "送貨：已聯絡司機，三點半抵達\n" };
  assert.equal(render(plan), records("冷藏庫：晚班已量測", "聯絡人：早班", "送貨：已聯絡司機，三點半抵達", "收貨口：北門", "備品：二樓"));
});

test("adjacent replacements, insertion boundaries and overlapping delete/edit", () => {
  const base = records("a", "b", "c");
  for (const [local, incoming, expected] of [
    [records("A", "b", "c"), records("a", "B", "c"), records("A", "B", "c")],
    [records("a", "c"), records("a", "x", "b", "c"), records("a", "x", "c")],
    [records("a", "c"), records("a", "b", "x", "c"), records("a", "x", "c")],
    [records("a", "x", "b", "c"), records("a", "x", "b", "c"), records("a", "x", "b", "c")]
  ]) {
    assert.equal(render(merge(base, local, incoming)), expected);
    assert.equal(render(merge(base, incoming, local)), expected);
  }
  for (const [local, incoming] of [[records("a", "c"), records("a", "B", "c")],
    [records("a", "x", "b", "c"), records("a", "y", "b", "c")], ["", records("a", "x", "b", "c")]]) {
    const plan = merge(base, local, incoming);
    assert.equal(plan.conflicts, 1);
    const conflict = plan.chunks.find(c => c.type === "conflict");
    for (const [side, expected] of Object.entries({local, incoming, base})) {
      conflict.resolution = side;
      assert.equal(render(plan), expected);
    }
  }
});

test("a chain of overlaps is one decision and retains each side's interior context", () => {
  const base = records("a", "b", "c", "d", "e", "f", "g");
  const local = records("A", "B", "c", "D", "E", "f", "g");
  const incoming = records("a", "B2", "C2", "D2", "e", "f", "g");
  const plan = merge(base, local, incoming);
  assert.equal(plan.conflicts, 1);
  const [conflict] = plan.chunks;
  assert.deepEqual([conflict.start, conflict.end], [0, 5]);
  for (const [side, expected] of Object.entries({base, local, incoming})) {
    conflict.resolution = side;
    assert.equal(render(plan), expected);
  }
});

test("all 729 assignments of six independent edits agree with a direct construction", () => {
  const original = Array.from({length: 6}, (_, i) => "欄位" + i);
  for (let pattern = 0; pattern < 3 ** original.length; pattern++) {
    const local = [], incoming = [], expected = [], base = [];
    let digits = pattern;
    for (const [i, line] of original.entries()) {
      const owner = digits % 3;
      digits = Math.floor(digits / 3);
      const left = owner === 1 ? "本頁" + i : line;
      const right = owner === 2 ? "伺服器" + i : line;
      const anchor = "分隔" + i;
      base.push(line, anchor);
      local.push(left, anchor);
      incoming.push(right, anchor);
      expected.push(owner === 1 ? left : right, anchor);
    }
    assert.equal(render(merge(records(...base), records(...local), records(...incoming))), records(...expected));
  }
});

test("identity and exact terminators survive insertions, repeated lines and empty files", () => {
  for (const base of ["", "\n", "x\r\nx\r\nx", "冷\r熱\n", "\ufeffa\r\n", "x\nx\nx\n"]) {
    for (const edited of ["", "y", "y\r\n", base + "🙂\r", base + base, "\r\n" + base]) {
      for (const [a, b] of [[base, edited], [edited, base], [edited, edited]]) {
        assert.equal(render(merge(base, a, b)), edited);
      }
    }
  }
});

test("large unchanged borders and one-sided edits avoid the comparison limit", () => {
  const border = "unchanged\n".repeat(3000);
  assert.equal(render(merge(border + "x\ny\n", border + "L\ny\n", border + "x\nR\n")), border + "L\nR\n");
  const a = "a\n".repeat(2200), b = "b\n".repeat(2200), c = "c\n".repeat(2200);
  assert.equal(render(merge(a, b, b)), b);
  assert.throws(() => merge(a, b, c), RangeError);
});

test("CLI emits a complete plan on conflict and never emits partial resolved text", t => {
  const temp = mkdtempSync(join(tmpdir(), "draft-weave-"));
  t.after(() => rmSync(temp, {recursive: true, force: true}));
  const cli = (...args) => spawnSync(process.execPath, ["cli.mjs", ...args], { cwd: root, encoding: "utf8" });
  const result = cli("plan", "examples/base.txt", "examples/local.txt", "examples/incoming.txt");
  assert.equal(result.status, 1, result.stderr);
  const path = join(temp, "plan.json");
  writeFileSync(path, result.stdout);
  const incomplete = cli("resolve", path);
  assert.equal(incomplete.status, 2);
  assert.equal(incomplete.stdout, "");
  const plan = JSON.parse(result.stdout);
  plan.chunks.find(c => c.type === "conflict").resolution = "incoming";
  writeFileSync(path, JSON.stringify(plan));
  const resolved = cli("resolve", path);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout, fixture("incoming").replace("待量測", "晚班已量測"));
  writeFileSync(path, Buffer.from([0xff]));
  assert.equal(cli("plan", path, path, path).status, 2);
});
