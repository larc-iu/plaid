// Other apps' layers in a native archive, made again on import.
//
// The archive carries whatever another Plaid app keeps in the project as plain
// Plaid data (see domain/otherLayers.js and export/nativeJson.js): project
// settings, layers with their settings, and per document the tokens, spans and
// relations on them. This module puts all of that back without knowing what
// any of it means. `restoreOtherLayers` runs once per project, after setup has
// made this app's own layers, and `importOtherLayerData` once per document,
// after this app's own tokens and annotations exist.
//
// Archive ids are correlation keys here as everywhere: each layer, token, span
// and relation is made fresh and found again through an old-to-new map.

import { PLAID_NAMESPACE, ROLES, createdIds, uuidv7 } from '@larc-iu/plaid-client';
import { bulkInChunks, withMintedIds } from '../../domain/bulk.js';
import { ensureLayerConstraints } from '../../../../plaid-ui/src/lib/layerConstraints.js';
import { humanizeError } from '../../../../plaid-ui/src/lib/errors.js';
import { sameConfig } from '../../../../plaid-ui/src/domain/configCells.js';
import { countOf } from '../../../../plaid-ui/src/lib/plural.js';
import { escapeJsRegex } from '../../../../plaid-ui/src/lib/jsRegex.js';
import { IGT_NAMESPACE, findBaselineTextLayer, readScope } from '../../domain/igtConfig.js';
import { dropReferences } from './references.js';
import {
  UNCARRIED_PLAID_KEYS,
  otherTokenLayers,
  ownTokenLayers,
  parentsFirst,
} from '../../domain/otherLayers.js';

const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// The keys of the archive's `layers` naming this app's own token layers.
const OWN_LAYER_KEYS = [
  ['sentence', ROLES.SENTENCE],
  ['word', ROLES.WORD],
  ['morpheme', ROLES.MORPHEME],
  ['timeAlignment', ROLES.TIME_ALIGNMENT],
];

// A warning names what the linguist knows, never the layer underneath.
const ROLE_NOUN = {
  [ROLES.BASELINE]: 'the text',
  [ROLES.SENTENCE]: 'sentences',
  [ROLES.WORD]: 'words',
  [ROLES.SYNTACTIC_WORD]: 'syntactic words',
  [ROLES.MORPHEME]: 'morphemes',
  [ROLES.TIME_ALIGNMENT]: 'time alignment',
};
const roleNoun = (role) => ROLE_NOUN[role] ?? role;
const NOT_DESCRIBED = 'the archive does not describe where they go';

/** What `restoreOtherLayers` found or made: archive ids mapped onto the project's. */
export const noOtherLayers = () => ({
  // Archive token layer ids, parents first: the order their tokens are made in.
  order: [],
  // Every archive layer id -> new id, this app's and vocabularies included,
  // once restoreOtherLayers has run.
  ids: new Map(),
  tokenLayers: new Map(), // archive id -> {id, overlapMode}
  spanLayers: new Map(), // archive id -> id
  relationLayers: new Map(), // archive id -> id
  // This app's own layers: archive id -> id, for a rule that names one.
  ownLayers: new Map(),
  // The layer rules the archive carries, per layer restored:
  // {kind, layerId, name, constraints: {namespace: [rule]}, stored}.
  rules: [],
});

/**
 * Write each key of `config` that the layer (or project) does not already
 * hold, one at a time as setConfig takes them. A key that already has the
 * value is left alone, so a resumed import writes only what an interrupted
 * one did not get to.
 */
async function writeConfigNow(setConfig, id, current, config, skip = [], skipKeys = {}) {
  for (const [ns, keys] of Object.entries(config || {})) {
    if (skip.includes(ns) || !isMap(keys)) continue;
    for (const [key, value] of Object.entries(keys)) {
      if (skipKeys[ns]?.includes(key)) continue;
      if (sameConfig(current?.[ns]?.[key], value)) continue;
      await setConfig(id, ns, key, value);
    }
  }
}

