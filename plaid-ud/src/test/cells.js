// The grid's cell engine (plaid-ui cells/CellEngine.js) for an annotation
// cell drawn in a component test with no editor around it. `read(key)` is the
// document: the value stored for `<token id>:<field>`, or undefined for a
// token that is gone. Conflicts are pushed onto `heard`, and the toasts go to
// `warn` and `error`, as the editor's go to the app's feedback.
import { reactCellEngine } from '@ui/hooks/useCellEngine.js';
import { announceCells } from '@ui/lib/cellConflict.js';

const NO_AUDIT = { documents: { auditPage: async () => ({ entries: [] }) } };

export const testCells = ({ read, shape = null, recut = null, heard = null, warn, error }) => {
  const toast = announceCells({
    client: NO_AUDIT,
    documentId: 'd1',
    me: 'a@b.com',
    warn: (message) => warn?.(message),
    error: (message, title) => error?.(message, title),
  });
  return reactCellEngine({
    read,
    shape,
    recut,
    announce: (event) => {
      if (event.kind === 'conflict') heard?.push(event);
      toast(event);
    },
  });
};
