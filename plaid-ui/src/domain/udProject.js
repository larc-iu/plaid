// Whether a project is set up for plaid-ud, from its layer structure alone.
//
// This is a FRONTEND question, so it lives here rather than in the API client.
// The client speaks the server's vocabulary: the shared layer ROLES every app
// agrees on, and nothing about what any one app writes under its own config
// namespace. A predicate that reads `config.ud` is the opposite of that, and a
// client carrying it ships one app's shape to every service and script that
// imports it.
//
// It is in the shared package rather than in plaid-ud because the caller is
// plaid-igt: its admin area lists everyone's projects and labels which app
// each belongs to. An app's own shape stays in that app (plaid-igt reads
// `config.igt.initialized` itself); a shape one app has to recognise in
// ANOTHER app's project is what this package is for.
//
// The ROLE alone cannot answer it. plaid-igt tags a morpheme layer and can
// carry syntactic-word too. What is distinctive is that plaid-ud hangs its
// annotation span layers off the syntactic-word token layer under its OWN `ud`
// namespace, which no other app writes.

import { ROLES, readRole } from '@larc-iu/plaid-client';

/**
 * @param {object} [project] a project WITH its layers (`client.projects.get`),
 *   which is what an admin project listing already returns.
 * @returns {boolean}
 */
export const isUdProject = (project) => {
  for (const text of project?.textLayers || []) {
    for (const token of text?.tokenLayers || []) {
      if (readRole(token?.config) !== ROLES.SYNTACTIC_WORD) continue;
      for (const span of token?.spanLayers || []) {
        if (span?.config?.ud && typeof span.config.ud === 'object') return true;
      }
    }
  }
  return false;
};
