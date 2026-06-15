// Turn a `client.query` entities result into per-sentence rows for rendering.
//
// Each result row is an array of entity objects (one per find variable). We pick
// the sentence cell by its layer id and the matched-node cells by theirs, rather
// than by column name (variable names survive the wire untouched, but matching
// on layer is robust regardless). Multiple rows can match the same sentence
// (e.g. several matches, or query fan-out), so we group by sentence id and merge
// the highlighted ranges.
//
// Offsets are Unicode code points (Plaid's canonical unit), so we slice on a
// code-point array, not on UTF-16 indices.

const cp = (s) => Array.from(s || '');

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

// Group entity rows into [{ docId, sentenceId, text, highlights:[{start,end}] }].
export function groupResults(results, sentenceLayerId, nodeLayerId) {
  const byId = new Map();
  for (const row of results || []) {
    const s = row.find(e => e && e.layer === sentenceLayerId);
    if (!s) continue;
    let g = byId.get(s.id);
    if (!g) {
      g = { docId: s.document, sentenceId: s.id, text: s.value ?? '', begin: s.begin ?? 0, ranges: new Map() };
      byId.set(s.id, g);
    }
    const len = cp(g.text).length;
    for (const e of row) {
      if (!e || e === s || e.layer !== nodeLayerId || typeof e.begin !== 'number') continue;
      const start = Math.max(0, Math.min(len, e.begin - g.begin));
      const end = Math.max(start, Math.min(len, e.end - g.begin));
      if (end > start) g.ranges.set(`${start}:${end}`, { start, end });
    }
  }
  return [...byId.values()]
    .map(g => ({ docId: g.docId, sentenceId: g.sentenceId, text: g.text, highlights: mergeRanges([...g.ranges.values()]) }))
    .sort((a, b) => String(a.docId).localeCompare(String(b.docId)) || a.sentenceId.localeCompare(b.sentenceId));
}

// Split `text` into alternating plain/highlighted segments for rendering.
export function segmentize(text, highlights) {
  const chars = cp(text);
  if (!highlights.length) return [{ text, hl: false }];
  const segs = [];
  let i = 0;
  for (const h of highlights) {
    if (h.start > i) segs.push({ text: chars.slice(i, h.start).join(''), hl: false });
    segs.push({ text: chars.slice(h.start, h.end).join(''), hl: true });
    i = h.end;
  }
  if (i < chars.length) segs.push({ text: chars.slice(i).join(''), hl: false });
  return segs;
}
