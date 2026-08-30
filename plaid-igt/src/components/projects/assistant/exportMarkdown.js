// A conversation as a Markdown document: the questions, the replies with
// their citations expanded to interlinear tables (linked to the sentence in
// the editor), plans with their changes and outcome, and errors. Tool traces
// are summarized in one line per reply. Pure: no DOM, so it is unit-tested.

import {
  citationHighlights,
  citationRows,
  citationTitle,
  linkifyCitations,
  sentenceHref,
} from './citations.js';

const esc = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

// One cited sentence as a Markdown table: a column per word, a row per tier
// (words, morphemes, each field), then the sentence fields. Cited words are
// bold (a table cannot mark a morpheme inside one, the card and the editor do).
export const citationToMarkdown = (c, { origin, projectId }) => {
  const words = c.words || [];
  const cited = citationHighlights(c);
  const [surface, ...rows] = citationRows(c);
  const out = [`**[${esc(citationTitle(c))}](${sentenceHref(origin, projectId, c)})**`, ''];
  if (words.length) {
    out.push(
      `| | ${surface.cells
        .map((v, j) => (cited.has(words[j].index) ? `**${esc(v)}**` : esc(v)))
        .join(' | ')} |`,
    );
    out.push(`|---|${words.map(() => '---').join('|')}|`);
    rows.forEach((r) => out.push(`| ${[r.label, ...r.cells].map(esc).join(' | ')} |`));
  } else {
    out.push(esc(c.text));
  }
  (c.fields || []).forEach((f) => out.push('', `*${esc(f.field)}:* ${esc(f.value)}`));
  return out.join('\n');
};

// Reply text with its citations: a citation alone on a line becomes the
// table in place, an inline one a link, and the inline-only ones' tables
// follow the text (the same rules as the tab).
export const replyToMarkdown = (text, citations, ctx) => {
  const byKey = new Map((citations || []).map((c) => [c.key, c]));
  const inline = [];
  const shown = new Set();
  const lines = (text || '').split('\n').map((line) => {
    const key = line.trim();
    if (byKey.has(key)) {
      shown.add(key);
      return citationToMarkdown(byKey.get(key), ctx);
    }
    return linkifyCitations(line, byKey, {
      ...ctx,
      onCited: (m, c) => {
        if (!shown.has(m) && !inline.includes(c)) inline.push(c);
      },
    });
  });
  const out = lines.join('\n');
  if (!inline.length) return out;
  return `${out}\n\n**Cited examples**\n\n${inline.map((c) => citationToMarkdown(c, ctx)).join('\n\n')}`;
};

const planToMarkdown = (plan, status) => {
  const outcome =
    status === 'applied'
      ? 'Approved and applied.'
      : status === 'discarded'
        ? 'Discarded.'
        : status === 'applying'
          ? 'Approved, but interrupted before the result came back.'
          : 'Not yet approved.';
  const lines = [`**Proposed changes:** ${plan.summary || ''} (${outcome})`, ''];
  (plan.labels || []).forEach((l, i) => lines.push(`${i + 1}. ${l}`));
  return lines.join('\n');
};

// The tab's own one-line summary when the caller lends it, else a count.
const stepsLine = (steps, summarizeSteps) => {
  if (!steps?.length) return null;
  const text = summarizeSteps
    ? summarizeSteps(steps)
    : `${steps.length} tool call${steps.length === 1 ? '' : 's'}`;
  return `*${text}*`;
};

export const conversationToMarkdown = (
  conv,
  meta,
  { origin, projectId, projectName, summarizeSteps },
) => {
  const ctx = { origin, projectId };
  const out = [`# ${meta?.title || 'Conversation'}`, ''];
  const facts = [];
  if (projectName) facts.push(`Project: ${projectName}`);
  if (meta?.model) facts.push(`Assistant: ${meta.model}`);
  if (meta?.createdAt) facts.push(`Started: ${meta.createdAt.slice(0, 10)}`);
  if (facts.length) out.push(facts.join(' · '), '');
  (conv?.display || []).forEach((d) => {
    if (d.kind === 'user') {
      out.push('## You', '', d.text || '', '');
    } else if (d.kind === 'error') {
      out.push(`> **Error:** ${d.text || ''}`, '');
    } else {
      out.push('## Assistant', '');
      const trace = stepsLine(d.steps, summarizeSteps);
      if (trace) out.push(trace, '');
      if (d.text) out.push(replyToMarkdown(d.text, d.citations, ctx), '');
      if (d.plan) out.push(planToMarkdown(d.plan, d.status), '');
    }
  });
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
};

export const markdownFilename = (meta) =>
  `${
    (meta?.title || 'conversation')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'conversation'
  }.md`;
