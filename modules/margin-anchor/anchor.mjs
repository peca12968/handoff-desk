const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const contextSize = 32;

function split(text) {
  if (typeof text !== "string") throw new TypeError("Expected plain text");
  const offsets = [];
  const tokens = [];
  for (const { segment, index } of segmenter.segment(text)) {
    offsets.push(index);
    tokens.push(segment === "\r\n" ? "\n" : segment.normalize("NFC"));
  }
  offsets.push(text.length);
  return { offsets, tokens };
}

export function capture(text, start, end) {
  const { offsets } = split(text);
  const first = offsets.indexOf(start);
  const last = offsets.indexOf(end);
  if (first < 0 || last <= first) {
    throw new RangeError("Select a nonempty range on grapheme boundaries (UTF-16 offsets)");
  }
  return {
    type: "TextQuoteSelector",
    exact: text.slice(start, end),
    prefix: text.slice(offsets[Math.max(0, first - contextSize)], start),
    suffix: text.slice(end, offsets[Math.min(offsets.length - 1, last + contextSize)]),
  };
}

// The prefix table lets a match resume inside the previous occurrence (e.g. aaa in aaaa).
function* occurrences(text, quote) {
  const fallback = new Array(quote.length).fill(0);
  for (let i = 1, length = 0; i < quote.length; i++) {
    while (length && quote[i] !== quote[length]) length = fallback[length - 1];
    if (quote[i] === quote[length]) length++;
    fallback[i] = length;
  }
  let matched = 0;
  for (let i = 0; i < text.length; i++) {
    while (matched && text[i] !== quote[matched]) matched = fallback[matched - 1];
    if (text[i] === quote[matched]) matched++;
    if (matched === quote.length) {
      yield i + 1 - matched;
      matched = fallback[matched - 1];
    }
  }
}

export function resolve(text, selector) {
  if (selector?.type !== "TextQuoteSelector" || typeof selector.exact !== "string" || !selector.exact) {
    throw new TypeError("Expected a TextQuoteSelector with a nonempty exact quote");
  }
  const { tokens, offsets } = split(text);
  const quote = split(selector.exact).tokens;
  const prefix = split(selector.prefix === undefined ? "" : selector.prefix).tokens.slice(-contextSize);
  const suffix = split(selector.suffix === undefined ? "" : selector.suffix).tokens.slice(0, contextSize);
  let best = -1;
  let candidates = [];
  let occurrencesFound = 0;
  for (const start of occurrences(tokens, quote)) {
    const end = start + quote.length;
    let before = 0;
    let after = 0;
    while (before < prefix.length && tokens[start - 1 - before] === prefix[prefix.length - 1 - before]) before++;
    while (after < suffix.length && tokens[end + after] === suffix[after]) after++;
    const score = before + after;
    occurrencesFound++;
    if (score < best) continue;
    if (score > best) candidates = [];
    best = score;
    candidates.push({ start: offsets[start], end: offsets[end], before, after });
  }
  let status = "missing";
  if (candidates.length) status = candidates.length === 1 ? "attached" : "ambiguous";
  return { status, occurrences: occurrencesFound, candidates };
}
