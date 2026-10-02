// What of a project belongs to some other Plaid app, for the native archive.
//
// Several Plaid apps can share one project. Each finds the shared layers by
// their role (config.plaid.role) and keeps its own layers and settings under
// its own config namespace. This app owns the baseline text layer, the four
// role-tagged token layers on it, and the annotation fields on those. It knows
// nothing about any other app, and does not need to: whatever else a project
// holds is plain Plaid data (layers, config, tokens, spans, relations), which
// an archive can carry as it is without asking whose it is.

import { PLAID_NAMESPACE, REVIEW_KEY, ROLE_KEY, ROLES } from '@larc-iu/plaid-client';
import {
  findAlignmentTokenLayer,
  findMorphemeTokenLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
} from './igtConfig.js';

/** This app's own token layers among `tokenLayers`, as [role, layer] pairs. */
export const ownTokenLayers = (tokenLayers) =>
  [
    [ROLES.SENTENCE, findSentenceTokenLayer(tokenLayers || [])],
    [ROLES.WORD, findWordTokenLayer(tokenLayers || [])],
    [ROLES.MORPHEME, findMorphemeTokenLayer(tokenLayers || [])],
    [ROLES.TIME_ALIGNMENT, findAlignmentTokenLayer(tokenLayers || [])],
  ].filter(([, layer]) => layer);

/**
 * The token layers among `tokenLayers` that this app does not own. A second
 * layer claiming one of the four roles is among them, since the app reads only
 * the first.
 */
export const otherTokenLayers = (tokenLayers) => {
  const own = new Set(ownTokenLayers(tokenLayers).map(([, layer]) => layer.id));
  return (tokenLayers || []).filter((tl) => !own.has(tl.id));
};

/**
 * A layer's or project's config without the namespaces in `drop`. A namespace
 * is restored one key at a time, so one that holds no keys, or is not a map of
 * them, has nothing to carry and is left out.
 */
export const configWithout = (config, drop = []) =>
  Object.fromEntries(
    Object.entries(config || {}).filter(
      ([ns, keys]) =>
        !drop.includes(ns) &&
        keys != null &&
        typeof keys === 'object' &&
        !Array.isArray(keys) &&
        Object.keys(keys).length > 0,
    ),
  );

/**
 * The keys of the shared `plaid` namespace the native archive leaves out, on
 * the project and on this app's own layers. Whose work is reviewed names
 * people, so it goes with permissions. A layer's role is what setup finds this
 * app's layers by, and setup writes it. Everything else under `plaid` (the
 * tartan, the research opt-in, a word layer's splitOnSpace and
 * preserveOnSplit) is the project's own and goes with it.
 */
export const UNCARRIED_PLAID_KEYS = { project: [REVIEW_KEY], layer: [ROLE_KEY] };

/** `config` without the `plaid` keys in `keys`. */
export const withoutPlaidKeys = (config, keys) => {
  const plaid = config?.[PLAID_NAMESPACE];
  if (plaid == null || typeof plaid !== 'object' || Array.isArray(plaid)) return config || {};
  const kept = Object.fromEntries(Object.entries(plaid).filter(([k]) => !keys.includes(k)));
  return { ...config, [PLAID_NAMESPACE]: kept };
};

/**
 * `layers` reordered so that each comes after the layer it is nested in, which
 * is the order they can be made in. `parentOf(layer)` is the id of its parent
 * when that parent is in the list, and anything else otherwise. A layer whose
 * parent never gets placed goes last rather than being lost.
 */
export function parentsFirst(layers, parentOf) {
  const ids = new Set(layers.map((l) => l.id));
  const placed = new Set();
  const out = [];
  let rest = [...layers];
  while (rest.length) {
    const ready = rest.filter((l) => {
      const parent = parentOf(l);
      return parent == null || !ids.has(parent) || placed.has(parent);
    });
    if (!ready.length) {
      out.push(...rest);
      break;
    }
    for (const l of ready) {
      out.push(l);
      placed.add(l.id);
    }
    rest = rest.filter((l) => !placed.has(l.id));
  }
  return out;
}
