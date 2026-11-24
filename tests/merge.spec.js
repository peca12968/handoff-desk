import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const editor = page => page.getByRole("textbox", { name: "交班內容" });

async function conflict(page, request, base, local, incoming) {
  const original = await request.post("/api/notes", { data: base, headers: { "Content-Type": "text/plain" } });
  expect(original.status()).toBe(201);
  const path = "/api" + original.headers().location;
  await page.goto("/?note=" + path.split("/").at(-1));
  await expect(editor(page)).toHaveValue(base);
  async function publish(text, etag) {
    const result = await request.put(path, { data: text, headers: { "Content-Type": "text/plain", "If-Match": etag } });
    expect(result.ok()).toBeTruthy();
    return result.headers().etag;
  }
  const tag = await publish(incoming, original.headers().etag);
  await editor(page).fill(local);
  await button(page, "儲存修改").click();
  await expect(page.getByRole("heading", { name: "版本對照" })).toBeVisible();
  return { path, tag, publish };
}

test("review only conflicting lines, then rebase a resolved draft after a third writer", async ({ page, request }, testInfo) => {
  const base = "冷藏庫：待量測\n聯絡人：早班\n送貨：下午\n收貨口：北門\n備品：一樓";
  const local = base.replace("待量測", "已量測").replace("下午", "四點");
  const incoming = base.replace("下午", "三點").replace("一樓", "二樓");
  const {path, tag, publish} = await conflict(page, request, base, local, incoming);
  await button(page, "預覽三方合併").click();
  await expect(page.getByRole("heading", {name: "合併預覽"})).toBeFocused();
  await expect(button(page, "套用到草稿")).toBeDisabled();
  await expect(button(page, "儲存合併結果")).toBeDisabled();
  await expect(editor(page)).toHaveValue(local);
  const third = incoming.replace("北門", "西門");
  await publish(third, tag);
  const group = page.getByRole("group", {name: "原稿第 3 行"});
  await group.getByRole("radio", {name: /本頁草稿/}).check();
  const combined = incoming.replace("待量測", "已量測").replace("三點", "四點");
  await expect(page.locator("#result-text")).toHaveText(combined, {useInnerText: false});
  await page.locator("#conflict").screenshot({path: testInfo.outputPath("merge.png")});
  await button(page, "套用到草稿").click();
  await expect(editor(page)).toHaveValue(combined);
  await expect(editor(page)).toBeFocused();
  expect(await (await request.get(path)).text()).toBe(third);
  await button(page, "儲存修改").click();
  await expect(page.locator("#base-text")).toHaveText(incoming);
  await expect(editor(page)).toHaveValue(combined);
  await button(page, "預覽三方合併").click();
  await expect(page.getByRole("radio")).toHaveCount(0);
  const final = combined.replace("北門", "西門");
  await expect(page.locator("#result-text")).toHaveText(final);
  await button(page, "套用到草稿").click();
  await button(page, "儲存修改").click();
  await expect(page.getByRole("status")).toHaveText("已儲存第 4 版");
  for (const [i, expected] of [base, incoming, third, final].entries()) {
    const revision = await request.get(path + "/revisions/" + (i + 1));
    expect(revision.status()).toBe(200);
    expect(await revision.text()).toBe(expected);
  }
});

test("cancel or edit invalidates preview, and applied text still obeys the byte limit", async ({page, request}) => {
  const local = "晚".repeat(3000) + "\n中\n尾";
  const incoming = "首\n中\n" + "早".repeat(3000);
  const {path} = await conflict(page, request, "首\n中\n尾", local, incoming);
  await button(page, "預覽三方合併").click();
  await button(page, "取消預覽").click();
  await expect(button(page, "預覽三方合併")).toBeFocused();
  await expect(editor(page)).toHaveValue(local);
  await button(page, "預覽三方合併").click();
  await editor(page).fill(local.replace("中", "中段更新"));
  await expect(button(page, "套用到草稿")).toBeHidden();
  await button(page, "預覽三方合併").click();
  await button(page, "套用到草稿").click();
  await expect(editor(page)).toHaveValue("晚".repeat(3000) + "\n中段更新\n" + "早".repeat(3000));
  await expect(page.getByRole("status")).toHaveText("合併結果超過 16,384 位元組，請縮短文字。");
  await expect(button(page, "儲存修改")).toBeDisabled();
  expect(await (await request.get(path)).text()).toBe(incoming);
});