/**
 * Put back the project settings and layers the archive's `otherConfig` and
 * `otherLayers` describe. `project` is the target project as read before this
 * import wrote anything to its layers.
 *
 * A layer already in the project is used rather than made again, which is what
 * keeps a resumed import from doubling them. Setup makes only this app's own
 * layers, so any other layer in a project being imported into is one an
 * earlier run of this import made. It is recognized by where it sits and what
 * it is called: a token layer by its name, overlap mode and parent, a span
 * layer by its name on its token layer, a relation layer by its name on its
 * span layer. When the archive holds two alike, the first found goes to the
 * first described, which is the order an earlier run made them in.
 */
export async function restoreOtherLayers({
  client,
  projectId,
  project,
  manifest,
  layerIds = new Map(),
  warnings = [],
  check = () => {},
  // Called with what was found or made once every layer is there, before the
  // settings naming them are written.
  onLayers = null,
}) {
  const out = noOtherLayers();
  const described = manifest?.otherLayers || {};
  // Settings are written once every layer is made, with each archive layer id
  // in them replaced by the new layer's id: a setting may name a layer this
  // run makes after the one holding it.
  const writes = [];
  const writeConfig = (...args) => {
    writes.push(args);
  };

  // Project settings. `igt` is this app's, and `plaid.review` and
  // `plaid.research` are not archived,
  // so an archive naming either (edited by hand) does not get to write them
  // here.
  await writeConfig(
    (id, ns, key, value) => client.projects.setConfig(id, ns, key, value),
    projectId,
    project?.config,
    manifest?.otherConfig,
    [IGT_NAMESPACE],
    { [PLAID_NAMESPACE]: UNCARRIED_PLAID_KEYS.project },
  );

  const textLayer = findBaselineTextLayer(project?.textLayers || []);
  if (!textLayer) return finish();
  const tokenLayers = textLayer.tokenLayers || [];
  const ownByRole = new Map(ownTokenLayers(tokenLayers));
  const archived = manifest?.layers || {};
  if (archived.baselineText) out.ownLayers.set(archived.baselineText, textLayer.id);
  for (const [key, role] of OWN_LAYER_KEYS) {
    const layer = ownByRole.get(role);
    if (archived[key] && layer) out.ownLayers.set(archived[key], layer.id);
  }
  // What `layer` (made or found for archive row `row`) is to declare again.
  const keepRules = (kind, layer, row) => {
    if (!isMap(row?.constraints) || !Object.keys(row.constraints).length) return;
    out.rules.push({
      kind,
      layerId: layer.id,
      name: row.name ?? layer.name ?? null,
      constraints: row.constraints,
      stored: layer.constraints ?? null,
    });
  };

  const claimed = new Set();
  const claim = (candidates, matches) => {
    const found = (candidates || []).find((c) => !claimed.has(c.id) && matches(c));
    if (found) claimed.add(found.id);
    return found ?? null;
  };
  const newId = (made) => made?.id ?? made;

  const restoreRelationLayers = async (spanLayer, rows) => {
    for (const row of rows || []) {
      check();
      // name-ok: within one project, the archive's own layers (ruling C4)
      let layer = claim(spanLayer.relationLayers, (c) => c.name === row.name);
      if (!layer) {
        layer = {
          id: newId(
            await client.relationLayers.create(spanLayer.id, row.name, undefined, { id: uuidv7() }),
          ),
        };
      }
      out.relationLayers.set(row.id, layer.id);
      keepRules('relation', layer, row);
      await writeConfig(
        (id, ns, key, value) => client.relationLayers.setConfig(id, ns, key, value),
        layer.id,
        layer.config,
        row.config,
      );
    }
  };

  // What other namespaces this app's own text and token layers hold.
  for (const [role, config] of Object.entries(described.config || {})) {
    check();
    const isText = role === ROLES.BASELINE;
    const layer = isText ? textLayer : ownByRole.get(role);
    if (!layer) {
      warnings.push(
        `Another app's settings for ${roleNoun(role)} skipped (the project is not set up for ${roleNoun(role)})`,
      );
      continue;
    }
    const setConfig = isText
      ? (id, ns, key, value) => client.textLayers.setConfig(id, ns, key, value)
      : (id, ns, key, value) => client.tokenLayers.setConfig(id, ns, key, value);
    await writeConfig(setConfig, layer.id, layer.config, config, [IGT_NAMESPACE], {
      [PLAID_NAMESPACE]: UNCARRIED_PLAID_KEYS.layer,
    });
  }
  for (const [role, constraints] of Object.entries(described.constraints || {})) {
    const layer = ownByRole.get(role);
    if (layer) keepRules('token', layer, { name: layer.name, constraints });
  }

  // Span layers on this app's own token layers: a field setup already made,
  // or one no field is, made here on the token layer it sat on.
  for (const row of described.spanLayers || []) {
    check();
    const host = ownByRole.get(row.tokenLayer);
    let layer = null;
    if (host && row.scope) {
      layer = (host.spanLayers || []).find(
        // name-ok: within one project, the archive's own layers (ruling C4)
        (sl) => readScope(sl.config) === row.scope && sl.name === row.name,
      );
    } else if (host) {
      // name-ok: within one project, the archive's own layers (ruling C4)
      layer = claim(host.spanLayers, (c) => !readScope(c.config) && c.name === row.name);
      if (!layer) {
        layer = {
          id: newId(await client.spanLayers.create(host.id, row.name, undefined, { id: uuidv7() })),
        };
      }
    }
    if (!layer) {
      const missing = host
        ? `no ${row.scope} field of that name`
        : `the project is not set up for ${roleNoun(row.tokenLayer)}`;
      warnings.push(`Another app's annotations "${row.name}" skipped (${missing})`);
      continue;
    }
    out.spanLayers.set(row.id, layer.id);
    keepRules('span', layer, row);
    await writeConfig(
      (id, ns, key, value) => client.spanLayers.setConfig(id, ns, key, value),
      layer.id,
      layer.config,
      row.config,
      [IGT_NAMESPACE],
    );
    await restoreRelationLayers(layer, row.relationLayers);
  }

  // Token layers this app does not own, parents first. A project read leaves
  // out a token layer's overlap mode and parent, so the layers an earlier run
  // made are read one at a time to be recognized, and only on a resume, when
  // there are any.
  const rows = parentsFirst(described.tokenLayers || [], (row) => row.parent?.id ?? null);
  const candidates = [];
  if (rows.length) {
    for (const tl of otherTokenLayers(tokenLayers)) {
      const shape = tl.overlapMode === undefined ? await client.tokenLayers.get(tl.id) : tl;
      candidates.push({
        ...tl,
        overlapMode: shape?.overlapMode ?? null,
        parentTokenLayer: shape?.parentTokenLayer ?? null,
      });
    }
  }
  for (const row of rows) {
    check();
    let parentId = null;
    if (row.parent?.role) parentId = ownByRole.get(row.parent.role)?.id ?? null;
    else if (row.parent?.id) parentId = out.tokenLayers.get(row.parent.id)?.id ?? null;
    if (row.parent && !parentId) {
      warnings.push(`Another app's annotations "${row.name}" skipped (${NOT_DESCRIBED})`);
      continue;
    }
    const overlapMode = row.overlapMode ?? 'any';
    let layer = claim(
      candidates,
      (c) =>
        // name-ok: within one project, the archive's own layers (ruling C4)
        c.name === row.name &&
        (c.overlapMode ?? 'any') === overlapMode &&
        (c.parentTokenLayer ?? null) === parentId,
    );
    if (!layer) {
      layer = {
        id: newId(
          await client.tokenLayers.create(
            textLayer.id,
            row.name,
            overlapMode,
            parentId ?? undefined,
            undefined,
            { id: uuidv7() },
          ),
        ),
      };
    }
    out.tokenLayers.set(row.id, { id: layer.id, overlapMode });
    out.order.push(row.id);
    keepRules('token', layer, row);
    await writeConfig(
      (id, ns, key, value) => client.tokenLayers.setConfig(id, ns, key, value),
      layer.id,
      layer.config,
      row.config,
    );
    for (const spanRow of row.spanLayers || []) {
      check();
      // name-ok: within one project, the archive's own layers (ruling C4)
      let spanLayer = claim(layer.spanLayers, (c) => c.name === spanRow.name);
      if (!spanLayer) {
        spanLayer = {
          id: newId(
            await client.spanLayers.create(layer.id, spanRow.name, undefined, { id: uuidv7() }),
          ),
        };
      }
      out.spanLayers.set(spanRow.id, spanLayer.id);
      keepRules('span', spanLayer, spanRow);
      await writeConfig(
        (id, ns, key, value) => client.spanLayers.setConfig(id, ns, key, value),
        spanLayer.id,
        spanLayer.config,
        spanRow.config,
      );
      await restoreRelationLayers(spanLayer, spanRow.relationLayers);
    }
  }
  return finish();

  async function finish() {
    out.ids = new Map([...layerIds, ...restoredIds(out)]);
    await onLayers?.(out);
    for (const [setConfig, id, current, config, ...rest] of writes) {
      check();
      await writeConfigNow(setConfig, id, current, remapIds(config, out.ids), ...rest);
    }
    return out;
  }
}

