import { expect, test } from "@playwright/test";
import texts from "../examples/revision-history.json" with { type: "json" };

const editor = page => page.getByRole("textbox", { name: "交班內容" });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const historyPanel = page => page.getByRole("region", { name: "版本歷史" });

async function create(page, text) {
  await page.goto("/");
  await editor(page).fill(text);
  await button(page, "建立紀錄").click();
  await expect(page.getByRole("status")).toHaveText("已儲存第 1 版");
  return "/api/notes/" + new URL(page.url()).searchParams.get("note");
}

async function write(request, endpoint, text) {
  const head = await request.get(endpoint);
  const saved = await request.put(endpoint, { headers: {
    "Content-Type": "text/plain; charset=utf-8", "If-Match": head.headers().etag
  }, data: text });
  expect(saved.status()).toBe(204);
}

test("history stages a reversible draft and keeps the ETag through a concurrent edit", async ({ page, request }) => {
  const endpoint = await create(page, texts.original);
  await write(request, endpoint, texts.initial_head);
  await page.reload();
  await expect(editor(page)).toHaveValue(texts.initial_head);
  await button(page, "查看版本歷史").click();
  const history = historyPanel(page);
  const stage = history.getByRole("button", { name: "載入舊版至草稿" });
  await expect(history.locator("#history-selected-text")).toHaveText(texts.original);
  await expect(history.locator("#history-head-text")).toHaveText(texts.initial_head);
  await editor(page).fill("尚未儲存的交班修改");
  await expect(stage).toBeDisabled();
  await expect(history.locator("#history-selected-text")).toHaveText(texts.original);
  await editor(page).fill(texts.initial_head);
  await expect(stage).toBeEnabled();

  await write(request, endpoint, texts.concurrent);
  await stage.click();
  await expect(editor(page)).toHaveValue(texts.original);
  await expect(editor(page)).toBeFocused();
  const still = await request.get(endpoint);
  expect(still.headers()["handoff-revision"]).toBe("3");
  expect(await still.text()).toBe(texts.concurrent);
  const attempted = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(endpoint));
  await button(page, "儲存修改").click();
  expect((await attempted).status()).toBe(412);
  await expect(page.locator("#latest-text")).toHaveText(texts.concurrent);
  await expect(editor(page)).toHaveValue(texts.original);
  await editor(page).fill(texts.merged);
  await button(page, "儲存合併結果").click();
  await expect(page.getByRole("status")).toHaveText("已儲存第 4 版");
  for (const [index, value] of [texts.original, texts.initial_head, texts.concurrent, texts.merged].entries()) {
    const revision = await request.get(`${endpoint}/revisions/${index + 1}`);
    expect(revision.status()).toBe(200);
    expect(await revision.text()).toBe(value);
  }
});

test("paginates immutable revisions and ignores late previews on a phone", async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const endpoint = await create(page, "內容 1");
  for (let rev = 2; rev <= 23; rev++) await write(request, endpoint, `內容 ${rev}`);
  let unblock, observed;
  const gate = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { observed = resolve; });
  await page.route("**/revisions/22", async route => {
    const response = await route.fetch();
    observed();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.reload();
  await expect(editor(page)).toHaveValue("內容 23");
  const history = historyPanel(page);
  const select = history.getByLabel("查看版本");
  const preview = history.locator("#history-selected-text");
  try {
    await button(page, "查看版本歷史").click();
    await started;
    await expect(select.getByRole("option")).toHaveCount(20);
    await select.selectOption("21");
    await expect(preview).toHaveText("內容 21");
  } finally { unblock(); }
  await expect(preview).toHaveText("內容 21");
  await history.getByRole("button", { name: "較舊版本" }).click();
  await expect(select.getByRole("option")).toHaveCount(3);
  await select.selectOption("1");
  await expect(preview).toHaveText("內容 1");
  await expect(history.getByRole("button", { name: "較舊版本" })).toBeDisabled();
  await write(request, endpoint, "內容 24");
  await expect(history.locator("#history-head-text")).toHaveText("內容 23");
  await history.getByRole("button", { name: "更新版本列表" }).click();
  await expect(history.locator("#history-head-text")).toHaveText("內容 24");
  await expect(editor(page)).toHaveValue("內容 23");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
