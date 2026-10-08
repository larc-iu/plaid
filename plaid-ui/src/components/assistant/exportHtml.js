// A conversation as one web page: a single .html file that looks like the
// assistant panel and reads anywhere, offline, with no script. The turns are
// drawn by the chat's own `Turn`, read-only, inside ExportPage.jsx, and the
// app's CSS the page uses is carried inline (exportCss.js).
//
// What the page holds and what it leaves out:
// - Every turn: the messages, the tool steps (folded, each step's output under
//   it), the plans with the place each change targeted and how the plan
//   ended, the cited examples, the file chips, and where a question was asked.
// - A table the assistant made (.csv, .tsv) is shown in full when it is small
//   enough. Every other file is named with its size.
// - Nothing from a project the exporter cannot open today: a citation into one
//   is left out, its name is written "Another project", and the tool outputs
//   of a turn that read one and the content of a table it made are left out.
// - A long tool output is cut short, and past a total the rest are left out,
//   so a long conversation stays a file of a few MB at most.
// The header says what was left out.

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ExportPage } from './ExportPage.jsx';
import { readStoredFile } from './attachments.js';
import { toolResults } from './transcript.js';
import { usedCss } from './exportCss.js';

const TOOL_OUTPUT_CHARS = 4000;
const TOOL_OUTPUT_TOTAL = 1_000_000;
const TABLE_BYTES = 200_000;
const TABLE_ROWS = 500;

const OTHER = 'Another project';
const NOT_INCLUDED = '(not included)';

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

// The conversation as the page draws it, with what the exporter cannot open
// taken out, and a count of what was.
export const prepareExport = (conv, { projectId, readable }) => {
  const opens = (id) => !id || id === projectId || !readable || readable.has(id);
  const rename = (projects) => projects.map((p) => (opens(p.id) ? p : { ...p, name: OTHER }));
  const outputs = toolResults(conv?.messages);
  const results = new Map();
  // The files a turn that read a closed project made: what they hold may
  // come from it, so only their names are shown.
  const closedFiles = new Set();
  const left = { citations: 0, results: 0, shortened: 0 };
  let budget = TOOL_OUTPUT_TOTAL;
  let reach = [];
  const display = (conv?.display || []).map((d) => {
    if (d.kind === 'user') {
      reach = d.projects || [];
      return d.projects ? { ...d, projects: rename(d.projects) } : d;
    }
    if (d.kind !== 'assistant') return d;
    const out = { ...d };
    if (d.unavailableProjects) out.unavailableProjects = rename(d.unavailableProjects);
    if (d.citations?.length) {
      out.citations = d.citations.filter((c) => opens(c.projectId));
      left.citations += d.citations.length - out.citations.length;
    }
    const closed = reach.some((p) => !opens(p.id));
    if (closed) for (const f of d.files || []) if (f.made) closedFiles.add(f.id);
    for (const s of d.steps || []) {
      if (!s.id || !outputs.has(s.id)) continue;
      let text = outputs.get(s.id);
      if (closed) {
        results.set(s.id, NOT_INCLUDED);
        left.results += 1;
        continue;
      }
      const long = text.length > TOOL_OUTPUT_CHARS;
      if (long) text = `${text.slice(0, TOOL_OUTPUT_CHARS)}\n…`;
      if (text.length > budget) {
        results.set(s.id, NOT_INCLUDED);
        left.results += 1;
        continue;
      }
      if (long) left.shortened += 1;
      budget -= text.length;
      results.set(s.id, text);
    }
    return out;
  });
  return { display, results, left, closedFiles };
};

// A CSV or TSV as the host's csv module writes it: quoted fields may hold the
// delimiter, a doubled quote and line breaks. The first row is the header.
export const parseTable = (text, name) => {
  const sep = /\.tsv$/i.test(name) ? '\t' : ',';
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header = [], ...body] = rows;
  return { header, rows: body };
};

const TABLE_FILE = /\.(csv|tsv)$/i;

// The made tables small enough to show, by file id, and the names of those
// that are not.
const readTables = async (display, store, convId, closedFiles) => {
  const tables = new Map();
  const notShown = [];
  for (const d of display) {
    if (d.kind !== 'assistant') continue;
    for (const f of d.files || []) {
      if (!f.made || !TABLE_FILE.test(f.name || '')) continue;
      if (!store || closedFiles.has(f.id) || (f.bytes || 0) > TABLE_BYTES) {
        notShown.push(f.name);
        continue;
      }
      try {
        const table = parseTable(await readStoredFile(store, convId, f), f.name);
        if (table.rows.length > TABLE_ROWS) notShown.push(f.name);
        else tables.set(f.id, table);
      } catch {
        notShown.push(f.name);
      }
    }
  }
  return { tables, notShown };
};

const day = (iso) => {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime())
    ? at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;
};

// When the conversation ran, as one day or a range.
const span = (display, meta) => {
  const times = display.map((d) => d.createdAt).filter(Boolean);
  const first = day(times[0] || meta?.createdAt);
  const last = day(times.at(-1) || meta?.updatedAt);
  if (!first) return last;
  return !last || last === first ? first : `${first} to ${last}`;
};

const models = (display, meta) => {
  const seen = [...new Set(display.map((d) => d.kind === 'assistant' && d.model).filter(Boolean))];
  return seen.length ? seen : meta?.model ? [meta.model] : [];
};

