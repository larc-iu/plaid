// Whether a project is set up for plaid-umr, from its layer structure alone.
//
// The same rule, and the same reason for living here, as `udProject.js`: this
// is a FRONTEND question about one app's private config namespace, so it does
// not belong in the API client, and the caller is another app. plaid-igt's
// admin area lists everyone's projects and has to say which app owns each,
// and to send a project's name to the app that owns it rather than into its
// own setup wizard.
//
// The ROLE alone cannot answer it: plaid-umr builds on whatever substrate is
// there, IGT's or UD's. What is distinctive is the node token layer it hangs
// off the text layer, flagged `config.umr.nodes` (see plaid-umr's
// `umrLayerUtils.js`), which no other app writes.

/**
 * @param {object} [project] a project WITH its layers (`client.projects.get`),
 *   which is what an admin project listing already returns.
 * @returns {boolean}
 */
export const isUmrProject = (project) => {
  for (const text of project?.textLayers || []) {
    for (const token of text?.tokenLayers || []) {
      if (token?.config?.umr?.nodes === true) return true;
    }
  }
  return false;
};
