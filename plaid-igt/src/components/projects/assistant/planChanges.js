// A plan's changes as the card shows them: grouped by where they land (a
// document, a lexicon), each row linking to the place in the editor.
//
// The service locates every change (plaid-igt-agent's changes.py): `where`
// names the document and, for a token change, the sentence, word, and
// morpheme, with the word's offset for the editor's deep link; `change` is
// the label without that location. A plan from before this existed, or a
// change the service could not locate, falls back to its label whole.

export const ROWS_COLLAPSED = 12;

// The editor's deep link for a change (see citations.js for the same link on
// a cited sentence), or null when there is nothing to open yet.
export const changeHref = (projectId, where) => {
  if (!where) return null;
  if (where.kind === 'token') {
    const at = typeof where.begin === 'number' && where.word ? `&focusWord=${where.begin}` : '';
    return `#/projects/${projectId}/documents/${where.documentId}?tab=analyze&focusSentence=${where.sentenceId}${at}`;
  }
  if (where.kind === 'document') return `#/projects/${projectId}/documents/${where.documentId}`;
  if (where.kind === 'entry' && where.vocabId) return `#/vocabularies/${where.vocabId}`;
  return null;
};

// `s3.w2.m1`: the short reference the assistant and the person share.
export const changeRef = (where) => {
  if (!where || where.kind !== 'token') return '';
  return (
    `s${where.sentence}` +
    (where.word ? `.w${where.word}` : '') +
    (where.morpheme ? `.m${where.morpheme}` : '')
  );
};

// What the link's tooltip says: the place in words.
export const changeTitle = (where) => {
  if (!where) return '';
  if (where.kind === 'token') {
    let s = `${where.documentName}, sentence ${where.sentence}`;
    if (where.word) s += `, word ${where.word}`;
    if (where.morpheme) s += `, morpheme ${where.morpheme}`;
    return s;
  }
  if (where.kind === 'document') return where.documentName || '';
  if (where.kind === 'entry')
    return where.vocabName ? `${where.vocabName}: ${where.form}` : where.form || '';
  return '';
};

// The changes to show, in plan order: the service's located changes when
// they line up with the ops, else the labels alone.
export const planRows = (plan) => {
  const ops = plan?.ops || [];
  const changes = plan?.changes || [];
  if (changes.length && changes.length === ops.length) {
    return changes.map((c, i) => ({
      index: i,
      where: c.where || null,
      change: c.change || null,
      label: c.label || '',
    }));
  }
  return (plan?.labels || []).map((label, i) => ({ index: i, where: null, change: null, label }));
};

const groupKey = (where) => {
  if (!where) return 'other';
  if (where.kind === 'entry') return `entry:${where.vocabId || ''}`;
  return `doc:${where.documentId}`;
};

// Rows grouped by the document or lexicon they change, groups in order of
// first appearance, rows in plan order within each.
export const groupRows = (rows, projectId) => {
  const groups = [];
  const byKey = new Map();
  for (const row of rows) {
    const key = groupKey(row.where);
    let g = byKey.get(key);
    if (!g) {
      const w = row.where;
      g = {
        key,
        title: !w
          ? 'Other changes'
          : w.kind === 'entry'
            ? w.vocabName || 'Lexicon'
            : w.documentName || w.documentId,
        href: !w
          ? null
          : w.kind === 'entry'
            ? changeHref(projectId, w)
            : changeHref(projectId, { kind: 'document', documentId: w.documentId }),
        rows: [],
      };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(row);
  }
  return groups;
};

// The groups with only the first `limit` rows kept (headers do not count),
// for a collapsed card; the whole list when it fits.
export const collapseGroups = (groups, limit = ROWS_COLLAPSED) => {
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (total <= limit) return { groups, hidden: 0 };
  let left = limit;
  const out = [];
  for (const g of groups) {
    if (left <= 0) break;
    const rows = g.rows.slice(0, left);
    left -= rows.length;
    out.push({ ...g, rows });
  }
  return { groups: out, hidden: total - limit };
};