const recovery = JSON.parse(await readFile(new URL("../examples/review-recovery.json", import.meta.url), "utf8"));
const reviewGroup = (page, line) => page.getByRole("group", { name: "原稿第 " + line + " 行", exact: true });
const choices = { base: /原稿/, local: /本頁草稿/, incoming: /伺服器最新/ };

test("restores review choices only where all three conflict texts still match", async ({page, request}) => {
  await page.setViewportSize({width:360, height:800});
  page.on("dialog", dialog => dialog.accept());
  const {path, tag, publish} = await conflict(page, request, recovery.base, recovery.draft, recovery.incoming);
  await button(page, "預覽三方合併").click();
  for (const {line, side} of recovery.choices) await reviewGroup(page, line).getByRole("radio", {name:choices[side]}).check();
  await expect(page.locator("#result-text")).toHaveText(recovery.merged);

  await page.reload();
  await expect(page.locator("#review-resume")).toBeVisible();
  await expect(editor(page)).toHaveValue(recovery.draft);
  await button(page, "預覽三方合併").click();
  for (const {line, side} of recovery.choices)
    await expect(reviewGroup(page, line).getByRole("radio", {name:choices[side]})).toBeChecked();
  await expect(page.locator("#result-text")).toHaveText(recovery.merged);
  expect(await (await request.get(path)).text()).toBe(recovery.incoming);

  await publish(recovery.newer, tag);
  await page.reload();
  await expect(page.locator("#latest-text")).toHaveText(recovery.newer);
  await button(page, "預覽三方合併").click();
  for (const {line, side} of recovery.restored) {
    const group = reviewGroup(page, line);
    if (side) await expect(group.getByRole("radio", {name:choices[side]})).toBeChecked();
    else await expect(group.locator("input:checked")).toHaveCount(0);
  }
  await expect(button(page, "套用到草稿")).toBeDisabled();
  await expect(page.locator("#review-count")).toHaveText("還有 1 處需選擇保留的文字。");
  await reviewGroup(page, 5).getByRole("radio", {name:choices.incoming}).check();
  await expect(page.locator("#result-text")).toHaveText(recovery.updated_merged);
  await button(page, "套用到草稿").click();
  expect(await (await request.get(path)).text()).toBe(recovery.newer);
  await button(page, "儲存修改").click();
  await expect(page.getByRole("status")).toHaveText("已儲存第 4 版");
  expect(await (await request.get(path + "/revisions/4")).text()).toBe(recovery.updated_merged);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});

test("cancel and manual editing remove saved review choices", async ({page, request}) => {
  page.on("dialog", dialog => dialog.accept());
  await conflict(page, request, recovery.base, recovery.draft, recovery.incoming);
  const select = async () => {
    await button(page, "預覽三方合併").click();
    const group = reviewGroup(page, 3);
    await expect(group.locator("input:checked")).toHaveCount(0);
    await group.getByRole("radio", {name:choices.local}).check();
  };
  await select();
  await button(page, "取消預覽").click();
  await select();
  await editor(page).fill(recovery.draft + "\n備註：已回覆");
  await page.reload();
  await expect(page.getByRole("heading", {name:"版本對照"})).toBeVisible();
  await expect(page.locator("#review-resume")).toBeHidden();
  await button(page, "預覽三方合併").click();
  await expect(page.locator("#choices input:checked")).toHaveCount(0);
});

test("large line comparisons leave manual reconciliation available", async ({page, request}) => {
  const local = "b\n".repeat(2100);
  await conflict(page, request, "a\n".repeat(2100), local, "c\n".repeat(2100));
  await button(page, "預覽三方合併").click();
  await expect(page.getByRole("status")).toHaveText("兩版差異過大，請依版本對照手動整合。");
  await expect(editor(page)).toHaveValue(local);
  await expect(button(page, "儲存合併結果")).toBeEnabled();
});
