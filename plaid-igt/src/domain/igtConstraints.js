// The layer rules IGT declares on the layers it owns (plaid-core's layer
// constraints), and the few places it reads them back.
//
// The server holds the rules and applies them inside every write, whoever
// writes: a word merged in another app joins IGT's doubled annotations and
// drops the extra vocabulary link in the merge's own transaction, a morpheme
// left without a word of its extent is deleted with the text save that did
// it, and a value outside a closed tagset is refused. What IGT used to heal
// on open, and the second batch its own merge used to send, are gone.

// Relative imports only: project setup (executeSetup.js) runs this from plain
// node too.
import { uuidv7 } from '@larc-iu/plaid-client';
import { IGT_NAMESPACE, LEXICON_FIELD_KEY } from './igtConfig.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { findDoubles } from './doubles.js';
import { MODES, readTagsetName, resolveTagset } from './tagsets.js';
import {
  valueSetAllows,
  violationCountOf,
  violationsOf,
} from '../../../plaid-client-js/src/constraints.js';
import {
  ensureLayerConstraints,
  sameConstraints,
  storedConstraints,
} from '../../../plaid-ui/src/lib/layerConstraints.js';

const tokenEntry = (layer, constraints) => ({
  kind: 'token',
  layerId: layer.id,
  namespace: IGT_NAMESPACE,
  constraints,
  stored: storedConstraints(layer, IGT_NAMESPACE),
});

/**
 * The rules for one field: one span per token, and when its tagset is closed,
 * a value made only of listed tags. A `mixed` tagset's lexical parts are a
 * Leipzig reading the server does not hold, and an open one enforces nothing,
 * so neither declares a value set.
 */
export const fieldConstraints = (spanLayerConfig, projectConfig) => {
  const constraints = [{ type: 'single-span' }];
  const tagset = resolveTagset(spanLayerConfig, projectConfig);
  if (tagset?.mode === MODES.CLOSED) {
    constraints.push({
      type: 'value-set',
      values: tagset.values.map((v) => v.value),
      delimiters: tagset.delimiters,
      parts: 'all',
    });
  }
  return constraints;
};

/** The rules on the morpheme layer: as wide as a word, one vocabulary link. */
export const morphemeLayerConstraints = () => [{ type: 'coextensive' }, { type: 'single-link' }];

/** The rules on the word layer: one vocabulary link. */
export const wordLayerConstraints = () => [{ type: 'single-link' }];

/**
 * Queue on batch `b` a new field's span layer under `parentLayerId`, with its
 * scope, its language when `field.lang` says one, its Lexicon field when
 * `field.lexiconField` names one, and its rules. The layer is
 * new and empty, so no data can refuse the rules, and since they go in the
 * batch that makes it, no failure after it leaves the field without them.
 * Returns the new layer's id.
 */
export const queueNewField = (b, parentLayerId, field, projectConfig) => {
  const id = uuidv7();
  b.spanLayers.create(parentLayerId, field.name, undefined, { id });
  b.spanLayers.setConfig(id, IGT_NAMESPACE, 'scope', field.scope);
  if (field.lang) b.spanLayers.setConfig(id, IGT_NAMESPACE, 'lang', field.lang);
  if (field.lexiconField) {
    b.spanLayers.setConfig(id, IGT_NAMESPACE, LEXICON_FIELD_KEY, field.lexiconField);
  }
  b.spanLayers.setConstraints(
    id,
    IGT_NAMESPACE,
    fieldConstraints({ [IGT_NAMESPACE]: { scope: field.scope } }, projectConfig),
    undefined,
    { expected: null },
  );
  return id;
};

/**
 * Every rule IGT wants on this project's layers, as `ensureLayerConstraints`
 * takes them (plaid-ui/src/lib/layerConstraints.js):
 *
 *   morpheme layer        coextensive, single-link
 *   word layer            single-link (IGT's, the layer is shared)
 *   each IGT field        single-span, plus value-set when its tagset is closed
 *
 * A field naming a tagset the project does not have wants no list, as a
 * field with no tagset: a list it holds is taken off.
 *
 * Lists are in a fixed order (by type, values in the tagset's order), so an
 * unchanged project compares equal and writes nothing.
 */
