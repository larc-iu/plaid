// The History labels of Bulk Edit (Respell, a field's Replace or Clear) and of
// a vocabulary's Replace. Saved plain: History draws each value in a <bdi>
// where it shows it (plaid-ui IsolatedLabel), and nothing invisible is stored
// (REV-G4-R2-2).

export const respellLabel = (find, repl) => `Respell “${find}” → “${repl}”`;

// An empty `repl` clears.
export const fieldApplyLabel = (find, repl, target) =>
  repl === '' ? `Clear “${find}” in ${target}` : `Replace “${find}” → “${repl}” in ${target}`;

export const replaceLabel = ({ filling, find, repl, field, vocabularyName }) =>
  filling
    ? `Set ${field} to “${repl}” where empty in ${vocabularyName || 'vocabulary'}`
    : `Replace “${find}” → “${repl}” in ${field} of ${vocabularyName || 'vocabulary'}`;
