// Apply a restore plan (restorePlan.js) against the server, one phase at a
// time, re-reading the document between phases so each plan is made against
// what core actually left behind. The whole restore is one operation in the
// document's history, so the moment before it is itself restorable.

import {
  indexDocument,
  planText,
  planPartition,
  planLayer,
  planSpans,
  planLinks,
  planMetadata,
  mapPartitionIds,
  normalizeState,
  compareStates,
  summarizeRestore,
} from './restorePlan.js';

// One bulk call carries this many; plaid-core caps a batch at 1000 ops.
const BULK = 500;
const BATCH = 200;

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const formatWhen = (asOf) => {
  const d = new Date(asOf);
  return Number.isNaN(d.getTime()) ? String(asOf) : d.toLocaleString();
};

/**
 * The two states and what a restore would change, for the confirm step.
 */
export async function previewRestore({ client, documentId, asOf }) {
  const [curRaw, tgtRaw] = await Promise.all([
    client.documents.get(documentId, true),
    client.documents.get(documentId, true, asOf),
  ]);
  const cur = indexDocument(curRaw);
  const tgt = indexDocument(tgtRaw);
  return { name: curRaw?.name ?? null, summary: summarizeRestore(cur, tgt), cur, tgt };
}

/**
 * Restore the document to its state as of `asOf`. Returns
 * `{summary, warnings, exact, differences}`: `exact` is the self-check, the
 * document re-read afterwards and compared, id-free, with the target.
 */
