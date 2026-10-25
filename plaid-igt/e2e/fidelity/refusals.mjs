// What a format refuses, by kitchen-sink project and by the half of the round
// trip that refuses it, keyed by the fidelity format id (drivers.mjs). The one
// list both runners read: roundTrip.mjs checks each refusal and nothing else
// for that project, and validate.mjs skips an export refused here and fails on
// any other refusal.
export const REFUSALS = {
  // Ruled a user error (2026-09-17): the archive import tells vocabularies
  // apart by name, and a CLDF dataset names one by its name alone.
  twins: {
    native: { at: 'import', message: /Two vocabularies are named/ },
    cldf: { at: 'export', message: /Two vocabularies are named/ },
  },
};

/** The refusal a project's export in this format is expected to meet, or null. */
export function expectedExportRefusal(role, format) {
  const expected = REFUSALS[role]?.[format];
  return expected?.at === 'export' ? expected : null;
}
