import { capture, resolve } from "../modules/margin-anchor/anchor.mjs";

const bodyLimit = 16_384;

export function quoteLocation({ source, output, locate, clear, status, storageKey, selected, head }) {
  let quote = null;
  let loadedKey;

  function load() {
    const key = storageKey();
    if (key === loadedKey) return;
    loadedKey = key;
    quote = null;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      const { revision, selector } = saved ?? {};
      const strings = [selector?.exact, selector?.prefix, selector?.suffix];
      if (Number.isSafeInteger(revision) && revision > 0 && selector?.type === "TextQuoteSelector" && selector.exact &&
          strings.every(value => typeof value === "string") && strings.reduce((size, value) => size + value.length, 0) <= bodyLimit) {
        quote = saved;
      }
    } catch {
      // Locating quotes within this tab still works without session storage.
    }
  }

  function save() {
    try {
      if (quote) sessionStorage.setItem(loadedKey, JSON.stringify(quote));
      else sessionStorage.removeItem(loadedKey);
    } catch {
      // History remains usable if the browser blocks or exhausts storage.
    }
  }

  function render() {
    load();
    const current = head();
    if (!current) return;
    clear.hidden = !quote;
    output.textContent = current.text;
    status.textContent = "";
    if (!quote) return;
    const { selector, revision } = quote;
    const result = resolve(current.text, selector);
    const location = `第 ${revision} 版選取的文字`;
    if (result.status === "missing") {
      status.textContent = `${location}在第 ${current.rev} 版找不到相同引文。`;
    } else if (result.status === "ambiguous") {
      status.textContent = `${location}在第 ${current.rev} 版有 ${result.candidates.length} 處並列，請比對前後文。`;
    } else {
      const { start, end } = result.candidates[0];
      const highlight = document.createElement("mark");
      highlight.textContent = current.text.slice(start, end);
      output.replaceChildren(current.text.slice(0, start), highlight, current.text.slice(end));
      status.textContent = `${location}在第 ${current.rev} 版找到 ${result.occurrences} 處相同引文，已標示最符合的位置。`;
    }
  }

  locate.addEventListener("click", () => {
    const revision = selected();
    if (!revision || !head()) return;
    try {
      const selector = capture(revision.text, source.selectionStart, source.selectionEnd);
      quote = { revision: revision.rev, selector };
      save();
      render();
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      status.textContent = "請先在選取版本中圈選完整文字。";
    }
  });
  clear.addEventListener("click", () => {
    quote = null;
    save();
    render();
    source.focus();
  });
  return render;
}
