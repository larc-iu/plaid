import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every confirm's title in igt is a question ("Delete segment?", "Revoke this
// token?"), by ruling (2026-09-27). The titles are strings at the call sites,
// so the rule is read off the source:
// - each `confirm({ title })`, including the island's `confirmRef.current`,
// - each `<ConfirmDeleteDialog title>`,
// - each `<AlertDialogTitle>` (igt opens an AlertDialog only to confirm),
// - the `<DialogTitle>` of the confirms built on a plain Dialog, named below.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Confirms that are a plain Dialog, because they hold more than a line: a
// preview of the restore, a name to type.
const DIALOG_CONFIRMS = [
  'components/vocabularies/EntryRestoreDialog.jsx',
  'components/vocabularies/VocabularyDetail.jsx',
];

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(full);
    return e.isFile() && /\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) ? [full] : [];
  });

// The string literals in an expression: a ternary's two branches, a template.
const LITERAL = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
// A literal compared against (`kind === 'merge' ? …`) is not one of them.
const COMPARED = /[!=]==?\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const literals = (expr) =>
  [...expr.replace(COMPARED, '').matchAll(LITERAL)].map((m) => m[1] ?? m[2] ?? m[3]);

// From an opening brace at `at`, the text up to its matching close.
const braced = (text, at) => {
  let depth = 0;
  for (let k = at; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}' && --depth === 0) return text.slice(at + 1, k);
  }
  return text.slice(at + 1);
};

// JSX children as the strings a reader sees the end of: the text itself, with
// each `{...}` standing in as one opaque word.
const jsxText = (children) => [
  children
    .replace(/\{[^{}]*\}/g, 'X')
    .replace(/\s+/g, ' ')
    .trim(),
];

// Each confirm title in a file, as {line, strings}. `dialogTitles` also reads
// the file's plain `<DialogTitle>`s.
function confirmTitles(text, { dialogTitles = false } = {}) {
  const out = [];
  const lineAt = (i) => text.slice(0, i).split('\n').length;
  for (const m of text.matchAll(/\b(?:confirm|confirmRef\.current)\(\s*\{/g)) {
    const body = braced(text, m.index + m[0].length - 1);
    const t = body.match(/(?:^|[\s,{])title:\s*([\s\S]*?)(?:,\s*\w+\s*:|,?\s*$)/);
    if (t) out.push({ line: lineAt(m.index), strings: literals(t[1]) });
  }
  for (const m of text.matchAll(/<ConfirmDeleteDialog\b/g)) {
    const end = text.indexOf('</ConfirmDeleteDialog>', m.index);
    const rest = text.slice(m.index, end < 0 ? undefined : end);
    const t = rest.match(/\stitle=(?:("[^"]*")|\{)/);
    if (!t) continue;
    const expr = t[1] ?? braced(rest, t.index + t[0].length - 1);
    out.push({ line: lineAt(m.index), strings: literals(expr) });
  }
  const tags = dialogTitles ? ['AlertDialogTitle', 'DialogTitle'] : ['AlertDialogTitle'];
  for (const tag of tags) {
    for (const m of text.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))) {
      out.push({ line: lineAt(m.index), strings: jsxText(m[1]) });
    }
  }
  return out;
}

describe('igt confirm titles', () => {
  it('reads a title off each kind of call site', () => {
    const src = [
      "await confirm({ title: 'Delete token', description: 'x' });",
      'confirmRef.current({',
      "  title: mine ? 'Delete yours?' : `Delete ${name}'s?`,",
      "  confirmLabel: 'Delete',",
      '});',
      '<ConfirmDeleteDialog open title="Delete project" onConfirm={go}>',
      '<ConfirmDeleteDialog title={`Delete “${x}”?`}>',
      "<ConfirmDeleteDialog title={kind === 'merge' ? 'Merge words?' : 'Split word'}>",
      "<AlertDialogTitle>Apply {plural(n, 'change')}?</AlertDialogTitle>",
      '<DialogTitle dir="auto">Restore “{label}”</DialogTitle>',
    ].join('\n');
    expect(confirmTitles(src, { dialogTitles: true }).map((t) => t.strings)).toEqual([
      ['Delete token'],
      ['Delete yours?', "Delete ${name}'s?"],
      ['Delete project'],
      ['Delete “${x}”?'],
      ['Merge words?', 'Split word'],
      ['Apply X?'],
      ['Restore “X”'],
    ]);
  });

  it('is a question at every call site', () => {
    const found = [];
    const wrong = [];
    for (const file of sources(SRC)) {
      const rel = path.relative(SRC, file);
      const text = fs.readFileSync(file, 'utf8');
      const titles = confirmTitles(text, { dialogTitles: DIALOG_CONFIRMS.includes(rel) });
      for (const { line, strings } of titles) {
        const where = `${rel}:${line}`;
        found.push(where);
        const bare = strings.map((s) => s.trim());
        if (!bare.length || bare.some((s) => !s.endsWith('?'))) wrong.push(`${where} ${bare}`);
      }
    }
    // Not vacuous: the scan finds the call sites it is about.
    expect(found.length).toBeGreaterThan(30);
    expect(wrong).toEqual([]);
  });
});