// Archive layer id -> new id for every layer `restoreOtherLayers` made or found.
const restoredIds = (restored) => {
  const ids = new Map(restored.ownLayers);
  restored.tokenLayers.forEach((layer, archiveId) => ids.set(archiveId, layer.id));
  restored.spanLayers.forEach((id, archiveId) => ids.set(archiveId, id));
  restored.relationLayers.forEach((id, archiveId) => ids.set(archiveId, id));
  return ids;
};

// The pattern matching every id of one id map, made once per map.
const idPatterns = new WeakMap();

/**
 * `value` with every occurrence of an archive layer id in `ids`, in any string
 * at any depth, replaced by the id of the layer made or found for it: a setting
 * or a rule may name a layer by id, alone or inside a longer string
 * ("layer:<id>"). Layer ids are UUIDs, so no other text matches one.
 */
export const remapIds = (value, ids) => {
  if (Array.isArray(value)) return value.map((v) => remapIds(v, ids));
  if (isMap(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapIds(v, ids)]));
  }
  if (typeof value !== 'string' || !value) return value;
  // One pass, longest id first, so a replacement is never matched again. An
  // empty id is no id: a pattern of nothing would match between every letter.
  let pattern = idPatterns.get(ids);
  if (pattern === undefined) {
    const escaped = [...ids.keys()]
      .filter((id) => typeof id === 'string' && id)
      .sort((a, b) => b.length - a.length)
      .map(escapeJsRegex);
    pattern = escaped.length ? new RegExp(escaped.join('|'), 'g') : null;
    idPatterns.set(ids, pattern);
  }
  return pattern ? value.replace(pattern, (id) => ids.get(id)) : value;
};

