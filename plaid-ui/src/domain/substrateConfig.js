// The shared substrate's own settings on its token layers, which every app's
// setup and adopt write the same way: what a token born of a split keeps, and
// that a space typed inside a word splits it (Luke 2026-10-24, R8). See the
// manual's "Metadata Preserved Across a Split" and "Changing a text's body".
//
// Each takes whatever it writes through: a batch, or the client itself.
//
// No bare imports: plaid-igt's setup runs in plain-node e2e scripts.

import {
  PLAID_NAMESPACE,
  PRESERVE_ON_SPLIT_KEY,
  SPLIT_ON_SPACE_KEY,
} from '../../../plaid-client-js/src/roles.js';
import { PROVENANCE_KEYS } from '../../../plaid-client-js/src/provenance.js';

/** Provenance survives a split, including one made by an app that has never heard of these keys. */
export const declarePreserveOnSplit = (target, layerId) =>
  target.tokenLayers.setConfig(layerId, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, [
    ...PROVENANCE_KEYS,
  ]);

/** A space typed inside a word of the word layer splits it. */
export const declareSplitOnSpace = (target, layerId) =>
  target.tokenLayers.setConfig(layerId, PLAID_NAMESPACE, SPLIT_ON_SPACE_KEY, true);

/** Whether a token layer already holds what a split keeps. */
export const preservesOnSplit = (layer) =>
  Array.isArray(layer?.config?.[PLAID_NAMESPACE]?.[PRESERVE_ON_SPLIT_KEY]);

/** Whether a word layer already splits a word at a typed space. */
export const splitsOnSpace = (layer) =>
  layer?.config?.[PLAID_NAMESPACE]?.[SPLIT_ON_SPACE_KEY] === true;
