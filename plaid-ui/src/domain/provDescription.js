// What an entity's provenance says about it, in the words every app's tooltip
// uses: its state, where it came from, and the producer's confidence. Each app
// keeps its own marks and classes (ud and umr draw verified material plain,
// igt keeps a quiet mark), and builds its tooltip from these.
import {
  PROV,
  PROV_STATES,
  provOrigin,
  provState,
} from '../../../plaid-client-js/src/provenance.js';
import { confidenceNote } from './confidence.js';

/** The word for an origin (`provOrigin`'s value): a machine's or a contributor's. */
export const originWord = (origin) =>
  origin === PROV.CONTRIBUTED ? 'contributed' : 'machine-made';

/**
 * `{state, origin, word, note}`: the provenance state, the origin
 * (`provOrigin`), its word ('machine-made' or 'contributed', null for a
 * person's own work), and the confidence note ("38% confident") or null.
 */
export const provDescription = (metadata) => {
  const state = provState(metadata);
  if (state === PROV_STATES.HUMAN) return { state, origin: null, word: null, note: null };
  const origin = provOrigin(metadata);
  return { state, origin, word: originWord(origin), note: confidenceNote(metadata) };
};
