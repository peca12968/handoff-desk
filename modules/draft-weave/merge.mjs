// Keep each terminator with its line so every alternative can be reconstructed verbatim.
function lines(text) {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function changes(base, edited) {
  let start = 0, aEnd = base.length, bEnd = edited.length;
  while (start < aEnd && start < bEnd && base[start] === edited[start]) start++;
  while (aEnd > start && bEnd > start && base[aEnd - 1] === edited[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  if (aEnd === start && bEnd === start) return [];
  if (aEnd === start || bEnd === start) return [{ start, end: aEnd, replacement: edited.slice(start, bEnd) }];
  const width = bEnd - start + 1;
  const cells = (aEnd - start + 1) * width;
  if (cells > 4_000_000) throw new RangeError("Unmatched line ranges exceed the 4,000,000-cell comparison limit");
  const lengths = new Uint16Array(cells);
  for (let a = aEnd - 1; a >= start; a--) {
    const row = (a - start) * width;
    for (let b = bEnd - 1; b >= start; b--) {
      const pos = row + b - start;
      lengths[pos] = base[a] === edited[b] ? 1 + lengths[pos + width + 1]
        : Math.max(lengths[pos + 1], lengths[pos + width]);
    }
  }
  const edits = [];
  let a = start, b = start;
  while (a < aEnd || b < bEnd) {
    if (a < aEnd && b < bEnd && base[a] === edited[b]) {
      a++;
      b++;
      continue;
    }
    const from = a, replacementStart = b;
    while ((a < aEnd || b < bEnd) && !(a < aEnd && b < bEnd && base[a] === edited[b])) {
      const pos = (a - start) * width + b - start;
      if (a < aEnd && (b === bEnd || lengths[pos + width] >= lengths[pos + 1])) a++;
      else b++;
    }
    edits.push({ start: from, end: a, replacement: edited.slice(replacementStart, b) });
  }
  return edits;
}

function project(base, start, end, edits) {
  let cursor = start;
  const parts = [];
  for (const edit of edits) {
    parts.push(base.slice(cursor, edit.start).join(""), edit.replacement.join(""));
    cursor = edit.end;
  }
  parts.push(base.slice(cursor, end).join(""));
  return parts.join("");
}

export function merge(baseText, localText, incomingText) {
  if (![baseText, localText, incomingText].every(text => typeof text === "string")) {
    throw new TypeError("Expected three plain text inputs");
  }
  if (localText === incomingText || baseText === localText || baseText === incomingText) {
    const text = baseText === localText ? incomingText : localText;
    return { version: 1, conflicts: 0, chunks: text ? [{ type: "text", text }] : [] };
  }
  const base = lines(baseText);
  const edits = [];
  for (const [side, revision] of [["local", localText], ["incoming", incomingText]]) {
    for (const edit of changes(base, lines(revision))) edits.push({ ...edit, side });
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const chunks = [];
  function emit(text) {
    if (!text) return;
    if (chunks.at(-1)?.type === "text") chunks.at(-1).text += text;
    else chunks.push({ type: "text", text });
  }
  let cursor = 0;
  let conflicts = 0;
  for (let i = 0; i < edits.length;) {
    const first = edits[i++];
    const start = first.start;
    let end = first.end;
    const group = [first];
    while (i < edits.length) {
      const next = edits[i];
      const sameInsertion = start === end && next.start === start && next.end === start;
      if (next.start >= end && !sameInsertion) break;
      group.push(next);
      end = Math.max(end, next.end);
      i++;
    }
    emit(base.slice(cursor, start).join(""));
    const local = group.filter(edit => edit.side === "local");
    const incoming = group.filter(edit => edit.side === "incoming");
    if (!local.length || !incoming.length) {
      emit(project(base, start, end, group));
    } else {
      const left = project(base, start, end, local);
      const right = project(base, start, end, incoming);
      if (left === right) emit(left);
      else {
        conflicts++;
        chunks.push({ type: "conflict", start, end, base: base.slice(start, end).join(""),
          local: left, incoming: right, resolution: null });
      }
    }
    cursor = end;
  }
  emit(base.slice(cursor).join(""));
  return { version: 1, conflicts, chunks };
}

export function render(plan) {
  if (plan?.version !== 1 || !Array.isArray(plan.chunks)) throw new Error("Expected a version 1 merge plan");
  if (plan.conflicts !== plan.chunks.filter(chunk => chunk?.type === "conflict").length) {
    throw new Error("Conflict count does not match the review chunks");
  }
  return plan.chunks.map((chunk, i) => {
    if (chunk?.type === "text" && typeof chunk.text === "string") return chunk.text;
    if (chunk?.type !== "conflict" || !["base", "local", "incoming"].every(k => typeof chunk[k] === "string")) {
      throw new Error("Invalid chunk " + (i + 1));
    }
    if (["base", "local", "incoming"].includes(chunk.resolution)) return chunk[chunk.resolution];
    if (typeof chunk.resolution?.text === "string") return chunk.resolution.text;
    throw new Error("Choose a resolution for conflict at base range [" + chunk.start + ", " + chunk.end + ")");
  }).join("");
}
