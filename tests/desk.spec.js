import { expect, test } from "@playwright/test";
import { replay } from "focus-receipt/focus.mjs";

const editor = page => page.getByRole("textbox", { name: "交班內容" });
const action = (page, name) => page.getByRole("button", { name, exact: true });

async function create(page, text) {
  await page.goto("/");
  await editor(page).fill(text);
  await action(page, "建立紀錄").click();
  await expect(page.getByRole("status")).toHaveText("已儲存第 1 版");
}

test("keyboard review returns to the preserved draft and persists the merge", async ({ page, context, request }) => {
  await create(page, "交接原稿");
  const peer = await context.newPage();
  await peer.goto(page.url());
  await expect(editor(peer)).toHaveValue("交接原稿");
  await page.bringToFront();
  await editor(page).fill("交接原稿\n早班盤點");
  await action(page, "儲存修改").click();
  await expect(page.getByRole("status")).toHaveText("已儲存第 2 版");

  async function press(...checks) {
    const steps = checks.map(([key, role, name]) => ({ key, role, name }));
    const report = await replay(peer, steps);
    expect(report.passed, JSON.stringify(report.checks.at(-1))).toBe(true);
  }
  await peer.bringToFront();
  await press(["Tab", "link", "在新分頁開啟"], ["Tab", "textbox", "交班內容"]);
  await peer.keyboard.press("Control+End");
  await peer.keyboard.insertText("\n晚班複查");
  await press(["Tab", "button", "儲存修改"], ["Enter", "heading", "版本對照"]);
  await expect(peer.locator("#latest-text")).toHaveText("交接原稿\n早班盤點");
  await press(["Tab", "button", "返回草稿編輯"], ["Enter", "textbox", "交班內容"]);
  await expect(editor(peer)).toHaveValue("交接原稿\n晚班複查");
  await peer.keyboard.press("Control+End");
  await peer.keyboard.insertText("\n早班盤點");
  await press(["Tab", "button", "儲存合併結果"], ["Enter", "textbox", "交班內容"]);
  await expect(peer.getByRole("status")).toHaveText("已儲存第 3 版");
  const id = new URL(peer.url()).searchParams.get("note");
  const revision = await request.get("/api/notes/" + id + "/revisions/3");
  expect(revision.status()).toBe(200);
  expect(await revision.text()).toBe("交接原稿\n晚班複查\n早班盤點");
});

test("two editors resolve a stale draft, including another update during review", async ({ page, context, request }, testInfo) => {
  const original = "冷藏庫溫度已記錄。";
  const morning = original + "\n早班：已換感測器。";
  const night = original + "\n晚班：待複查。";
  await create(page, original);
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "在新分頁開啟" }).click();
  const peer = await opened;
  await expect(editor(peer)).toHaveValue(original);

  await page.bringToFront();
  await editor(page).fill(morning);
  await action(page, "儲存修改").click();
  await expect(page.getByRole("status")).toHaveText("已儲存第 2 版");
  await peer.bringToFront();
  await editor(peer).fill(night);
  await action(peer, "儲存修改").click();
  await expect(peer.getByText("伺服器最新 · 第 2 版")).toBeVisible();
  await expect(peer.locator("#base-text")).toHaveText(original);
  await expect(peer.locator("#latest-text")).toHaveText(morning);
  await expect(editor(peer)).toHaveValue(night);
  await peer.screenshot({ path: testInfo.outputPath("review.png"), fullPage: true });

  const firstMerge = morning + "\n晚班：待複查。";
  const morningUpdate = morning + "\n早班：備品在二樓。";
  await editor(peer).fill(firstMerge);
  await page.bringToFront();
  await editor(page).fill(morningUpdate);
  await action(page, "儲存修改").click();
  await expect(page.getByRole("status")).toHaveText("已儲存第 3 版");
  await peer.bringToFront();
  await action(peer, "儲存合併結果").click();
  await expect(peer.getByText("伺服器最新 · 第 3 版")).toBeVisible();
  await expect(peer.locator("#base-text")).toHaveText(morning);
  await expect(peer.locator("#latest-text")).toHaveText(morningUpdate);
  await expect(editor(peer)).toHaveValue(firstMerge);

  const merged = morningUpdate + "\n晚班：待複查。";
  await editor(peer).fill(merged);
  await action(peer, "儲存合併結果").click();
  await expect(peer.getByRole("status")).toHaveText("已儲存第 4 版");
  await expect(peer.locator("#conflict")).toBeHidden();
  await page.bringToFront();
  await page.reload();
  await expect(editor(page)).toHaveValue(merged);
  const id = new URL(page.url()).searchParams.get("note");
  for (const [i, expected] of [original, morning, morningUpdate, merged].entries()) {
    const response = await request.get("/api/notes/" + id + "/revisions/" + (i + 1));
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe(expected);
  }
});

test("UTF-8 byte limit and controls fit a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  const button = action(page, "建立紀錄");
  await expect(button).toBeDisabled();
  await editor(page).fill("交".repeat(5461) + "AB");
  await expect(button).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("超過");
  await editor(page).fill("交".repeat(5461) + "A");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole("status")).toHaveText("已儲存第 1 版");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});

test("keeps input when a save cannot reach the API", async ({ page }) => {
  await create(page, "原稿");
  await page.route("**/api/notes/*", route => route.abort());
  await editor(page).fill("未傳出的草稿");
  await action(page, "儲存修改").click();
  await expect(page.getByRole("status")).toContainText("重試");
  await expect(editor(page)).toHaveValue("未傳出的草稿");
  await expect(action(page, "儲存修改")).toBeFocused();
  await page.unroute("**/api/notes/*");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("已儲存第 2 版");
  await expect(editor(page)).toBeFocused();
});

test("keyboard retry recovers the editor after a failed initial read", async ({ page }) => {
  await create(page, "冷藏庫");
  await page.route("**/api/notes/*", route => route.abort());
  await page.reload();
  await expect(action(page, "重新讀取")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(action(page, "重新讀取")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(action(page, "重新讀取")).toBeEnabled();
  await expect(action(page, "重新讀取")).toBeFocused();
  await page.unroute("**/api/notes/*");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveValue("冷藏庫");
});

test("a delayed save preserves focus when the user has moved elsewhere", async ({ page }) => {
  await create(page, "原稿");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/notes/*", async route => {
    await gate;
    await route.continue();
  });
  await editor(page).fill("延後送出");
  const sent = page.waitForRequest(req => req.method() === "PUT");
  await action(page, "儲存修改").click();
  await sent;
  const link = page.getByRole("link", { name: "在新分頁開啟" });
  try {
    await link.focus();
  } finally {
    release();
  }
  await expect(page.getByRole("status")).toHaveText("已儲存第 2 版");
  await expect(link).toBeFocused();
});

test("missing and malformed links cannot create or overwrite a note", async ({ page }) => {
  await page.goto("/?note=00000000-0000-0000-0000-000000000000");
  await expect(page.getByRole("status")).toContainText("找不到");
  await expect(editor(page)).toBeDisabled();
  await page.goto("/?note=oops");
  await expect(page.getByRole("status")).toHaveText("紀錄網址格式有誤");
  await expect(editor(page)).toBeDisabled();
});