export const wantedConstraints = (layerInfo, projectConfig) => {
  const out = [];
  if (layerInfo?.morphemeTokenLayer?.id) {
    out.push(tokenEntry(layerInfo.morphemeTokenLayer, morphemeLayerConstraints()));
  }
  if (layerInfo?.primaryTokenLayer?.id) {
    out.push(tokenEntry(layerInfo.primaryTokenLayer, wordLayerConstraints()));
  }
  for (const scope of ['word', 'morpheme', 'sentence']) {
    for (const sl of layerInfo?.spanLayers?.[scope] || []) {
      if (!sl?.id) continue;
      out.push({
        kind: 'span',
        layerId: sl.id,
        namespace: IGT_NAMESPACE,
        constraints: fieldConstraints(sl.config, projectConfig),
        stored: storedConstraints(sl, IGT_NAMESPACE),
      });
    }
  }
  return out;
};

/**
 * Whether a settings save changes the rules of field `sl`: its rules under
 * `projectConfig` (the project's config after the save) differ from its rules
 * under `previousConfig` (the config as stored), the field read with its
 * config after the save (`sl.config`) and before it (`sl.configBefore`, else
 * the same). A field the save makes (`sl.constraints === null`) always
 * changes.
 */
const rulesChange = (sl, projectConfig, previousConfig) => {
  if (previousConfig === undefined) {
    throw new Error('The project config before the save is required');
  }
  const wanted = fieldConstraints(sl.config, projectConfig);
  if (sl.constraints === null) return wanted;
  const before = fieldConstraints(sl.configBefore ?? sl.config, previousConfig);
  return sameConstraints(wanted, before) ? null : wanted;
};

/**
 * The rules a settings save declares on field `sl` in its own batch: those
 * of `rulesChange`, for a field whose layer holds what its settings asked
 * for before the save (in force). A field out of force before the save (a
 * closed list the stored values break, rules another client left) is not
 * declared or asked about here: the save goes through and the heal after it
 * (`declareIgtRules`) declares what the values allow and names the rest.
 */
const savedRules = (sl, projectConfig, previousConfig) => {
  const wanted = rulesChange(sl, projectConfig, previousConfig);
  if (!wanted || sl.constraints === null) return wanted;
  const before = fieldConstraints(sl.configBefore ?? sl.config, previousConfig);
  return sameConstraints(storedConstraints(sl, IGT_NAMESPACE), before) ? wanted : null;
};

/**
 * The ids of the fields in `spanLayers` (as `queueFieldDeclarations` takes
 * them) whose rules a settings save changes, in force or not: what the
 * save's effect on the rules is, for a heal made on its behalf.
 */
export const fieldsChangedBySave = (spanLayers, projectConfig, previousConfig) =>
  (spanLayers || [])
    .filter((sl) => sl?.id && rulesChange(sl, projectConfig, previousConfig))
    .map((sl) => sl.id);

/**
 * Queue on batch `b` the declarations a settings save changes: every field
 * in `spanLayers` ({id, name, config, configBefore?, constraints}, each config
 * as it will be after the save) whose rules the save changes and that was in
 * force (`savedRules`, `projectConfig` after the save and `previousConfig` as
 * stored), and whose layer does not already hold them. The declaration goes
 * in the same batch as the settings write, so a list in force that the
 * stored values break is refused with them and stays as it was. Nothing is
 * repaired: a field in force already holds one annotation a unit, and a
 * field the save makes holds none. Returns how many declarations it queued.
 */
export const queueFieldDeclarations = (b, spanLayers, projectConfig, previousConfig) => {
  let n = 0;
  for (const sl of spanLayers || []) {
    if (!sl?.id) continue;
    const wanted = savedRules(sl, projectConfig, previousConfig);
    if (!wanted) continue;
    const stored = storedConstraints(sl, IGT_NAMESPACE);
    if (sameConstraints(wanted, stored)) continue;
    b.spanLayers.setConstraints(sl.id, IGT_NAMESPACE, wanted, undefined, {
      expected: stored ?? null,
    });
    n += 1;
  }
  return n;
};

