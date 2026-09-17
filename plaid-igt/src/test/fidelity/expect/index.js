// A round trip's expected result, built from the format's loss list.
//
// The source snapshot is edited into what the list says an import gives back:
// every lost feature is taken out (./strips.js, or the format's own override),
// every undecided feature is taken out of both sides so that neither answer
// fails, and every changed feature is applied by the format module's steps.
// The import's bookkeeping (the list's `stamps`) is removed from both sides.
// Both sides are then finalized (./snap.js), so a key moved by any of this is
// recomputed the same way on each.
//
// What is left different between the two is a failure: either the format does
// not do what its list says, or the list or this module says it wrong.

import { FEATURE_KEYS } from '../catalog.js';
import { clone } from '../compare.js';
import { finalize } from './snap.js';
import { STRIPS } from './strips.js';
import cldf from './cldf.js';
import elan from './elan.js';
import native from './native.js';

export const MODULES = { native, cldf, elan };

function stripStamps(s, stamps = {}) {
  delete s.name;
  const cfg = s.config?.igt;
  for (const k of stamps.projectConfig || []) if (cfg) delete cfg[k];
  for (const d of s.documents || []) {
    for (const k of stamps.documentMetadata || []) delete d.metadata[k];
    for (const t of d.tokens) for (const k of stamps.tokenMetadata || []) delete t.metadata[k];
  }
  for (const v of s.vocabularies || []) {
    for (const it of v.items) for (const k of stamps.itemMetadata || []) delete it.metadata[k];
  }
}

/** The strip a format uses for a key: its own override, else the shared one. */
const stripFor = (module, key) => module.strips?.[key] ?? STRIPS[key];

/**
 * @param list    the format's loss list (./formats/<id>.js)
 * @param source  the snapshot of the project that was exported
 * @param actual  the snapshot of the project the import made
 * @param bare    a snapshot of a project with nothing but setup, for the
 *                shapes setup gives a new project
 * @returns {{expected, actual}} both finalized and ready to diff
 */
export function expectRoundTrip({ list, source, actual, bare = null }) {
  const module = MODULES[list.id];
  if (!module) throw new Error(`no round-trip expectation for ${list.id}`);
  const expected = clone(source);
  const got = clone(actual);
  stripStamps(expected, list.stamps);
  stripStamps(got, list.stamps);
  const ctx = { source: clone(source), bare, list };

  for (const key of FEATURE_KEYS) {
    const entry = list.features[key];
    if (entry.carried !== false) continue;
    const strip = stripFor(module, key);
    if (typeof strip !== 'function') continue; // coveredBy another key
    strip(expected, ctx);
    if (entry.kind === 'undecided') strip(got, ctx);
  }
  for (const step of module.steps || []) step.apply(expected, got, ctx);
  // A span's `order` is what steps read to find the first annotation on a
  // token. It is not compared: an import's own order is checked by the second
  // export, where it shows.
  for (const d of [...(expected.documents || []), ...(got.documents || [])]) {
    for (const sp of d.spans) delete sp.order;
  }
  return { expected: finalize(expected), actual: finalize(got) };
}

/**
 * What is missing for a format module to answer its loss list: a lost key with
 * no strip, a covered key whose cover the format carries, a changed key no step
 * applies or two steps apply, a step claiming a key the list does not call
 * changed. Empty when the module is complete.
 */
export function moduleGaps(list) {
  const module = MODULES[list.id];
  if (!module) return [`${list.id}: no module`];
  const gaps = [];
  const stepKeys = (module.steps || []).flatMap((s) => s.keys);
  for (const key of FEATURE_KEYS) {
    const entry = list.features[key];
    if (entry.carried === false) {
      const strip = stripFor(module, key);
      if (typeof strip === 'function') continue;
      if (!strip?.coveredBy) gaps.push(`${key}: lost, and nothing strips it`);
      else if (list.features[strip.coveredBy]?.carried === true) {
        gaps.push(`${key}: covered by ${strip.coveredBy}, which ${list.id} carries unchanged`);
      }
    }
    const n = stepKeys.filter((k) => k === key).length;
    if (entry.carried === 'changed' && n !== 1) gaps.push(`${key}: changed, applied by ${n} steps`);
    if (entry.carried !== 'changed' && n > 0)
      gaps.push(`${key}: a step applies it, but it is not changed`);
  }
  return gaps;
}
