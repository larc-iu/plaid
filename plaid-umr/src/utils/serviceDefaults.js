import { TASKS } from '@larc-iu/plaid-client';

// This app's own half of the service-defaults story. Everything shared with
// plaid-igt and plaid-ud lives in `@ui/domain/serviceDefaults`: the selection
// encoding, the project-config reads, and the resolution order a spot starts
// from.
//
// This app registers NO built-in method. Text and tokens are never made here,
// and a graph is either drawn by hand on the canvas or drafted by a service,
// so every spot below carries an empty `builtins` list.

// The localStorage namespace the Draft spot remembers its chosen method and
// its options under.
export const DRAFT_STORAGE_ID = 'draft';

// The editor's one integration spot, keyed by the task vocabulary a service
// declares in its extras. Read by the Draft dialog and by the project's
// Services settings, so the two cannot describe it differently.
export const DRAFT_SPOT = {
  key: TASKS.ANALYZE,
  label: 'Draft',
  description:
    'Writes a first UMR graph for the sentences of a document, to be corrected on the canvas. ' +
    'The Draft button on the annotation page.',
  builtins: [],
};

export const UMR_SPOTS = [DRAFT_SPOT];