/**
 * What a settings save would have the server refuse: for every field the
 * save declares a closed list on (as `queueFieldDeclarations` takes them),
 * the server's answer to which stored values that list refuses
 * (`refusedValues`, with its exemptions), kept when it refuses any. Asked
 * before the save, so the screen can say what is in the way instead of only
 * reading the refusal. A field the save leaves alone, or one out of force
 * before it, is not asked about.
 * Returns `[{layerId, field, count, valueCount, values: [{value, parts, count}]}]`.
 */
export const refusedBySave = async (
  client,
  spanLayers,
  projectConfig,
  previousConfig,
  limit = 5,
) => {
  const asks = [];
  for (const sl of spanLayers || []) {
    if (!sl?.id) continue;
    const wanted = savedRules(sl, projectConfig, previousConfig);
    if (!wanted || sameConstraints(wanted, storedConstraints(sl, IGT_NAMESPACE))) continue;
    const rule = wanted.find((c) => c.type === 'value-set');
    if (!rule) continue;
    asks.push(
      client.spanLayers
        .refusedValues(sl.id, rule, { limit })
        .then((r) => ({ layerId: sl.id, field: sl.name, ...r })),
    );
  }
  return (await Promise.all(asks)).filter((r) => r.count > 0);
};

/** Every IGT field of a layer info, as `queueFieldDeclarations` takes them. */
export const igtFields = (layerInfo) => Object.values(layerInfo?.spanLayers || {}).flat();

// How many units a field left out of force for `fixable` (its rules with a
// remedy) holds more than one annotation on, as Validation counts them. Core's
// own count when they cannot be read.
const reachableCount = async (client, p, fixable) => {
  const core = p.repair?.length ? (p.repairCount ?? 0) : (p.violationCount ?? 0);
  if (!fixable.includes('single-span')) return core;
  try {
    const { count, hidden } = await findDoubles(client, p.layerId, { limit: 0 });
    // None found now (a double written after the declaration was refused,
    // and gone since): what core counted.
    return count || hidden ? count : core;
  } catch (err) {
    console.warn('Could not count the doubled annotations:', err);
    return core;
  }
};

/**
 * Put IGT's rules in force on project `projectId` as it now stands, read
 * here: every rule its settings want (`wantedConstraints`) that its layers do
 * not hold, declared through `ensureLayerConstraints`. With `fieldsOnly`,
 * only the fields' rules (what a settings save governs), else the word and
 * morpheme layers' too (what setup and an import declare). With `layers`
 * (a test of a layer id), only the layers it passes.
 *
 * This is the one place a stored rule is brought back to the settings, so
 * every path that leaves the settings and the server apart calls it: setup,
 * the end of an import or a resume, "Use the project as it is", and after
 * every tagset or field save (which also heals a field another maintainer's
 * save, a script or an unfinished import left behind).
 *
 * A closed list the stored values break (`refusedValues`, with its
 * exemptions) is not declared, and a list the field already holds stays, so
 * nothing is enforced less than before. Each such field is returned in
 * `notInForce` as `{layerId, field, tagset, count, valueCount, values}`, and
 * so is any other rule the server still refuses (`values` empty). With
 * `repair: false` (every heal but setup's and an import's) no annotation is
 * changed: a rule the data breaks is left out even where the server could
 * repair it, and its field is named with `repair` (the rule types),
 * `repairCount` (the units holding more than one annotation that Analyze
 * shows, `findDoubles`) and `scope` (Word, Morpheme or Sentence). Returns
 * `{changed, notInForce}`.
 */
