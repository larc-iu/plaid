// Render a derived sentence (IgtDocument doc.sentences[i] shape) as
// publication-ready interlinear text. Pure functions — unit-tested, no DOM.
//
// Formats:
//   plain — column-aligned text (one line per tier + quoted free translation)
//   gb4e  — LaTeX \begin{exe}\ex\gll … (two aligned lines + \glt)
//   expex — LaTeX \ex\begingl \gla/\glb/\glft … (safe expex subset)
//
// Line 1 is always the morpheme-segmented word forms ("tod-os"); the gloss
// line(s) join each word's morpheme values with "-". Words with no morphemes
// fall back to their surface form. LaTeX formats need equal token counts per
// line, so empty glosses become {}.

export const COPY_FORMATS = [
  { id: 'plain', label: 'Plain text (aligned)' },
  { id: 'gb4e', label: 'LaTeX — gb4e' },
  { id: 'expex', label: 'LaTeX — ExPex' },
];

export const COPY_FORMAT_STORAGE_KEY = 'plaid_igt_copy_format';

const cpLen = (s) => [...(s ?? '')].length;

const morphFormOf = (m) => {
  const meta = m?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return m?.content ?? '';
};

// Per-word cells: segmented form + one joined-gloss string per morph field +
// one value per word field.
function wordCells(token, { morphFields, wordFields }) {
  const morphemes = token.morphemes || [];
  const segmented = morphemes.length
    ? morphemes.map((m) => morphFormOf(m)).join('-')
    : (token.content ?? '');
  const morphLines = morphFields.map((f) =>
    morphemes.length
      ? morphemes.map((m) => m.annotations?.[f]?.value ?? '').join('-')
      : '');
  const wordLines = wordFields.map((f) => token.annotations?.[f]?.value ?? '');
  return { segmented, morphLines, wordLines };
}

function tiers(sentence, fields) {
  const cells = (sentence.tokens || []).map((t) => wordCells(t, fields));
  const lines = [{ label: null, cells: cells.map((c) => c.segmented) }];
  fields.morphFields.forEach((f, i) => {
    lines.push({ label: f, cells: cells.map((c) => c.morphLines[i]) });
  });
  fields.wordFields.forEach((f, i) => {
    lines.push({ label: f, cells: cells.map((c) => c.wordLines[i]) });
  });
  return lines;
}

function translations(sentence, fields) {
  return fields.sentFields
    .map((f) => ({ label: f, value: sentence.annotations?.[f]?.value ?? '' }))
    .filter((t) => t.value !== '');
}

// ---- plain ----------------------------------------------------------------
export function formatPlain(sentence, fields) {
  const lines = tiers(sentence, fields);
  const n = lines[0].cells.length;
  const widths = Array.from({ length: n }, (_, i) =>
    Math.max(...lines.map((l) => cpLen(l.cells[i]))));
  const out = lines.map((l) =>
    l.cells.map((c, i) => c + ' '.repeat(widths[i] - cpLen(c))).join('  ').trimEnd());
  for (const t of translations(sentence, fields)) out.push(`‘${t.value}’`);
  return out.join('\n');
}

// ---- LaTeX ----------------------------------------------------------------
const LATEX_SPECIALS = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#',
  '_': '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};
const texEscape = (s) => [...(s ?? '')].map((ch) => LATEX_SPECIALS[ch] ?? ch).join('');
const texCell = (s) => (s === '' ? '{}' : texEscape(s));

export function formatGb4e(sentence, fields) {
  const lines = tiers(sentence, fields);
  const forms = lines[0].cells.map(texCell).join(' ');
  // gb4e's \gll takes exactly two aligned lines: forms + the first gloss tier.
  const gloss = (lines[1]?.cells ?? lines[0].cells.map(() => '')).map(texCell).join(' ');
  const tr = translations(sentence, fields)[0]?.value ?? '';
  return [
    '\\begin{exe}',
    '\\ex',
    `\\gll ${forms}\\\\`,
    `     ${gloss}\\\\`,
    `\\glt \`${texEscape(tr)}'`,
    '\\end{exe}',
  ].join('\n');
}

export function formatExpex(sentence, fields) {
  const lines = tiers(sentence, fields);
  const forms = lines[0].cells.map(texCell).join(' ');
  const gloss = (lines[1]?.cells ?? lines[0].cells.map(() => '')).map(texCell).join(' ');
  const tr = translations(sentence, fields)[0]?.value ?? '';
  return [
    '\\ex',
    '\\begingl',
    `\\gla ${forms} //`,
    `\\glb ${gloss} //`,
    `\\glft \`${texEscape(tr)}' //`,
    '\\endgl',
    '\\xe',
  ].join('\n');
}

export function formatSentence(sentence, fields, format) {
  if (format === 'gb4e') return formatGb4e(sentence, fields);
  if (format === 'expex') return formatExpex(sentence, fields);
  return formatPlain(sentence, fields);
}