/**
 * Once every document is in, or when an import that stopped is ended as it
 * is: the project settings `restoreOtherLayers` wrote, as the project holds
 * them, with each id of a document or a vocabulary entry the archive carries
 * replaced by what this import made for it (`ids`), as each layer id was when
 * they were written. Another app may name a document in its settings
 * (plaid-umr's import manifest does), and no document exists when those are
 * first written. A string naming a document the project does not hold
 * (`gone`, archive ids, an import that stopped before making it) is dropped,
 * as `dropReferences` drops one, and a setting left with nothing is removed.
 * Writes only what differs, so a resume or a second call writes nothing.
 * Returns how many references it dropped.
 */
export async function relinkOtherSettings({ client, projectId, ids, gone = [] }) {
  const goneIds = [...gone].filter((id) => typeof id === 'string' && id);
  if (!ids?.size && !goneIds.length) return 0;
  const project = await client.projects.get(projectId);
  const goneRe = goneIds.length
    ? new RegExp(
        [...goneIds]
          .sort((a, b) => b.length - a.length)
          .map(escapeJsRegex)
          .join('|'),
      )
    : null;
  const skipped = UNCARRIED_PLAID_KEYS.project;
  const changed = {};
  const removed = [];
  let dropped = 0;
  for (const [ns, keys] of Object.entries(project?.config || {})) {
    if (ns === IGT_NAMESPACE || !isMap(keys)) continue;
    for (const [key, value] of Object.entries(keys)) {
      if (ns === PLAID_NAMESPACE && skipped.includes(key)) continue;
      let next = ids?.size ? remapIds(value, ids) : value;
      if (goneRe) {
        const r = dropReferences(next, (str) => goneRe.test(str));
        dropped += r.count;
        next = r.value;
      }
      if (next === undefined) removed.push([ns, key]);
      else if (!sameConfig(value, next)) (changed[ns] ||= {})[key] = next;
    }
  }
  await writeConfigNow(
    (id, ns, key, value) => client.projects.setConfig(id, ns, key, value),
    projectId,
    project?.config,
    changed,
    [IGT_NAMESPACE],
    { [PLAID_NAMESPACE]: skipped },
  );
  for (const [ns, key] of removed) await client.projects.deleteConfig(projectId, ns, key);
  return dropped;
}