export const declareIgtRules = async (
  client,
  projectId,
  { fieldsOnly = false, repair = true, layers = null, limit = 5 } = {},
) => {
  const project = await client.projects.get(projectId);
  const info = getIgtLayerInfo(project);
  const wanted = wantedConstraints(info, project?.config).filter(
    (e) =>
      (!fieldsOnly || e.kind === 'span') &&
      (!layers || layers(e.layerId)) &&
      !sameConstraints(e.stored, e.constraints),
  );
  if (!wanted.length) return { changed: false, notInForce: [] };
  const fields = new Map(igtFields(info).map((sl) => [sl.id, sl]));
  const names = new Map();
  for (const tl of (project?.textLayers || []).flatMap((t) => t.tokenLayers || [])) {
    names.set(tl.id, tl.name);
    for (const sl of tl.spanLayers || []) names.set(sl.id, sl.name);
  }
  const notInForce = [];
  const entries = await Promise.all(
    wanted.map(async (e) => {
      const rule = e.constraints.find((c) => c.type === 'value-set');
      const held = (e.stored || []).filter((c) => c.type === 'value-set');
      if (!rule || held.some((c) => sameConstraints([c], [rule]))) return e;
      const answer = await client.spanLayers.refusedValues(e.layerId, rule, { limit });
      if (!(answer?.count > 0)) return e;
      notInForce.push({
        layerId: e.layerId,
        field: names.get(e.layerId) ?? e.layerId,
        tagset: readTagsetName(fields.get(e.layerId)?.config),
        ...answer,
      });
      return {
        ...e,
        constraints: [...e.constraints.filter((c) => c.type !== 'value-set'), ...held],
      };
    }),
  );
  const { changed, pending } = await ensureLayerConstraints(client, entries, {
    canManage: true,
    repair,
  });
  for (const p of pending) {
    const named = notInForce.find((n) => n.layerId === p.layerId);
    // A rule with a remedy the declaration itself was refused for (a double
    // written after the check) needs the same as one the check found.
    const refusedFixable = repair ? [] : (p.constraints || []).filter((t) => t === 'single-span');
    const fixable = p.repair?.length ? p.repair : refusedFixable;
    // Units on tokens Analyze shows no fields for are not counted
    // (`findDoubles`), as Validation counts them.
    const needs = fixable.length
      ? {
          repair: fixable,
          repairCount: await reachableCount(client, p, fixable),
          scope: fields.get(p.layerId)?.config?.[IGT_NAMESPACE]?.scope ?? null,
        }
      : {};
    if (named) {
      // Its list is named already: what else the data breaks goes with it.
      Object.assign(named, needs);
      continue;
    }
    notInForce.push({
      layerId: p.layerId,
      field: names.get(p.layerId) ?? p.layerId,
      tagset: readTagsetName(fields.get(p.layerId)?.config),
      count: p.violationCount ?? 0,
      valueCount: 0,
      values: [],
      ...needs,
    });
  }
  return { changed, notInForce };
};

/**
 * The fields whose rules on the server differ from what their settings want,
 * read off a project: `[{layerId, field, tagset, scope, closed, list, stale,
 * single}]`. `closed` when the settings want a list, `list` when that list is
 * not held as they want it, `stale` when a list is held and the settings
 * want none, `single` when one annotation a unit is wanted and not held.
 * Reads only.
 */
export const fieldsOutOfForce = (project) => {
  const info = getIgtLayerInfo(project);
  const fields = new Map(igtFields(info).map((sl) => [sl.id, sl]));
  const has = (list, type) => (list || []).some((c) => c.type === type);
  const listOf = (list) => (list || []).filter((c) => c.type === 'value-set');
  return wantedConstraints(info, project?.config)
    .filter((e) => e.kind === 'span' && !sameConstraints(e.stored, e.constraints))
    .map((e) => {
      const closed = has(e.constraints, 'value-set');
      return {
        layerId: e.layerId,
        field: fields.get(e.layerId)?.name ?? e.layerId,
        tagset: readTagsetName(fields.get(e.layerId)?.config),
        scope: fields.get(e.layerId)?.config?.[IGT_NAMESPACE]?.scope ?? null,
        closed,
        list: closed && !sameConstraints(listOf(e.stored), listOf(e.constraints)),
        stale: !closed && has(e.stored, 'value-set'),
        single: !has(e.stored, 'single-span'),
      };
    });
};

/**
 * The words for a settings save refused because stored values break the
 * tagset it would put in force, or null for any other refusal.
 */
