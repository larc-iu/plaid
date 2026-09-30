// A document read brought up to date from the answer to a text edit (PATCH
// /texts/:id), instead of reading the whole document again. The answer names
// every row the edit wrote, read from the edit's own audit rows: the new body
// and its digest, each token's new extent, each span's and vocab link's new
// token list (and a span's value when a layer rule's remedy changed it), and
// every row deleted with them.
//
// Generic over the document read's tree (text layers, their token layers,
// span layers, relation layers and vocabularies), with nothing of any app.
// Dependency-free, so plaid-ud's node suite can load it.

const ids = (list) => new Set(list ?? []);
const byId = (list) => new Map((list ?? []).map((row) => [row.id, row]));

// The core's token order: begin, then precedence (none last), then end, then id.
function tokenOrder(a, b) {
  if (a.begin !== b.begin) return a.begin - b.begin;
  const pa = a.precedence ?? null;
  const pb = b.precedence ?? null;
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb;
  }
  if (a.end !== b.end) return a.end - b.end;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// `list` with deleted rows dropped and `patch` applied to each row it
// changes, or `list` itself when nothing changed.
function patchRows(list, deleted, patch) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const out = [];
  for (const row of list) {
    if (deleted.has(row.id)) {
      changed = true;
      continue;
    }
    const next = patch(row);
    if (next !== row) changed = true;
    out.push(next);
  }
  return changed ? out : list;
}

const sameList = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * `raw` (a document read with its bodies, as plaid-client returns it) with
 * the answer to a text edit of text `textId` applied: the text's body and
 * digest, token extents, span and vocab-link token lists (and span values),
 * and the rows the edit deleted removed. `raw` is not changed, and a part of
 * it the answer does not touch is shared with the result.
 */
export function applyReshape(raw, textId, answer) {
  const reshape = answer?.reshape ?? {};
  const extents = byId(reshape.tokens);
  const spanTokens = byId(reshape.spans);
  const linkTokens = byId(reshape.vocabLinks);
  const deleted = {
    tokens: ids(reshape.deleted?.tokens),
    spans: ids(reshape.deleted?.spans),
    relations: ids(reshape.deleted?.relations),
    vocabLinks: ids(reshape.deleted?.vocabLinks),
  };

  const withTokens = (rows) => (row) => {
    const next = rows.get(row.id);
    return next && Array.isArray(next.tokens) && !sameList(next.tokens, row.tokens)
      ? { ...row, tokens: next.tokens }
      : row;
  };

  const patchRelationLayer = (layer) => {
    const relations = patchRows(layer.relations, deleted.relations, (r) => r);
    return relations === layer.relations ? layer : { ...layer, relations };
  };

  // A span's entry gives its value too when a layer rule's remedy changed it.
  const withTokensAndValue = (row) => {
    const moved = withTokens(spanTokens)(row);
    const next = spanTokens.get(row.id);
    return next && 'value' in next && !Object.is(next.value, moved.value)
      ? { ...moved, value: next.value }
      : moved;
  };

  const patchSpanLayer = (layer) => {
    const spans = patchRows(layer.spans, deleted.spans, withTokensAndValue);
    const relationLayers = patchRows(layer.relationLayers, new Set(), patchRelationLayer);
    return spans === layer.spans && relationLayers === layer.relationLayers
      ? layer
      : { ...layer, spans, relationLayers };
  };

  const patchVocab = (vocab) => {
    const vocabLinks = patchRows(vocab.vocabLinks, deleted.vocabLinks, withTokens(linkTokens));
    return vocabLinks === vocab.vocabLinks ? vocab : { ...vocab, vocabLinks };
  };

  const patchTokenLayer = (layer) => {
    let tokens = patchRows(layer.tokens, deleted.tokens, (token) => {
      const extent = extents.get(token.id);
      return extent && (extent.begin !== token.begin || extent.end !== token.end)
        ? { ...token, begin: extent.begin, end: extent.end }
        : token;
    });
    // A token the edit made (the core names its layer and text): a sentence
    // over a line typed before the first one.
    const have = new Set((layer.tokens ?? []).map((t) => t.id));
    const made = (reshape.tokens ?? []).filter(
      (t) => t.layer === layer.id && !have.has(t.id) && !deleted.tokens.has(t.id),
    );
    if (made.length) {
      tokens = [
        ...(tokens ?? []),
        ...made.map((t) => ({ id: t.id, text: t.text, begin: t.begin, end: t.end, metadata: {} })),
      ];
    }
    if (tokens !== layer.tokens) tokens = [...tokens].sort(tokenOrder);
    const spanLayers = patchRows(layer.spanLayers, new Set(), patchSpanLayer);
    const vocabs = patchRows(layer.vocabs, new Set(), patchVocab);
    return tokens === layer.tokens && spanLayers === layer.spanLayers && vocabs === layer.vocabs
      ? layer
      : { ...layer, tokens, spanLayers, vocabs };
  };

  const patchTextLayer = (layer) => {
    let text = layer.text;
    if (text && text.id === textId) {
      text = { ...text, body: answer.body, digest: answer.digest };
    }
    const tokenLayers = patchRows(layer.tokenLayers, new Set(), patchTokenLayer);
    return text === layer.text && tokenLayers === layer.tokenLayers
      ? layer
      : { ...layer, text, tokenLayers };
  };

  const textLayers = patchRows(raw.textLayers, new Set(), patchTextLayer);
  return textLayers === raw.textLayers ? raw : { ...raw, textLayers };
}