/**
 * Declare again the layer rules the archive carries for the layers
 * `restoreOtherLayers` made or found, once every document is in, so the
 * import is never refused by them partway. A rule naming a layer by its
 * archive id names the layer made for it. Rules the stored data still breaks
 * are left out and named in a warning, as are rules the server refuses. A
 * layer that holds them already (a resumed import) is left alone. Returns how
 * many layers' declarations failed.
 */
export async function declareOtherLayerRules({ client, restored, warnings = [] }) {
  if (!restored?.rules?.length) return 0;
  let failed = 0;
  const ids = restored.ids ?? restoredIds(restored);
  for (const r of restored.rules) {
    const wanted = Object.entries(r.constraints)
      .filter(([, list]) => Array.isArray(list) && list.length)
      .map(([namespace, list]) => ({
        kind: r.kind,
        layerId: r.layerId,
        namespace,
        constraints: remapIds(list, ids),
        stored: r.stored?.[namespace] ?? null,
      }));
    try {
      const { pending } = await ensureLayerConstraints(client, wanted, { canManage: true });
      for (const p of pending) {
        warnings.push(
          `Another app's rules for "${r.name}" are not in force (${countOf(p.violationCount, 'annotation breaks', 'annotations break')} them)`,
        );
      }
    } catch (err) {
      warnings.push(`Another app's rules for "${r.name}" were not set: ${humanizeError(err)}`);
      failed += 1;
    }
  }
  return failed;
}

/**
 * Put back one document's share of other apps' layers: its tokens, then the
 * spans on them, then every relation. Old ids map onto new through the same
 * maps this app's own tokens and annotations went into, so a relation between
 * two of this app's annotations resolves, and so does a comment on anything
 * made here. What cannot be placed is counted in a warning per layer rather
 * than guessed at.
 */