export async function runRestore({ client, documentId, asOf, onProgress = () => {} }) {
  const read = async () => indexDocument(await client.documents.get(documentId, true));
  const warnings = [];
  const idMap = new Map(); // id as of T -> id now, for tokens that came back
  const { name, summary, tgt, cur: first } = await previewRestore({ client, documentId, asOf });
  let cur = first;

  await client.withOperation(`Restore “${name ?? documentId}” to ${formatWhen(asOf)}`, async () => {
    // ---- 1. text ---------------------------------------------------------
    onProgress('Text');
    const text = planText(cur, tgt);
    if (text?.kind === 'update') await client.texts.update(text.textId, text.body);
    else if (text?.kind === 'create') {
      await client.texts.create(
        text.textLayerId,
        documentId,
        text.body,
        text.metadata ?? undefined,
      );
    } else if (text?.kind === 'delete') await client.texts.delete(text.textId);
    if (text) cur = await read();

    // ---- 2. sentences -----------------------------------------------------
    onProgress('Sentences');
    const part = planPartition(cur, tgt);
    if (part.bulkDelete.length) {
      for (const ids of chunks(part.bulkDelete, BULK)) await client.tokens.bulkDelete(ids);
    }
    if (part.bulkCreate.length) {
      await createTokens(client, cur, 'sentence', part.bulkCreate, idMap);
    }
    if (part.ops.length) {
      const refs = new Map();
      const resolve = (id) => (typeof id === 'object' && id?.ref ? refs.get(id.ref) : id);
      for (const op of part.ops) {
        if (op.op === 'shift') await client.tokens.shift(resolve(op.id), op.begin, op.end);
        else if (op.op === 'merge') await client.tokens.merge(resolve(op.left), resolve(op.right));
        else if (op.op === 'split') {
          const res = await client.tokens.split(resolve(op.id), op.position);
          refs.set(op.ref, res?.id ?? res);
        }
      }
    }
    if (part.bulkDelete.length || part.bulkCreate.length || part.ops.length) cur = await read();
    mapPartitionIds(cur, tgt, idMap);

    // ---- 3. words, morphemes, alignment -----------------------------------
    for (const [role, label] of [
      ['word', 'Words'],
      ['morpheme', 'Morphemes'],
      ['alignment', 'Time alignment'],
    ]) {
      onProgress(label);
      const p = planLayer(cur, tgt, role, idMap);
      if (p.deletes.length) {
        for (const ids of chunks(p.deletes, BULK)) await client.tokens.bulkDelete(ids);
      }
      for (const batch of chunks(p.patches, BATCH)) {
        await client.batched(async () => {
          for (const t of batch) client.tokens.update(t.id, t.begin, t.end, t.precedence);
        });
      }
      if (p.creates.length) await createTokens(client, cur, role, p.creates, idMap);
      await applyMetadata(client, client.tokens, p.metadata);
      if (p.deletes.length || p.patches.length || p.creates.length || p.metadata.length) {
        cur = await read();
      }
    }

    // ---- 4. annotations ---------------------------------------------------
    onProgress('Annotations');
    const sp = planSpans(cur, tgt, idMap);
    for (const u of sp.unresolved) {
      warnings.push(`Annotation “${u.value ?? ''}” in ${u.layerName} could not be placed.`);
    }
    if (sp.deletes.length) {
      for (const ids of chunks(sp.deletes, BULK)) await client.spans.bulkDelete(ids);
    }
    for (const batch of chunks([...sp.updates, ...sp.retokens], BATCH)) {
      await client.batched(async () => {
        for (const x of batch) {
          if ('value' in x) client.spans.update(x.id, x.value);
          else client.spans.setTokens(x.id, x.tokens);
        }
      });
    }
    await applyMetadata(client, client.spans, sp.metadata);
    const byLayer = new Map();
    for (const c of sp.creates) {
      if (!byLayer.has(c.spanLayerId)) byLayer.set(c.spanLayerId, []);
      byLayer.get(c.spanLayerId).push(c);
    }
    for (const specs of byLayer.values()) {
      for (const chunk of chunks(specs, BULK)) {
        await client.spans.bulkCreate(
          chunk.map((c) => ({
            spanLayerId: c.spanLayerId,
            tokens: c.tokens,
            value: c.value,
            ...(Object.keys(c.metadata || {}).length ? { metadata: c.metadata } : {}),
          })),
        );
      }
    }
    if (sp.deletes.length || sp.updates.length || sp.retokens.length || sp.creates.length) {
      cur = await read();
    }

    // ---- 5. vocabulary links ----------------------------------------------
    onProgress('Vocabulary links');
    const lk = planLinks(cur, tgt, idMap);
    for (const u of lk.unresolved) {
      warnings.push(`The link to “${u.itemForm ?? 'an entry'}” could not be placed.`);
    }
    if (lk.deletes.length) {
      for (const ids of chunks(lk.deletes, BULK)) await client.vocabLinks.bulkDelete(ids);
    }
    for (const chunk of chunks(lk.creates, BULK)) {
      const specs = chunk.map((c) => ({
        vocabItem: c.itemId,
        tokens: c.tokens,
        ...(Object.keys(c.metadata || {}).length ? { metadata: c.metadata } : {}),
      }));
      try {
        await client.vocabLinks.bulkCreate(specs);
      } catch {
        // One entry deleted since T fails the whole bulk call; place the rest
        // one at a time and name the ones that cannot be.
        for (const [i, spec] of specs.entries()) {
          try {
            await client.vocabLinks.create(spec.vocabItem, spec.tokens, spec.metadata);
          } catch {
            warnings.push(
              `The link to “${chunk[i].itemForm ?? 'an entry'}” was not restored. The entry no longer exists.`,
            );
          }
        }
      }
    }
    await applyMetadata(client, client.vocabLinks, lk.metadata);

    // ---- 6. document and text metadata ------------------------------------
    onProgress('Metadata');
    const m = planMetadata(cur, tgt);
    if (m.document !== undefined) {
      if (m.document) await client.documents.setMetadata(documentId, m.document);
      else await client.documents.deleteMetadata(documentId);
    }
    if (m.text !== undefined && cur.text) {
      if (m.text) await client.texts.setMetadata(cur.text.id, m.text);
      else await client.texts.deleteMetadata(cur.text.id);
    }
  });

  onProgress('Checking');
  cur = await read();
  const differences = compareStates(normalizeState(cur), normalizeState(tgt));
  return { summary, warnings, exact: differences.length === 0, differences };
}

// Bulk-create tokens on one IGT layer, recording each new id against the id
// the token had at T.
async function createTokens(client, cur, role, creates, idMap) {
  const layer = cur.layers[role];
  const textId = cur.text?.id;
  if (!layer || !textId) return;
  for (const chunk of chunks(creates, BULK)) {
    const { ids } = await client.tokens.bulkCreate(
      chunk.map((c) => ({
        tokenLayerId: layer.id,
        text: textId,
        begin: c.begin,
        end: c.end,
        ...(c.precedence != null ? { precedence: c.precedence } : {}),
        ...(Object.keys(c.metadata || {}).length ? { metadata: c.metadata } : {}),
      })),
    );
    chunk.forEach((c, i) => {
      if (ids?.[i]) idMap.set(c.tid, ids[i]);
    });
  }
}

async function applyMetadata(client, api, changes) {
  for (const batch of chunks(changes, BATCH)) {
    await client.batched(async () => {
      for (const m of batch) {
        if (m.metadata) api.setMetadata(m.id, m.metadata);
        else api.deleteMetadata(m.id);
      }
    });
  }
}
