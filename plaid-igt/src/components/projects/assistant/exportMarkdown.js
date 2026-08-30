// A conversation as a Markdown document: the questions, the replies with
// their citations expanded to interlinear tables (linked to the sentence in
// the editor), plans with their changes and outcome, and errors. Tool traces
// are summarized in one line per reply. Pure: no DOM, so it is unit-tested.

const CITE_RE = /\{\{?\s*[^{}\n]+?\s+s\d+(?:\.w\d+)?\s*\}\}?|(?<![\w{.])s\d+(?:\.w\d+)?\b/g;

const esc = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

export const sentenceUrl = (origin, projectId, c) =>
  `${origin}#/projects/${projectId}/documents/${c.documentId}?tab=analyze&focusSentence=${c.sentenceId}`;

const citeLabel = (c) => `${c.documentName} s${c.sentence}${c.word ? `.w${c.word}` : ''}`;

// One cited sentence as a Markdown table: a column per word, a row per tier
// (words, morphemes, each field), then the sentence fields.
export const citationToMarkdown = (c, { origin, projectId }) => {
  const words = c.words || [];
  const tiers = [];
  words.forEach((w) =>
    (w.lines || []).forEach((l) => {
      if (!tiers.includes(l.field)) tiers.push(l.field);
    }),
  );
  const rows = [];
  if (words.some((w) => w.seg)) rows.push(['morphemes', ...words.map((w) => w.seg || '')]);
  tiers.forEach((name) =>
    rows.push([
      name,
      ...words.map((w) => (w.lines || []).find((l) => l.field === name)?.value || ''),
    ]),
  );
  const out = [`**[${esc(citeLabel(c))}](${sentenceUrl(origin, projectId, c)})**`, ''];
  if (words.length) {
    out.push(
      `| | ${words.map((w) => (c.word === w.index ? `**${esc(w.surface)}**` : esc(w.surface))).join(' | ')} |`,
    );
    out.push(`|---|${words.map(() => '---').join('|')}|`);
    rows.forEach((r) => out.push(`| ${r.map(esc).join(' | ')} |`));
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
  if (byKey.size === 0) return text || '';
  const inline = [];
  const shown = new Set();
  const lines = (text || '').split('\n').map((line) => {
    const key = line.trim();
    if (byKey.has(key)) {
      shown.add(key);
      return citationToMarkdown(byKey.get(key), ctx);
    }
    return line.replace(CITE_RE, (m) => {
      const c = byKey.get(m);
      if (!c) return m;
      if (!shown.has(m) && !inline.includes(c)) inline.push(c);
      return `[${citeLabel(c)}](${sentenceUrl(ctx.origin, ctx.projectId, c)})`;
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
