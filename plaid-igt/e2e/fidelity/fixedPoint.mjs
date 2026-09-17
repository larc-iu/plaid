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
// import's bookkeeping stamps go, and whoever a native archive's re-posted
// comment names as its author becomes `<author>` (see the note where that is
// done). What is left
// different is a finding.

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
  // comment as someone else, so the importer owns it and a note in the body
  // says who wrote it first. Each import rewrites that note to name the
  // archive's author (src/import/native/commentAttribution.js), so after the
  // second pass it names the first importer: whose name it carries is settled
  // material, not drift. Both the author and the name in the note become
  // `<author>`, which still shows a note that stopped being written, or a body
  // that changed under it.
  if (typeof out.body === 'string' && out.author && typeof out.author === 'object') {
    const m = out.body.match(NOTE);
    if (m) {
      out.author = '<author>';
      out.body = `${m[0].replace(m[1], '<author>')}${out.body.slice(m[0].length)}`;
    }
  }
  return out;
}

/** The export as `Map<path, string>`, each file in canonical form. */
export function canonicalExport(bytes, filename = 'export') {
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
      out.set(path, JSON.stringify(canonicalJson(JSON.parse(text)), null, 2));
    } else {
      out.set(path, text.replace(UUID, '<id>').replace(/ DATE="[^"]*"/, ' DATE=""'));
    }
  }
  return out;
}

// The lines of `a` and `b` that are not in their longest common subsequence,
// in order. Exports here are small enough for the quadratic table.
function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
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
      out.push({ side: '+', line: j + 1, text: y[j++] });
    } else {
      out.push({ side: '-', line: i + 1, text: x[i++] });
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
