// A conversation as a Markdown document: the questions, the replies with
// their citations expanded by the app (`adapter.citationToMarkdown`), plans
// with their changes and outcome, and errors. Tool traces are summarized in
// one line per reply. Pure: no DOM, so it is unit-tested.

import { fencedLines, linkifyCitations, markdownText } from './citations.js';
import { formatElapsed } from '../../hooks/useRunProgress.js';
import {
  couldNotOpen,
  namedCitations,
  projectNamesAt,
  reachChanged,
  withProjects,
  homeOnly,
  planProjectAt,
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
  const raw = (text || '').split('\n');
  // A line inside a fenced block is code, whatever it holds.
  const fenced = fencedLines(raw);
  const lines = raw.map((line, i) => {
    if (fenced[i]) return line;
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
const planToMarkdown = (plan, status, interrupted, outcome, inProject) => {
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
  const where = inProject ? ` in ${markdownText(inProject)}` : '';
  const lines = [`**Proposed changes${where}:** ${plan.summary || ''} (${said})`, ''];
  (plan.labels || []).forEach((l, i) => lines.push(`${i + 1}. ${l}`));
  return lines.join('\n');
};

// The files on an item, as the chips under it name them: what was attached to
// a question, what a reply fetched (linked to where it came from, when that is
// a web address), and what a reply made for the user to download.
const WEB = /^https?:\/\//i;
const filesLine = (label, files) =>
  `*${label}: ${files
    .map((f) => {
      const name = markdownText(f.name || 'file');
      return f.source && WEB.test(f.source)
        ? `[${name}](<${String(f.source).replace(/[<>\s]/g, encodeURIComponent)}>)`
        : name;
    })
    .join(', ')}*`;

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
      if (d.files?.length) out.push(filesLine('Attached', d.files), '');
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
      const fetched = (d.files || []).filter((f) => !f.made);
      const made = (d.files || []).filter((f) => f.made);
      if (fetched.length) out.push(filesLine('Fetched', fetched), '');
      if (made.length) out.push(filesLine('Files', made), '');
      if (d.unavailableProjects?.length)
        out.push(`*${markdownText(couldNotOpen(d.unavailableProjects))}*`, '');
      if (d.text) {
        // A citation into another project is titled with that project's name.
        const cited = namedCitations(d.citations, projectId, projectNamesAt(display, i));
        out.push(replyToMarkdown(d.text, cited, ctx), '');
      }
      if (d.plan)
        out.push(
          planToMarkdown(d.plan, d.status, !!d.interrupted, d.outcome, planProjectAt(display, i)),
          '',
        );
    }
  });
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
};

// The file name, from the title. The web page export takes it with `html`.
export const markdownFilename = (meta, suffix = 'md') =>
  `${
    (meta?.title || 'conversation')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'conversation'
  }.${suffix}`;
