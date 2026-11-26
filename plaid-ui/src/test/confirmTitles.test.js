import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './apps.js';

// Every confirm's title is a question ("Delete token?", "Delete project?"),
// by ruling (2026-09-27). The titles are strings at the call sites, so the
// rule is read off the source: each `confirm({ title })` and each
// `<ConfirmDeleteDialog title>` in the trees below. plaid-igt's own test
// (src/test/confirmTitles.test.js there) also reads its hand-built dialogs.
const TREES = ['plaid-ui/src', 'plaid-ud/src', 'plaid-umr/src', 'plaid-igt/src', 'plaid-dict/src'];

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
  [...messagesOnly(expr).replace(COMPARED, '').matchAll(LITERAL)].map((m) => m[1] ?? m[2] ?? m[3]);

// A translated title is its message, the first argument of t() or tx() (the
// second of tc(), after the sense). The values passed with it are not part
// of the title. A call whose message is not a literal stays as it is, and
// so has no title literal of its own.
const MESSAGE_CALL = /\b(?:tx?\(|tc\(\s*'[^']*'\s*,)\s*/g;
const STRING_START = /^('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/;
// From an opening parenthesis at `at`, the index of its match, past strings.
const closingParen = (text, at) => {
  let depth = 0;
  for (let k = at; k < text.length; k++) {
    const quoted = /['"`]/.test(text[k]) && text.slice(k).match(STRING_START);
    if (quoted) k += quoted[0].length - 1;
    else if (text[k] === '(') depth++;
    else if (text[k] === ')' && --depth === 0) return k;
  }
  return text.length - 1;
};
const messagesOnly = (expr) => {
  let out = '';
  let at = 0;
  for (const m of expr.matchAll(MESSAGE_CALL)) {
    if (m.index < at) continue;
    const message = expr.slice(m.index + m[0].length).match(STRING_START);
    if (!message) continue;
    out += expr.slice(at, m.index) + message[1];
    at = closingParen(expr, expr.indexOf('(', m.index)) + 1;
  }
  return out + expr.slice(at);
};

// From an opening brace at `at`, the text up to its matching close.
const braced = (text, at) => {
  let depth = 0;
  for (let k = at; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}' && --depth === 0) return text.slice(at + 1, k);
  }
  return text.slice(at + 1);
};

// Each confirm title in a file, as {line, expr}.
const confirmTitles = (text) => {
  const out = [];
  const lineAt = (i) => text.slice(0, i).split('\n').length;
  for (const m of text.matchAll(/\bconfirm\(\s*\{/g)) {
    const body = braced(text, m.index + m[0].length - 1);
    const t = body.match(/(?:^|[\s,{])title:\s*([\s\S]*?)(?:,\s*\w+\s*:|,?\s*$)/);
    if (t) out.push({ line: lineAt(m.index), expr: t[1] });
  }
  for (const m of text.matchAll(/<ConfirmDeleteDialog\b/g)) {
    // Its own props: the title comes before the body in every call site.
    const end = text.indexOf('</ConfirmDeleteDialog>', m.index);
    const rest = text.slice(m.index, end < 0 ? undefined : end);
    const t = rest.match(/\stitle=(?:("[^"]*")|\{)/);
    if (!t) continue;
    const expr = t[1] ?? braced(rest, t.index + t[0].length - 1);
    out.push({ line: lineAt(m.index), expr });
  }
  return out;
};

describe('confirm titles', () => {
  it('reads a title off each kind of call site', () => {
    const src = [
      "await confirm({ title: 'Delete token', description: 'x' });",
      'await confirm({',
      "  title: mine ? 'Delete yours?' : `Delete ${name}'s?`,",
      "  confirmLabel: 'Delete',",
      '});',
      "await confirm({ title: t('Delete “{name}”?', { name: n || t('Untitled') }) });",
      "await confirm({ title: tc('job', 'Discard (it)', { a: ')' }), body: 'x' });",
      "await confirm({ title: tx('Delete <b>{name}</b>?', { b: (c) => c }) });",
      'await confirm({ title: t(MESSAGE) });',
      '<ConfirmDeleteDialog open title="Delete project" onConfirm={go}>',
      '<ConfirmDeleteDialog title={`Delete “${x}”?`}>',
      "<ConfirmDeleteDialog title={kind === 'merge' ? 'Merge words?' : 'Split word'}>",
    ].join('\n');
    expect(confirmTitles(src).map((t) => literals(t.expr))).toEqual([
      ['Delete token'],
      ['Delete yours?', "Delete ${name}'s?"],
      ['Delete “{name}”?'],
      ['Discard (it)'],
      ['Delete <b>{name}</b>?'],
      [],
      ['Delete project'],
      ['Delete “${x}”?'],
      ['Merge words?', 'Split word'],
    ]);
  });

  it('is a question at every call site', () => {
    const root = repoRoot();
    const found = [];
    const wrong = [];
    for (const tree of TREES) {
      const dir = path.join(root, tree);
      if (!fs.existsSync(dir)) continue;
      for (const file of sources(dir)) {
        for (const { line, expr } of confirmTitles(fs.readFileSync(file, 'utf8'))) {
          const where = `${path.relative(root, file)}:${line}`;
          const strings = literals(expr);
          found.push(where);
          if (!strings.length || strings.some((s) => !s.trim().endsWith('?'))) {
            wrong.push(`${where} ${expr.trim()}`);
          }
        }
      }
    }
    // Not vacuous: the scan finds the call sites it is about.
    expect(found.length).toBeGreaterThan(8);
    expect(wrong).toEqual([]);
  });
});