// The header's line about what the page does not hold.
export const leftOutLine = (left, notShown) => {
  const parts = [];
  if (left.citations)
    parts.push(`${plural(left.citations, 'cited example', 'cited examples')} from other projects`);
  if (left.results) parts.push(plural(left.results, 'tool output', 'tool outputs'));
  if (notShown.length) parts.push(`the content of ${notShown.join(', ')}`);
  const out = parts.length ? [`Not included: ${parts.join(', ')}.`] : [];
  if (left.shortened)
    out.push(
      left.shortened === 1
        ? '1 long tool output is shortened.'
        : `${left.shortened} long tool outputs are shortened.`,
    );
  return out.join(' ') || null;
};

// The page's own rules: its frame, the folds, a made table, and the dark
// palette, which the app does not have (its `.dark` tokens are only the
// warning and success pair).
const PAGE_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; }
.plaid-export { max-width: 56rem; margin: 0 auto; padding: 24px 16px 48px; }
.plaid-export-header { margin-bottom: 16px; }
.plaid-export-header h1 { margin: 0 0 4px; font-size: 1.5rem; line-height: 2rem; font-weight: 600; overflow-wrap: anywhere; }
summary { list-style: none; }
summary::-webkit-details-marker { display: none; }
details[open] > summary .plaid-export-chevron { transform: rotate(90deg); }
.plaid-export-table { border-collapse: collapse; }
.plaid-export-table th, .plaid-export-table td { padding: 2px 8px; border-bottom: 1px solid hsl(var(--border)); text-align: start; vertical-align: top; white-space: pre-wrap; }
.plaid-export-table th { position: sticky; top: 0; background: hsl(var(--muted)); font-weight: 600; }
@media (prefers-color-scheme: dark) {
  :root {
    --background: 222 28% 9%;
    --foreground: 40 20% 92%;
    --card: 222 24% 12%;
    --card-foreground: 40 20% 92%;
    --popover: 222 24% 12%;
    --popover-foreground: 40 20% 92%;
    --primary: 217 22% 42%;
    --primary-foreground: 40 23% 96%;
    --secondary: 220 14% 19%;
    --secondary-foreground: 40 20% 92%;
    --muted: 220 14% 19%;
    --muted-foreground: 30 8% 68%;
    --accent: 220 14% 21%;
    --accent-foreground: 40 20% 92%;
    --destructive: 0 72% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 220 12% 25%;
    --input: 220 12% 30%;
    --ring: 217 25% 60%;
  }
}
`;

// What a page with no script and no server keeps of the markup: a link into
// the app becomes its text (it would open nothing from a file), a link to the
// web stays, and every button goes, with a box left empty by it.
const settle = (doc) => {
  for (const a of [...doc.querySelectorAll('a')]) {
    if (/^https?:\/\//i.test(a.getAttribute('href') || '')) continue;
    const span = doc.createElement('span');
    for (const name of ['class', 'dir']) {
      if (a.hasAttribute(name)) span.setAttribute(name, a.getAttribute(name));
    }
    span.append(...a.childNodes);
    a.replaceWith(span);
  }
  for (const b of [...doc.querySelectorAll('button, input, select, textarea')]) {
    const parent = b.parentElement;
    b.remove();
    if (parent && !parent.children.length && !parent.textContent.trim()) parent.remove();
  }
};

// The page body, drawn once by React and taken as markup.
const markupOf = (element) => {
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(element));
  const html = host.innerHTML;
  root.unmount();
  return html;
};

/**
 * The conversation as a self-contained HTML document (a string).
 * `readable` is the set of project ids the exporter can open now, `store`
 * the record's store (for the files the replies made), `exporter` who is
 * exporting, `appLabel` the app's name, `sheets` the stylesheets to take the
 * page's CSS from (the document's own, in the app).
 */
export const conversationToHtml = async (
  conv,
  meta,
  {
    projectId,
    projectName,
    adapter,
    store,
    readable,
    exporter,
    appLabel,
    sheets,
    now = new Date(),
  },
) => {
  const { display, results, left, closedFiles } = prepareExport(conv, { projectId, readable });
  const { tables, notShown } = await readTables(display, store, conv?.id, closedFiles);
  const title = meta?.title || 'Conversation';
  const ran = models(display, meta);
  const facts = [
    appLabel,
    projectName && `Project: ${projectName}`,
    span(display, meta),
    ran.length && `Assistant: ${ran.join(', ')}`,
    `Exported${exporter ? ` by ${exporter}` : ''} on ${day(now.toISOString())}`,
  ].filter(Boolean);
  const body = markupOf(
    createElement(ExportPage, {
      title,
      facts,
      left: leftOutLine(left, notShown),
      display,
      results,
      tables,
      projectId,
      projectName,
      adapter,
      model: ran.at(-1) || null,
    }),
  );
  const doc = new DOMParser().parseFromString(
    '<!doctype html><html dir="ltr"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="color-scheme" content="light dark"><title></title></head>' +
      `<body>${body}</body></html>`,
    'text/html',
  );
  doc.title = title;
  settle(doc);
  const style = doc.createElement('style');
  style.textContent = `${usedCss(sheets, doc)}\n${PAGE_CSS}`;
  doc.head.append(style);
  return `<!doctype html>\n${doc.documentElement.outerHTML}\n`;
};
