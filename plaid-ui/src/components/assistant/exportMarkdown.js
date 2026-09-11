// A conversation as a Markdown document: the questions, the replies with
// their citations expanded by the app (`adapter.citationToMarkdown`), plans
// with their changes and outcome, and errors. Tool traces are summarized in
// one line per reply. Pure: no DOM, so it is unit-tested.

import { linkifyCitations } from './citations.js';

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
      return ctx.adapter.citationToMarkdown(byKey.get(key), ctx);
    }
    return linkifyCitations(ctx.adapter, line, byKey, {
      ...ctx,
      onCited: (m, c) => {
        if (!shown.has(m) && !inline.includes(c)) inline.push(c);
      },
    });
  });
  const out = lines.join('\n');
  if (!inline.length) return out;
  return `${out}\n\n**Cited examples**\n\n${inline.map((c) => ctx.adapter.citationToMarkdown(c, ctx)).join('\n\n')}`;
};

const planToMarkdown = (plan, status, interrupted) => {
  const outcome =
    status === 'applied'
      ? 'Approved and applied.'
      : status === 'discarded'
        ? 'Discarded.'
        : interrupted
          ? 'Approved, but applying did not finish.'
          : 'Not yet approved.';
  const lines = [`**Proposed changes:** ${plan.summary || ''} (${outcome})`, ''];
  (plan.labels || []).forEach((l, i) => lines.push(`${i + 1}. ${l}`));
  return lines.join('\n');
};

export const conversationToMarkdown = (conv, meta, { origin, projectId, projectName, adapter }) => {
  const ctx = { origin, projectId, adapter };
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
      // What it did before answering, in the service's own words.
      if (d.stepsSummary) out.push(`*${d.stepsSummary}*`, '');
      if (d.text) out.push(replyToMarkdown(d.text, d.citations, ctx), '');
      if (d.plan) out.push(planToMarkdown(d.plan, d.status, !!d.interrupted), '');
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
