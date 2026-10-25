// The fixed point: once a project has been through the round trip, going
// through it again should change nothing.
//
// A round trip's snapshot comparison checks what the import wrote against the
// loss list. This checks the other direction with no list at all: whatever an
// export wrote, the project its import made has to be able to write again. It
// catches what a snapshot cannot see, such as which of two glosses on a word
// the grid shows first, or a word that fell out of an aligned cell.
//
// The comparison is between the SECOND export and the third, not the first and
// the second: a format is allowed to lose something on the way in, and what it
// loses is gone from the first pass on. Anything that changes after that is a
// finding whatever the list says, because the content stopped settling.
//
// Two exports of the same content still differ in what identifies or dates
// them, so both are put in a canonical form first: every UUID becomes `<id>`,
// the export's own timestamps and the documents' version counters go, an
// import's bookkeeping stamps go, and whoever re-posted a native archive's
// comment becomes `<author>` (see the note where that is done). A JSON file is
// compared with its object keys in sorted order, since a key's place in an
// object is no content. What is left different is a finding.

import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TEXT = /\.(json|csv|eaf|xml|txt|flextext|lift|tsv)$/i;
// `order` is where a row sat among the project's rows, which an import
// renumbers from zero as it recreates them: what it says is the RELATIVE order,
// and that shows in which annotation is written as the tree's and which as an
// extra.
const VOLATILE_KEYS = new Set([
  'exportedAt',
  'createdAt',
  'updatedAt',
  'dc:created',
  'version',
  'order',
]);
const STAMP_KEYS = new Set(['importDone', 'importSource', 'nativeImportId', 'cldfEntry']);
const NOTE =
  /^> Imported from an archive\. Originally posted by (.+?)(?: on (\d{4}-\d{2}-\d{2}))?\.(?:\n\n|$)/;

const isZip = (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b;

function canonicalJson(value) {
  if (typeof value === 'string') return value.replace(UUID, '<id>');
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (VOLATILE_KEYS.has(k)) continue;
    if (k === 'metadata' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = canonicalJson(
        Object.fromEntries(Object.entries(v).filter(([m]) => !STAMP_KEYS.has(m))),
      );
      continue;
    }
    out[k] = canonicalJson(v);
  }
  // A native archive comment an import re-posted. Core lets nobody author a
  // comment as someone else, so the importer owns it and a note at the top of
  // the body says who wrote it first and when. An import keeps a note an
  // earlier one wrote as it is (src/import/native/commentAttribution.js,
  // Luke's ruling R36), so the note itself has to come out of every pass
  // unchanged and is compared whole. Only who posted it, whoever ran the
  // import, becomes `<author>`.
  if (
    typeof out.body === 'string' &&
    out.author &&
    typeof out.author === 'object' &&
    NOTE.test(out.body)
  ) {
    out.author = '<author>';
  }
  return out;
}

/** `value` with every object's keys in sorted order, at any depth. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])]),
  );
}

// A dictionary address the core already held when an import ran is dropped
// by that import (importEngine.js slugTakenElsewhere), which is right, and
// which core holds which address is no content of the export. So when the
// second import ran on a core holding an address the second export names (the
// first import's, when the source is on another core), the address comes out
// of the second export before the two are compared. On the source's core the
// first import already dropped it and nothing is masked.
function withoutHeldSlug(value, heldSlugs) {
  const slug = value?.config?.dict?.slug;
  if (typeof slug !== 'string' || !heldSlugs.has(slug.trim())) return value;
  const { slug: _slug, ...dict } = value.config.dict;
  const { dict: _dict, ...config } = value.config;
  return { ...value, config: Object.keys(dict).length ? { ...config, dict } : config };
}

/**
 * The export as `Map<path, string>`, each file in canonical form.
 * `heldSlugs`: the dictionary addresses the core held when the NEXT import of
 * this export ran (see withoutHeldSlug).
 */
export function canonicalExport(bytes, filename = 'export', { heldSlugs = new Set() } = {}) {
  const files = isZip(bytes) ? unzipSync(bytes) : { [filename]: bytes };
  const out = new Map();
  const decoder = new TextDecoder();
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/')) continue;
    if (!TEXT.test(path)) {
      out.set(path, `sha256 ${createHash('sha256').update(data).digest('hex')}`);
      continue;
    }
    const text = decoder.decode(data);
    if (/\.json$/i.test(path)) {
      const json = withoutHeldSlug(JSON.parse(text), heldSlugs);
      out.set(path, JSON.stringify(sortKeys(canonicalJson(json)), null, 2));
    } else {
      out.set(path, text.replace(UUID, '<id>').replace(/ DATE="[^"]*"/, ' DATE=""'));
    }
  }
  return out;
}

// The most cells the longest-common-subsequence table may hold (about 64 MB).
const LCS_CELLS = 16e6;

// The lines of `a` and `b` that are not in their longest common subsequence,
// in order. The lines both start and end with are trimmed first, so a file
// that differs in one place costs the table only that place. When what is
// left is still too large for the table, every line of it is printed as
// differing, the first's then the second's: a difference that wide is read
// from the files, not from this list.
export function lineDiff(a, b) {
  const xs = a.split('\n');
  const ys = b.split('\n');
  let head = 0;
  while (head < xs.length && head < ys.length && xs[head] === ys[head]) head++;
  let tail = 0;
  while (
    tail < xs.length - head &&
    tail < ys.length - head &&
    xs[xs.length - 1 - tail] === ys[ys.length - 1 - tail]
  ) {
    tail++;
  }
  const x = xs.slice(head, xs.length - tail);
  const y = ys.slice(head, ys.length - tail);
  const n = x.length;
  const m = y.length;
  if ((n + 1) * (m + 1) > LCS_CELLS) {
    return [
      ...x.map((text, i) => ({ side: '-', line: head + i + 1, text })),
      ...y.map((text, j) => ({ side: '+', line: head + j + 1, text })),
    ];
  }
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push({ side: '+', line: head + j + 1, text: y[j++] });
    } else {
      out.push({ side: '-', line: head + i + 1, text: x[i++] });
    }
  }
  return out;
}

const cut = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}...` : s);

/**
 * Every difference between two canonical exports, as printable lines, at most
 * `limit` per file.
 */
export function diffExports(first, second, { limit = 40 } = {}) {
  const out = [];
  for (const path of [...new Set([...first.keys(), ...second.keys()])].sort()) {
    if (!second.has(path)) out.push(`${path}: only in the first export`);
    else if (!first.has(path)) out.push(`${path}: only in the second export`);
    else if (first.get(path) !== second.get(path)) {
      const lines = lineDiff(first.get(path), second.get(path));
      out.push(`${path}: ${lines.length} line(s) differ`);
      for (const l of lines.slice(0, limit)) out.push(`    ${l.side}${l.line} ${cut(l.text)}`);
      if (lines.length > limit) out.push('    ...');
    }
  }
  return out;
}