export const tagsetRefusal = (error) => {
  const vs = violationsOf(error);
  if (!vs?.length || !vs.every((v) => v.constraint === 'value-set')) return null;
  const n = violationCountOf(error);
  const fields = [...new Set(vs.map((v) => v.layerName).filter(Boolean))];
  const values = [...new Set(vs.map((v) => v.value).filter((v) => typeof v === 'string'))];
  const shown = values.slice(0, 5).join(', ') + (values.length > 5 ? ', …' : '');
  return `${n} ${n === 1 ? 'value' : 'values'} in ${fields.join(', ')} ${n === 1 ? 'is' : 'are'} not in the tagset: ${shown}.`;
};

/**
 * Whether a layer's value-set rules (any app's) allow `value`: every part
 * listed, or only the first with `parts: 'first'`. The server's rule, read
 * the same way, for the screen's mirror of a join it makes.
 */
export const valueSetsAllow = (layer, value) =>
  Object.values(layer?.constraints || {})
    .flat()
    .filter((c) => c?.type === 'value-set')
    .every((c) => valueSetAllows(c, value));

/**
 * What the server's rules leave after a word or sentence merge, for the
 * screen to show at once: in each field of the merged unit's scope, the
 * survivor's own annotation stays (else the one with the smallest id) and
 * takes the distinct values of the others joined with " | " in text order,
 * unless its field's closed tagset would refuse the joined value, and the
 * others go. Of the single-token vocabulary links now on the survivor, its
 * own stays (else the smallest id).
 *
 * @param {object} infoNext layer info of the patched document, spans already
 *   reparented onto the survivor
 * @param {object} vocabs the patched vocabularies, links already reparented
 * @param {string} survivorId
 * @param {Map<string, number>} beginOf where each annotation's word began
 *   before the merge, by annotation id
 * @param {{spans: Set<string>, links: Set<string>}} own the survivor's own
 *   annotations and links before the merge
 * @param {'word'|'sentence'} [scope] the fields of which scope the merge
 *   gathered on the survivor
 */
export const applyMergeRules = (infoNext, vocabs, survivorId, beginOf, own, scope = 'word') => {
  const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  for (const sl of infoNext.spanLayers?.[scope] || []) {
    const onSurvivor = (sl.spans || []).filter(
      (s) => s.tokens?.length === 1 && s.tokens[0] === survivorId,
    );
    if (onSurvivor.length < 2) continue;
    const ids = onSurvivor.map((s) => s.id).sort(byId);
    const keepId = ids.find((id) => own.spans.has(id)) ?? ids[0];
    const keep = onSurvivor.find((s) => s.id === keepId);
    const others = onSurvivor
      .filter((s) => s.id !== keepId)
      .sort(
        (a, b) =>
          (beginOf.get(a.id) ?? Infinity) - (beginOf.get(b.id) ?? Infinity) || byId(a.id, b.id),
      );
    const kv = keep.value;
    let joined = kv;
    if (kv == null || typeof kv === 'string') {
      const strings = [];
      for (const v of [kv, ...others.map((s) => s.value)]) {
        if (typeof v === 'string' && v.trim() !== '' && !strings.includes(v)) strings.push(v);
      }
      if (strings.length) joined = strings.join(' | ');
    }
    if (valueSetsAllow(sl, joined)) keep.value = joined;
    const dead = new Set(others.map((s) => s.id));
    sl.spans = sl.spans.filter((s) => !dead.has(s.id));
  }
  const links = [];
  for (const vocab of Object.values(vocabs || {})) {
    for (const link of vocab.vocabLinks || []) {
      if (link.tokens?.length === 1 && link.tokens[0] === survivorId) links.push(link.id);
    }
  }
  if (links.length > 1) {
    const sorted = links.slice().sort(byId);
    const keep = sorted.find((id) => own.links.has(id)) ?? sorted[0];
    for (const vocab of Object.values(vocabs || {})) {
      if (Array.isArray(vocab.vocabLinks)) {
        vocab.vocabLinks = vocab.vocabLinks.filter(
          (l) => !(l.id !== keep && l.tokens?.length === 1 && l.tokens[0] === survivorId),
        );
      }
    }
  }
};
