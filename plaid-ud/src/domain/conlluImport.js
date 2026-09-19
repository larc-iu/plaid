import { cpSlice } from '@larc-iu/plaid-client';
// By its real path rather than through `@ui`, for the same reason
// ConlluDocument.js gives: the `node --test` suite has no alias.
import { normalizeFeature } from '../utils/feats.js';
import { isProvKey } from '../utils/provenanceUi.js';
import { getUdLayerInfo, missingUdLayerLabels } from '../utils/udLayerUtils.js';
import { parseCoNLLU, buildConlluHierarchy } from '../utils/conlluParser.js';
import { SUPPRESS_KEY, planEnhancedRow } from './enhancedGraph.js';

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// CoNLL-U import: text in, a new document in the project out.
//
// Nothing here reads or writes a loaded document. It talks to the client and
// the parser and returns an id, which is why it lives beside ConlluDocument
// rather than inside it. `ConlluDocument.importFromConllu` is the name every
// caller uses and delegates here.
//
// Builds the sentence > word > morpheme hierarchy, creates the text + all
// tokens + annotation spans + dependency relations, and returns the newly
// created document id. On any failure, attempts to delete the partial
// document so the project isn't left polluted.
export async function importConlluDocument(
  client,
  projectId,
  name,
  conlluText,
  precomputedLayerInfo = null,
) {
  if (!name || !name.trim()) throw new Error('Document name is required');
  if (!conlluText || !conlluText.trim()) throw new Error('No content to import');

  const parsedData = parseCoNLLU(conlluText);
  if (parsedData.sentences.length === 0) {
    throw new Error('No valid sentences found in CoNLL-U data');
  }

  // Deliberately-unsupported data the parser dropped. Returned to the caller
  // (the import UI toasts these) — non-support must be loud, never silent.
  const importWarnings = [];
  const {
    emptyNodes = 0,
    miscTokens = 0,
    emptyNodeDeps = 0,
    unreadableDeps = 0,
  } = parsedData.dropped || {};
  if (emptyNodes > 0 || emptyNodeDeps > 0) {
    // One line for both: an enhanced dependency that hangs from an empty node
    // is lost to the same decision as the node.
    const parts = [];
    if (emptyNodes > 0)
      parts.push(`${count(emptyNodes, 'empty node', 'empty nodes')} (decimal-ID rows)`);
    if (emptyNodeDeps > 0) {
      parts.push(
        `${count(emptyNodeDeps, 'enhanced dependency', 'enhanced dependencies')} from an empty node`,
      );
    }
    importWarnings.push(`${parts.join(' and ')} dropped: Plaid UD does not store empty nodes.`);
  }
  if (unreadableDeps > 0) {
    importWarnings.push(
      `DEPS values on ${count(unreadableDeps, 'token row', 'token rows')} could not be read and were dropped.`,
    );
  }
  if (miscTokens > 0) {
    importWarnings.push(
      `MISC values on ${miscTokens} token row${miscTokens === 1 ? '' : 's'} ` +
        'dropped: Plaid UD does not store the MISC column.',
    );
  }

  let createdDocumentId = null;
  try {
    const documentResponse = await client.documents.create(projectId, name);
    createdDocumentId = documentResponse.id;
    // Layer config is project-level and identical for every document, so a
    // bulk-import caller can pass it in to skip a per-document round trip.
    const layerInfo =
      precomputedLayerInfo || getUdLayerInfo(await client.documents.get(createdDocumentId, true));

    if (!layerInfo.isConfigured) {
      const missingLabels = missingUdLayerLabels(layerInfo.missingLayers).join(', ');
      throw new Error(
        missingLabels
          ? `Project is missing required UD layer configuration: ${missingLabels}. Configure the project before importing.`
          : 'Project is missing required UD layer configuration. Configure the project before importing.',
      );
    }

    const {
      textLayer,
      sentenceTokenLayer,
      wordTokenLayer,
      morphemeTokenLayer,
      formLayer,
      lemmaLayer,
      uposLayer,
      xposLayer,
      featuresLayer,
      relationLayer,
      enhancedRelationLayer,
    } = layerInfo;

    // What each row's DEPS adds to the enhanced layer: nothing at all for the
    // usual file, whose DEPS is `_` or restates the tree.
    const enhancedPlans = parsedData.sentences.map((s) => {
      // Whether this sentence is annotated for the enhanced graph at all,
      // which is what a bare `_` on one of its words means (enhancedGraph.js).
      const hasDeps = s.tokens.some((t) => t.deps);
      // A DEPS value that could not be read is dropped with a warning, and
      // says nothing: the word keeps the relation its tree gives it.
      return s.tokens.map((t) => planEnhancedRow(t, t.deps, hasDeps && !t.depsUnreadable));
    });
    if (!enhancedRelationLayer) {
      const lost = enhancedPlans
        .flat()
        .reduce((n, plan) => n + plan.extras.length + (plan.suppress ? 1 : 0), 0);
      if (lost > 0) {
        importWarnings.push(
          `${count(lost, 'enhanced dependency', 'enhanced dependencies')} dropped: ` +
            'this project has no enhanced dependency layer yet. ' +
            'One is added the first time a maintainer opens a document in it.',
        );
      }
    }

    const hierarchy = buildConlluHierarchy(parsedData);

    // Rows a dependency relation will touch: its target (the row carrying
    // the DEPREL) and its source (the row that one names as HEAD). Each
    // needs a LEMMA span for the relation to hang off, even where the file's
    // LEMMA column is `_`: that is the same null-valued span the editor
    // leaves behind when a lemma is cleared, for the same reason, and it
    // exports as `_` again. Without it an unlemmatized treebank imported
    // with every tree in it dropped, in silence.
    const needsLemma = parsedData.sentences.map((s, sentIdx) => {
      const rows = new Set();
      s.tokens.forEach((t, tokIdx) => {
        if (t.deprel) {
          rows.add(t.id);
          if (t.head > 0) rows.add(t.head);
        }
        if (!enhancedRelationLayer) return;
        // An extra enhanced edge hangs off the same two kinds of row.
        enhancedPlans[sentIdx][tokIdx].extras.forEach((e) => {
          rows.add(t.id);
          if (e.head > 0) rows.add(e.head);
        });
      });
      return rows;
    });

    // Synthetic-offset fallback (no-space/CJK scripts, or a missing `# text`):
    // when a token's surface form can't be located in the sentence text, the
    // hierarchy builder places it gap-free, so its offsets won't match the
    // original. Surface that fidelity loss like the other dropped categories
    // instead of leaving it a silent console.warn.
    const { syntheticOffsetSentences = 0 } = hierarchy.dropped || {};
    if (syntheticOffsetSentences > 0) {
      importWarnings.push(
        `${syntheticOffsetSentences} sentence${syntheticOffsetSentences === 1 ? '' : 's'} used synthetic offsets ` +
          "(their tokens couldn't be located in the sentence text, so positions won't match the original).",
      );
    }

    const textResponse = await client.texts.create(textLayer.id, createdDocumentId, hierarchy.text);
    const textId = textResponse.id;

    // Sentences carry arbitrary `# k = v` metadata; words carry the MWT
    // surface form on `metadata.form` ONLY when the FORM column was
    // explicitly non-underscore. (MISC is not stored — see scope decisions.)
    const sentenceOps = hierarchy.sentences.map((s) => {
      const op = {
        tokenLayerId: sentenceTokenLayer.id,
        text: textId,
        begin: s.begin,
        end: s.end,
      };
      // Drop reserved provenance keys: a `# prov = inferred` comment is not
      // something a CoNLL-U file can assert (only a producer stamps it, and
      // the exporter never emits it — see _buildConllu).
      const meta = Object.fromEntries(
        Object.entries(s.metadata || {}).filter(([k]) => !isProvKey(k)),
      );
      if (Object.keys(meta).length > 0) op.metadata = meta;
      return op;
    });
    const wordOps = [];
    hierarchy.sentences.forEach((s) =>
      s.words.forEach((w) => {
        const op = { tokenLayerId: wordTokenLayer.id, text: textId, begin: w.begin, end: w.end };
        const meta = {};
        if (w.isMwt && w.hasExplicitForm && w.surfaceForm) meta.form = w.surfaceForm;
        if (Object.keys(meta).length > 0) op.metadata = meta;
        wordOps.push(op);
      }),
    );
    const morphemeOps = [];
    const morphemeMeta = []; // parallel to morphemeOps
    hierarchy.sentences.forEach((s, sentIdx) => {
      s.words.forEach((w) => {
        const wordSubstring = cpSlice(hierarchy.text, w.begin, w.end);
        w.morphemes.forEach((m) => {
          morphemeOps.push({
            tokenLayerId: morphemeTokenLayer.id,
            text: textId,
            begin: m.begin,
            end: m.end,
            precedence: m.precedence,
          });
          morphemeMeta.push({ sentIdx, row: m.row, wordSubstring });
        });
      });
    });

    // Token batch: sentences -> words -> morphemes, atomic. `morphemeResultIndex`
    // must live outside the batched() callback so it's readable after it returns.
    let morphemeResultIndex = -1;
    const tokenResults = await client.batched(async (b) => {
      b.tokens.bulkCreate(sentenceOps);
      if (wordOps.length > 0) b.tokens.bulkCreate(wordOps);
      if (morphemeOps.length > 0) {
        b.tokens.bulkCreate(morphemeOps);
        morphemeResultIndex = wordOps.length > 0 ? 2 : 1;
      }
    });
    const morphemeIds =
      morphemeResultIndex >= 0 ? tokenResults[morphemeResultIndex]?.body?.ids || [] : [];
    // Every annotation is addressed by its morpheme's position in this list,
    // so a short one would attach some and drop the rest while the import
    // still reported success. Fail instead: the catch below rolls the
    // document back.
    if (morphemeIds.length !== morphemeOps.length) {
      throw new Error(
        `Import failed: the server returned ${morphemeIds.length} morpheme ids for ` +
          `${morphemeOps.length} morphemes, so the annotations could not be attached.`,
      );
    }

    // Annotation spans on morphemes. Bundle all five into ONE atomic batch.
    const lemmaSpanIds = parsedData.sentences.map((s) => s.tokens.map(() => null));
    const formOps = [];
    const lemmaOps = [];
    const lemmaMeta = [];
    const uposOps = [];
    const xposOps = [];
    const featOps = [];

    morphemeMeta.forEach((meta, i) => {
      const morphemeId = morphemeIds[i];
      if (!morphemeId) return;
      const row = meta.row;
      const rowIndex = row.id - 1;

      if (formLayer && row.form && row.form !== meta.wordSubstring) {
        formOps.push({ spanLayerId: formLayer.id, tokens: [morphemeId], value: row.form });
      }
      if (lemmaLayer && (row.lemma || needsLemma[meta.sentIdx]?.has(row.id))) {
        lemmaOps.push({
          spanLayerId: lemmaLayer.id,
          tokens: [morphemeId],
          value: row.lemma || null,
        });
        lemmaMeta.push({ sentIdx: meta.sentIdx, rowIndex });
      }
      if (uposLayer && row.upos) {
        uposOps.push({ spanLayerId: uposLayer.id, tokens: [morphemeId], value: row.upos });
      }
      if (xposLayer && row.xpos) {
        xposOps.push({ spanLayerId: xposLayer.id, tokens: [morphemeId], value: row.xpos });
      }
      if (featuresLayer && Array.isArray(row.feats)) {
        // Through the one reader, so an off-spec `Gender = Fem` in the file
        // lands under the same name a typed one does. A pair the reader cannot
        // complete (`Gender=`, or an empty entry from `A=1||B=2`) is nothing to
        // store. What the file says otherwise stands: an import records a
        // corpus, and the Validation tab is where what it recorded is judged.
        row.feats.forEach((f) => {
          const feature = normalizeFeature(f);
          if (!feature) return;
          featOps.push({
            spanLayerId: featuresLayer.id,
            tokens: [morphemeId],
            value: feature.pair,
          });
        });
      }
    });

    const spanOpsInOrder = [];
    // batched() submits an empty batch as a no-op ([]), so the old
    // "submit only if something was queued" guard is unnecessary.
    const spanResults = await client.batched(async (b) => {
      if (formOps.length) {
        b.spans.bulkCreate(formOps);
        spanOpsInOrder.push('form');
      }
      if (lemmaOps.length) {
        b.spans.bulkCreate(lemmaOps);
        spanOpsInOrder.push('lemma');
      }
      if (uposOps.length) {
        b.spans.bulkCreate(uposOps);
        spanOpsInOrder.push('upos');
      }
      if (xposOps.length) {
        b.spans.bulkCreate(xposOps);
        spanOpsInOrder.push('xpos');
      }
      if (featOps.length) {
        b.spans.bulkCreate(featOps);
        spanOpsInOrder.push('feat');
      }
    });
    const lemmaResultIdx = spanOpsInOrder.indexOf('lemma');
    if (lemmaResultIdx >= 0) {
      const ids = spanResults[lemmaResultIdx]?.body?.ids || [];
      if (ids.length !== lemmaOps.length) {
        throw new Error(
          `Import failed: the server returned ${ids.length} Lemma span ids for ` +
            `${lemmaOps.length} lemmas, so the dependency relations could not be attached.`,
        );
      }
      lemmaMeta.forEach((lm, k) => {
        lemmaSpanIds[lm.sentIdx][lm.rowIndex] = ids[k];
      });
    }

    // Dependency relations — a separate follow-up batch since they
    // reference lemma span ids produced above.
    if (relationLayer) {
      const relationOps = [];
      parsedData.sentences.forEach((sentence, sentIdx) => {
        const ids = lemmaSpanIds[sentIdx];
        sentence.tokens.forEach((token, tokIdx) => {
          const targetId = ids[tokIdx];
          if (!token.deprel || !targetId) return;
          if (token.head === 0) {
            relationOps.push({
              relationLayerId: relationLayer.id,
              source: targetId,
              target: targetId,
              value: token.deprel,
            });
          } else if (token.head > 0) {
            const sourceId = ids[token.head - 1];
            if (sourceId) {
              relationOps.push({
                relationLayerId: relationLayer.id,
                source: sourceId,
                target: targetId,
                value: token.deprel,
              });
            }
          }
        });
      });
      // The enhanced layer's rows, in the same batch as the tree they differ
      // from but in a bulk create of their own: the server takes one layer's
      // relations to a call. A suppressor lies over its row's own basic
      // relation, so it is written only where that relation was.
      const enhancedOps = [];
      let headlessDeps = 0;
      if (enhancedRelationLayer) {
        const basicPairs = new Set(relationOps.map((op) => `${op.source} ${op.target}`));
        parsedData.sentences.forEach((sentence, sentIdx) => {
          const ids = lemmaSpanIds[sentIdx];
          sentence.tokens.forEach((token, tokIdx) => {
            const targetId = ids[tokIdx];
            if (!targetId) return;
            const plan = enhancedPlans[sentIdx][tokIdx];
            const spanOf = (head) => (head === 0 ? targetId : ids[head - 1]);
            const basicSource = token.deprel ? spanOf(token.head) : null;
            if (plan.suppress && basicSource && basicPairs.has(`${basicSource} ${targetId}`)) {
              enhancedOps.push({
                relationLayerId: enhancedRelationLayer.id,
                source: basicSource,
                target: targetId,
                value: null,
                metadata: { [SUPPRESS_KEY]: true },
              });
            }
            plan.extras.forEach((e) => {
              const sourceId = spanOf(e.head);
              if (!sourceId) {
                headlessDeps += 1;
                return;
              }
              enhancedOps.push({
                relationLayerId: enhancedRelationLayer.id,
                source: sourceId,
                target: targetId,
                value: e.deprel,
              });
            });
          });
        });
      }
      if (headlessDeps > 0) {
        importWarnings.push(
          `${count(headlessDeps, 'enhanced dependency', 'enhanced dependencies')} dropped: ` +
            'the head is not a row of the sentence.',
        );
      }
      if (relationOps.length > 0 || enhancedOps.length > 0) {
        await client.batched(async (b) => {
          if (relationOps.length > 0) b.relations.bulkCreate(relationOps);
          if (enhancedOps.length > 0) b.relations.bulkCreate(enhancedOps);
        });
      }
    }

    return { documentId: createdDocumentId, importWarnings };
  } catch (err) {
    if (createdDocumentId) {
      try {
        await client.documents.delete(createdDocumentId);
      } catch (delErr) {
        console.error('Failed to clean up document after import failure:', delErr);
        // Surface the orphan id so the user knows they need to clean up
        // manually. The original error message stays at the front.
        const wrapped = new Error(
          `${err?.message || 'Import failed'} (rollback also failed, ` +
            `delete orphan document ${createdDocumentId} manually)`,
        );
        wrapped.cause = err;
        throw wrapped;
      }
    }
    throw err;
  }
}