export async function importOtherLayerData({
  client,
  docData,
  textId,
  restored,
  tokenIdMap,
  spanIdMap,
  relationIdMap,
  // What rewrites references in metadata (./references.js). Without it,
  // metadata goes as it is.
  refs = { create: async (_kind, specs, send) => (await send(withMintedIds(specs))) ?? [] },
  warnings = [],
  check = () => {},
}) {
  const data = docData.otherLayers;
  if (!data) return;
  const name = docData.name;
  const withMetadata = (spec, metadata) =>
    isMap(metadata) && Object.keys(metadata).length ? { ...spec, metadata } : spec;

  // Tokens, parents first, since a nested token has to fall inside one of its
  // parent's. That is the order the layers were made in, whatever order the
  // file lists them in. A partitioning layer takes its whole partition in one
  // request, because the server checks that one request covers the text.
  const rank = (entry) => {
    const at = restored.order.indexOf(entry.layer);
    return at < 0 ? Infinity : at;
  };
  for (const { layer: oldLayerId, tokens: rows } of [...(data.tokens || [])].sort(
    (a, b) => rank(a) - rank(b),
  )) {
    if (!rows?.length) continue;
    const layer = restored.tokenLayers.get(oldLayerId);
    if (!layer) {
      warnings.push(
        `"${name}": ${countOf(rows.length, 'token')} from another app skipped (${NOT_DESCRIBED})`,
      );
      continue;
    }
    const specs = rows.map((t) =>
      withMetadata(
        {
          tokenLayerId: layer.id,
          text: textId,
          begin: t.begin,
          end: t.end,
          ...(t.precedence != null ? { precedence: t.precedence } : {}),
        },
        t.metadata,
      ),
    );
    const send = (chunk) => client.tokens.bulkCreate(chunk);
    const ids = await refs.create('token', specs, async (sent) =>
      layer.overlapMode === 'partitioning'
        ? createdIds(await send(sent))
        : bulkInChunks(sent, check, send),
    );
    rows.forEach((t, i) => {
      if (t.id != null && ids[i]) tokenIdMap.set(t.id, ids[i]);
    });
  }

  // Spans, a layer at a time as the bulk endpoint takes them.
  for (const { layer: oldLayerId, spans: rows } of data.spans || []) {
    if (!rows?.length) continue;
    const spanLayerId = restored.spanLayers.get(oldLayerId);
    if (!spanLayerId) {
      warnings.push(
        `"${name}": ${countOf(rows.length, 'annotation')} from another app skipped (${NOT_DESCRIBED})`,
      );
      continue;
    }
    const kept = [];
    const specs = [];
    for (const s of rows) {
      const tokenIds = (s.tokens || []).map((t) => tokenIdMap.get(t));
      if (!tokenIds.length || tokenIds.some((t) => !t)) continue;
      kept.push(s);
      specs.push(
        withMetadata({ spanLayerId, tokens: tokenIds, value: s.value ?? null }, s.metadata),
      );
    }
    if (kept.length < rows.length) {
      warnings.push(
        `"${name}": ${countOf(rows.length - kept.length, 'annotation')} from another app skipped (unresolvable tokens)`,
      );
    }
    const ids = await refs.create('span', specs, (sent) =>
      bulkInChunks(sent, check, (chunk) => client.spans.bulkCreate(chunk)),
    );
    kept.forEach((s, i) => {
      if (s.id != null && ids[i]) spanIdMap.set(s.id, ids[i]);
    });
  }

  // Relations last, since either end may be a span made just above or one of
  // this app's own annotations.
  for (const { layer: oldLayerId, relations: rows } of data.relations || []) {
    if (!rows?.length) continue;
    const relationLayerId = restored.relationLayers.get(oldLayerId);
    if (!relationLayerId) {
      warnings.push(
        `"${name}": ${countOf(rows.length, 'relation')} from another app skipped (${NOT_DESCRIBED})`,
      );
      continue;
    }
    const kept = [];
    const specs = [];
    for (const r of rows) {
      const source = spanIdMap.get(r.source);
      const target = spanIdMap.get(r.target);
      if (!source || !target) continue;
      kept.push(r);
      specs.push(
        withMetadata({ relationLayerId, source, target, value: r.value ?? null }, r.metadata),
      );
    }
    if (kept.length < rows.length) {
      warnings.push(
        `"${name}": ${countOf(rows.length - kept.length, 'relation')} skipped (unresolvable annotations)`,
      );
    }
    const ids = await refs.create('relation', specs, (sent) =>
      bulkInChunks(sent, check, (chunk) => client.relations.bulkCreate(chunk)),
    );
    kept.forEach((r, i) => {
      if (r.id != null && ids[i]) relationIdMap.set(r.id, ids[i]);
    });
  }
}

/** Whether a document holds tokens of other apps' layers. */
export const hasOtherTokens = (docData) =>
  (docData.otherLayers?.tokens || []).some((entry) => entry.tokens?.length);
