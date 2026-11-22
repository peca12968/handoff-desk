import { openReview, closeReview } from "./merge-review.js";

const $ = id => document.getElementById(id);
const draft = $("draft");
const save = $("save");
const noteId = new URLSearchParams(location.search).get("note");
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const limit = 16_384;
const encoder = new TextEncoder();

let endpoint = noteId === null ? null : "/api/notes/" + encodeURIComponent(noteId);
let base = null;
let latest = null;
let busy = false;

function status(message) {
  $("status").textContent = message;
}

function render() {
  const bytes = encoder.encode(draft.value).length;
  const canEdit = !endpoint || Boolean(base);
  draft.disabled = busy || !canEdit;
  save.disabled = busy || !$("review").hidden || !canEdit || bytes === 0 || bytes > limit ||
    (base && !latest && draft.value === base.text);
  save.textContent = latest ? "儲存合併結果" : base ? "儲存修改" : "建立紀錄";
  $("count").textContent = bytes.toLocaleString("en-US") + " / 16,384 位元組";
  $("version").textContent = base ? "第 " + base.rev + " 版" : endpoint ? "既有紀錄" : "新紀錄";
  $("shared").hidden = !base;
  $("shared").href = location.href;
  $("retry").disabled = busy;
  $("preview").disabled = busy;
  $("conflict").hidden = !latest;
  if (latest) {
    $("base-label").textContent = "編輯依據 · 第 " + base.rev + " 版";
    $("base-text").textContent = base.text;
    $("latest-label").textContent = "伺服器最新 · 第 " + latest.rev + " 版";
    $("latest-text").textContent = latest.text;
  }
}

function version(response, text) {
  const tag = response.headers.get("etag");
  const rev = Number(response.headers.get("handoff-revision"));
  if (!tag || !Number.isSafeInteger(rev) || rev < 1) throw new Error("版本資訊不完整。");
  return { text, tag, rev };
}

async function read() {
  const response = await fetch(endpoint, { cache: "no-store" });
  if (response.status === 404) throw new Error("找不到這份交班紀錄，請確認網址。");
  if (!response.ok) throw new Error("無法讀取紀錄，請稍後重試。");
  const text = await response.text();
  return version(response, text.replace(/\r\n?/g, "\n"));
}

function showSharedGuide() {
  $("guide").textContent = "在新分頁開啟同一份紀錄，即可模擬另一位接班者編輯。";
}

function focusAfterRequest(origin, target) {
  if (origin && (document.activeElement === origin || document.activeElement === document.body)) {
    target.focus();
  }
}

async function openNote() {
  const retry = $("retry");
  const origin = document.activeElement === retry ? retry : null;
  busy = true;
  render();
  try {
    base = await read();
    draft.value = base.text;
    status("已載入第 " + base.rev + " 版");
    showSharedGuide();
    $("retry").hidden = true;
  } catch (error) {
    status(error instanceof TypeError ? "連線失敗，請重新讀取。" : error.message);
    $("retry").hidden = false;
  } finally {
    busy = false;
    render();
    focusAfterRequest(origin, base ? draft : retry);
  }
}

save.addEventListener("click", async () => {
  if (save.disabled) return;
  const origin = document.activeElement === save ? save : null;
  let target = save;
  busy = true;
  render();
  const reviewed = latest || base;
  const text = draft.value;
  const headers = { "Content-Type": "text/plain;charset=utf-8" };
  if (reviewed) headers["If-Match"] = reviewed.tag;
  try {
    const response = await fetch(endpoint || "/api/notes", {
      method: reviewed ? "PUT" : "POST", headers, body: text
    });
    if (response.status === 412 && reviewed) {
      const newer = await read();
      base = reviewed;
      latest = newer;
      status("有更新的版本，草稿已保留");
      $("guide").textContent = "請往下查看版本對照。編輯區仍保有你剛才送出的文字。";
      target = $("comparison");
      return;
    }
    if (!response.ok) throw new Error("儲存失敗，請稍後重試。");
    const saved = version(response, text);
    if (!endpoint) {
      const path = response.headers.get("location") || "";
      const id = path.slice("/notes/".length);
      if (!path.startsWith("/notes/") || !uuid.test(id)) throw new Error("伺服器未提供有效的紀錄網址。");
      history.replaceState(null, "", "?note=" + id);
      endpoint = "/api/notes/" + id;
    }
    base = saved;
    latest = null;
    status("已儲存第 " + saved.rev + " 版");
    showSharedGuide();
    target = draft;
  } catch (error) {
    status(error instanceof TypeError ? "連線中斷，請確認連線後重試。" : error.message);
  } finally {
    busy = false;
    render();
    focusAfterRequest(origin, target);
  }
});

draft.addEventListener("input", () => {
  if (!$("review").hidden) closeReview();
  render();
  if (encoder.encode(draft.value).length > limit) status("內容超過 16,384 位元組，請縮短文字。");
  else if (latest) status("正在編輯合併草稿");
  else status(draft.value === (base?.text ?? "") ? "目前沒有修改" : "有尚未儲存的內容");
});
window.addEventListener("beforeunload", event => {
  if (draft.value !== (base?.text ?? "") || latest) {
    event.preventDefault();
    event.returnValue = "";
  }
});
$("retry").addEventListener("click", openNote);
$("resume").addEventListener("click", () => draft.focus());
$("preview").addEventListener("click", () => {
  if (busy || !latest) return;
  try {
    openReview(base.text, draft.value, latest.text, text => {
      base = latest;
      latest = null;
      draft.value = text;
      closeReview();
      render();
      if (encoder.encode(text).length > limit) status("合併結果超過 16,384 位元組，請縮短文字。");
      else if (!text.length) status("合併結果為空白，請輸入交班內容。");
      else status(text === base.text ? "與已儲存版本相同" : "合併結果已放入草稿");
      showSharedGuide();
      draft.focus();
    });
    render();
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    status("兩版差異過大，請依版本對照手動整合。");
  }
});
$("discard").addEventListener("click", () => {
  closeReview();
  render();
  $("preview").focus();
});
if (noteId === null) {
  status("等待建立");
  render();
} else if (!uuid.test(noteId)) {
  status("紀錄網址格式有誤");
  $("guide").textContent = "請向提供連結的人確認完整網址。";
  render();
} else {
  openNote();
}
