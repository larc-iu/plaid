// A sentence as a small mutable graph: what the local matcher reads and the
// rewriting commands change. Built from one row of `ConlluDocument.sentences`,
// so node ids are syntactic-word token ids and edge ids are relation ids, and
// every node remembers the span ids behind its features (the address book
// diff.js needs to turn a changed graph back into writes).
//
// Grew features map onto the UD columns the way the search compiler maps them
// (compile.js): `form`, `lemma`, `upos`, `xpos` are the column features (case-
// insensitive names), anything else is a FEATS key. The root relation is the
// self-loop the UD import stores (source = target, label `root`), not Grew's
// pseudo-node, matching what the search box already matches.

const COLUMNS = { form: 'form', lemma: 'lemma', upos: 'upos', xpos: 'xpos' };

// The column a Grew feature name addresses, or null for a FEATS key.
export const columnOf = (name) => COLUMNS[String(name).toLowerCase()] || null;

export function graphFromSentence(row) {
  const nodes = new Map();
  const order = [];
  for (const entry of row.tokens) {
    const id = entry.token.id;
    const feats = new Map();
    const featSpanIds = new Map();
    const featMeta = new Map();
    for (const f of entry.feats) {
      const eq = String(f.value).indexOf('=');
      const key = eq === -1 ? String(f.value) : String(f.value).slice(0, eq);
      const val = eq === -1 ? '' : String(f.value).slice(eq + 1);
      feats.set(key, val);
      featSpanIds.set(key, f.id);
      featMeta.set(key, f.metadata || null);
    }
    nodes.set(id, {
      id,
      pos: order.length,
      form: entry.tokenForm ?? '',
      lemma: entry.lemma?.value ?? undefined,
      upos: entry.upos?.value ?? undefined,
      xpos: entry.xpos?.value ?? undefined,
      feats,
      // Where each current value lives on the server (null = no span yet).
      spanIds: {
        form: entry.form?.id || null,
        lemma: entry.lemma?.id || null,
        upos: entry.upos?.id || null,
        xpos: entry.xpos?.id || null,
        features: featSpanIds,
      },
      spanMeta: {
        form: entry.form?.metadata || null,
        lemma: entry.lemma?.metadata || null,
        upos: entry.upos?.metadata || null,
        xpos: entry.xpos?.metadata || null,
        features: featMeta,
      },
      substring: entry.word ? entry.wordForm : entry.tokenForm,
      wordId: entry.word?.id || null,
      wordHasMultiple: !!entry.wordHasMultipleMorphemes,
      deleted: false,
    });
    order.push(id);
  }

  // Relations are anchored on lemma spans; resolve them to node ids.
  const nodeByLemmaSpan = new Map();
  for (const n of nodes.values()) if (n.spanIds.lemma) nodeByLemmaSpan.set(n.spanIds.lemma, n.id);
  const edges = new Map();
  for (const rel of row.relations) {
    const src = nodeByLemmaSpan.get(rel.source);
    const tgt = nodeByLemmaSpan.get(rel.target);
    if (!src || !tgt) continue; // an inter-sentential or dangling relation
    edges.set(rel.id, {
      id: rel.id,
      src,
      tgt,
      label: rel.value ?? '',
      metadata: rel.metadata || null,
    });
  }

  return {
    sentence: {
      id: row.id,
      text: row.text,
      metadata: row.sentenceToken?.metadata || {},
    },
    nodes,
    order,
    edges,
    nextId: 1,
  };
}

// A deep copy the commands can change while the original stays for the diff.
export function cloneGraph(g) {
  const nodes = new Map();
  for (const n of g.nodes.values()) {
    nodes.set(n.id, {
      ...n,
      feats: new Map(n.feats),
      spanIds: { ...n.spanIds, features: new Map(n.spanIds.features) },
      spanMeta: { ...n.spanMeta, features: new Map(n.spanMeta.features) },
    });
  }
  const edges = new Map();
  for (const e of g.edges.values()) edges.set(e.id, { ...e });
  return { sentence: g.sentence, nodes, order: [...g.order], edges, nextId: g.nextId };
}

// Live nodes in linear order.
export const liveNodes = (g) => g.order.map((id) => g.nodes.get(id)).filter((n) => !n.deleted);

export function getFeat(node, name) {
  const col = columnOf(name);
  if (col) return node[col];
  return node.feats.get(String(name));
}

export function setFeat(node, name, value) {
  const col = columnOf(name);
  if (col) node[col] = value;
  else node.feats.set(String(name), value);
}

export function delFeat(node, name) {
  const col = columnOf(name);
  if (col) node[col] = undefined;
  else node.feats.delete(String(name));
}

// Edges in a stable order: by source position, target position, then id.
export function sortedEdges(g) {
  const pos = (id) => g.nodes.get(id)?.pos ?? 0;
  return [...g.edges.values()].sort(
    (a, b) =>
      pos(a.src) - pos(b.src) ||
      pos(a.tgt) - pos(b.tgt) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

export const outEdges = (g, id) => sortedEdges(g).filter((e) => e.src === id);
export const inEdges = (g, id) => sortedEdges(g).filter((e) => e.tgt === id);

// A new edge id for an edge the commands add (never a server id).
export function freshEdgeId(g) {
  return `new-${g.nextId++}`;
}

// The UD deprel split the way Grew sees an edge label: `nsubj:pass` is
// `1=nsubj, 2=pass`. Returns ['nsubj', 'pass'].
export const labelParts = (label) => (label === '' ? [] : String(label).split(':'));
export const joinLabel = (parts) => parts.filter((p) => p != null && p !== '').join(':');
