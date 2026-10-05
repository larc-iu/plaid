// A conversation as a Markdown document: the questions, the replies with
// their citations expanded by the app (`adapter.citationToMarkdown`), plans
// with their changes and outcome, and errors. Tool traces are summarized in
// one line per reply. Pure: no DOM, so it is unit-tested.

import { linkifyCitations, markdownText } from './citations.js';
import { formatElapsed } from '../../hooks/useRunProgress.js';
import {
  couldNotOpen,
  namedCitations,
  projectNamesAt,
  reachChanged,
  withProjects,
  homeOnly,
} from './projectReach.js';

// A citation's card, linked into the project it cites: another project the
// conversation reads, or its own.
const cardToMarkdown = (c, ctx) =>
  ctx.adapter.citationToMarkdown(c, { ...ctx, projectId: c.projectId ?? ctx.projectId });

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
      return cardToMarkdown(byKey.get(key), ctx);
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
  return `${out}\n\n**Cited examples**\n\n${inline.map((c) => cardToMarkdown(c, ctx)).join('\n\n')}`;
};

// A plan that stopped partway says how much was written in the service's own
// count (`outcome` on the record), which counts each change a folded row
// stands for, as the card's message did.
const planToMarkdown = (plan, status, interrupted, outcome) => {
  const said =
    status === 'applied'
      ? 'Approved and applied.'
      : status === 'partial'
        ? `Partly applied: ${outcome}`
        : status === 'discarded'
          ? 'Discarded.'
          : status === 'stale'
            ? 'Out of date.'
            : status === 'replaced'
              ? 'Replaced by a later plan.'
              : interrupted
                ? 'Approved, but applying did not finish.'
                : 'Not yet approved.';
  const lines = [`**Proposed changes:** ${plan.summary || ''} (${said})`, ''];
  (plan.labels || []).forEach((l, i) => lines.push(`${i + 1}. ${l}`));
  return lines.join('\n');
};

export const conversationToMarkdown = (conv, meta, { origin, projectId, projectName, adapter }) => {
  const ctx = { origin, projectId, adapter };
  const out = [`# ${markdownText(meta?.title || 'Conversation')}`, ''];
  const facts = [];
  if (projectName) facts.push(`Project: ${markdownText(projectName)}`);
  if (meta?.model) facts.push(`Assistant: ${markdownText(meta.model)}`);
  if (meta?.createdAt) facts.push(`Started: ${meta.createdAt.slice(0, 10)}`);
  if (facts.length) out.push(facts.join(' · '), '');
  const display = conv?.display || [];
  display.forEach((d, i) => {
    if (d.kind === 'user') {
      out.push('## You', '');
      if (reachChanged(display, i)) {
        const line = d.projects?.length ? withProjects(d.projects) : homeOnly(projectName);
        out.push(`*${markdownText(line)}*`, '');
      }
      out.push(d.text || '', '');
    } else if (d.kind === 'error') {
      out.push(`> **Error:** ${d.text || ''}`, '');
    } else {
      out.push('## Assistant', '');
      // What it did before answering, in the service's own words.
      // As the panel shows it: never for a turn that called no tool.
      if (d.stepsSummary && d.steps?.length > 0) out.push(`*${d.stepsSummary}*`, '');
      if (typeof d.elapsedMs === 'number')
        out.push(`*Answered in ${formatElapsed(d.elapsedMs)}*`, '');
      if (d.contextNote) out.push(`*${d.contextNote}*`, '');
      if (d.unavailableProjects?.length)
        out.push(`*${markdownText(couldNotOpen(d.unavailableProjects))}*`, '');
      if (d.text) {
        // A citation into another project is titled with that project's name.
        const cited = namedCitations(d.citations, projectId, projectNamesAt(display, i));
        out.push(replyToMarkdown(d.text, cited, ctx), '');
      }
      if (d.plan) out.push(planToMarkdown(d.plan, d.status, !!d.interrupted, d.outcome), '');
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
