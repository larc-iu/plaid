// What of a project belongs to some other Plaid app, for the native archive.
//
// Several Plaid apps can share one project. Each finds the shared layers by
// their role (config.plaid.role) and keeps its own layers and settings under
// its own config namespace. This app owns the baseline text layer, the four
// role-tagged token layers on it, and the annotation fields on those. It knows
// nothing about any other app, and does not need to: whatever else a project
// holds is plain Plaid data (layers, config, tokens, spans, relations), which
// an archive can carry as it is without asking whose it is.

import { ROLES } from '@larc-iu/plaid-client';
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
