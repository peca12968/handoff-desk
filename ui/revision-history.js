import { quoteLocation } from "./quote-location.js";

const pageSize = 20;

export function revisionHistory({ read, canStage, matchesEditor, stage, quoteKey }) {
  const get = name => document.getElementById("history-" + name);
  const toggle = get("toggle"), panel = get("panel"), versions = get("version");
  const newer = get("newer"), older = get("older"), stageButton = get("stage");
  const message = get("status"), comparison = get("comparison");
  let head = null, selected = null, top = 0, active = null;
  const selectedText = get("selected-text");
  const showQuote = quoteLocation({
    source: selectedText, output: get("head-text"), locate: get("locate"), clear: get("clear-quote"),
    status: get("quote-status"), storageKey: quoteKey, selected: () => selected, head: () => head,
  });

  function sync(available) {
    if (available !== undefined) document.getElementById("revision-history").hidden = !available;
    const different = selected && head && selected.rev < head.rev;
    const editable = canStage();
    stageButton.disabled = !different || !editable || matchesEditor(selected);
    get("stage-hint").hidden = !different || editable;
  }

  function begin() {
    active?.abort();
    active = new AbortController();
    selected = null;
    comparison.hidden = true;
    message.textContent = "正在讀取版本…";
    sync();
    return active.signal;
  }

  function fail(error, signal) {
    if (!signal.aborted) message.textContent = error instanceof TypeError ? "連線失敗，請更新版本列表。" : error.message;
  }

  async function choose() {
    if (!head || !versions.value) return;
    const revision = Number(versions.value);
    const signal = begin();
    try {
      const value = revision === head.rev ? head : await read(revision, signal);
      if (signal.aborted) return;
      if (value.rev !== revision) throw Error("伺服器回傳的版號與選取版本不符。");
      selected = value;
      get("selected-title").textContent = `已選第 ${selected.rev} 版`;
      selectedText.value = selected.text;
      selectedText.setSelectionRange(0, 0);
      get("head-title").textContent = `對照第 ${head.rev} 版`;
      showQuote();
      comparison.hidden = false;
      message.textContent = selected.text === head.text ? "兩版內容相同。" : "兩版內容有差異。";
      sync();
    } catch (error) { fail(error, signal); }
  }

  function showPage(topRevision, selectRevision = topRevision) {
    top = topRevision;
    const bottom = Math.max(1, top - pageSize + 1);
    versions.replaceChildren(...Array.from({ length: top - bottom + 1 }, (_, index) => {
      const revision = top - index;
      return new Option(`第 ${revision} 版`, String(revision));
    }));
    versions.value = String(selectRevision);
    versions.disabled = false;
    newer.disabled = top === head.rev;
    older.disabled = bottom === 1;
    get("range").textContent = `第 ${bottom}–${top} 版`;
    choose();
  }

  async function refresh() {
    head = null;
    versions.replaceChildren();
    versions.disabled = newer.disabled = older.disabled = true;
    get("range").textContent = "";
    const signal = begin();
    try {
      const current = await read(undefined, signal);
      if (signal.aborted) return;
      head = current;
      showPage(head.rev, Math.max(1, head.rev - 1));
    } catch (error) { fail(error, signal); }
  }

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    toggle.textContent = panel.hidden ? "查看版本歷史" : "收合版本歷史";
    if (panel.hidden) active?.abort();
    else refresh();
  });
  versions.addEventListener("change", choose);
  get("refresh").addEventListener("click", refresh);
  newer.addEventListener("click", () => showPage(Math.min(head.rev, top + pageSize)));
  older.addEventListener("click", () => showPage(top - pageSize));
  stageButton.addEventListener("click", () => {
    if (!stageButton.disabled && canStage() && !matchesEditor(selected)) stage(selected);
  });
  return { sync };
}
