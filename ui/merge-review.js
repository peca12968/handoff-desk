import { merge, render } from "draft-weave";

const $ = id => document.getElementById(id);
const sides = [["base", "原稿"], ["local", "本頁草稿"], ["incoming", "伺服器最新"]];
const signature = ({start, end, base, local, incoming}) => JSON.stringify([start, end, base, local, incoming]);

export function readReviewChoices(value) {
  return Array.isArray(value) ? value.filter(row => Array.isArray(row) && row.length === 2 &&
    typeof row[0] === "string" && sides.some(([side]) => side === row[1])) : [];
}

export function closeReview() {
  $("review").hidden = true;
  $("manual-review").hidden = false;
  $("choices").replaceChildren();
  $("result-text").textContent = "";
  $("apply").onclick = null;
}

export function openReview(base, draft, latest, saved, remember, apply) {
  const plan = merge(base, draft, latest);
  const conflicts = plan.chunks.filter(chunk => chunk.type === "conflict");
  const previous = new Map(saved);
  for (const chunk of conflicts) chunk.resolution = previous.get(signature(chunk)) ?? null;
  function update() {
    const pending = conflicts.filter(chunk => !chunk.resolution).length;
    remember(conflicts.filter(chunk => chunk.resolution).map(chunk => [signature(chunk), chunk.resolution]));
    $("review-count").textContent = pending ? "還有 " + pending + " 處需選擇保留的文字。" : "可將下列全文套用到草稿，再編輯或儲存。";
    $("result").hidden = Boolean(pending);
    $("apply").disabled = Boolean(pending);
    $("result-text").textContent = pending ? "" : render(plan);
  }
  const groups = conflicts.map((chunk, index) => {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = chunk.start === chunk.end ? "原稿第 " + chunk.start + " 行之後的新增內容"
      : "原稿第 " + (chunk.start + 1) + (chunk.end > chunk.start + 1 ? " 至 " + chunk.end : "") + " 行";
    if (chunk.start === 0 && chunk.end === 0) legend.textContent = "原稿開頭的新增內容";
    group.append(legend);
    for (const [key, title] of sides) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "choice-" + index;
      radio.checked = chunk.resolution === key;
      radio.addEventListener("change", () => {
        chunk.resolution = key;
        update();
      });
      const value = document.createElement("span");
      value.textContent = chunk[key] || "（空白，移除此段）";
      label.append(radio, document.createTextNode(title), value);
      group.append(label);
    }
    return group;
  });
  $("choices").replaceChildren(...groups);
  $("apply").onclick = () => apply(render(plan));
  $("manual-review").hidden = true;
  $("review").hidden = false;
  update();
  $("review-heading").focus();
}
