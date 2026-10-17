import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { authService } from '@ui/services/auth.js';
import { useClientApart } from './useClientApart.js';

// An import running in the background and a Bulk Edit run in the same tab
// each write through a client of their own (H17-IGT-DATA-1): the version a
// Bulk Edit run sends a document at is never stamped on the import's writes,
// and the import's open operation never files the Bulk Edit's writes.

const seen = {};
const Probe = ({ client }) => {
  seen.client = useClientApart(client);
  return null;
};

describe('a long run has a client of its own', () => {
  it('on the session token, with its own strict mode and operation', async () => {
    const session = authService.newClient('tok');
    const view = await renderComponent(<Probe client={session} />);
    const own = seen.client;
    expect(own).not.toBe(session);
    expect(own.token).toBe('tok');

    own.documentVersions = { ...own.documentVersions, 'doc-x': 31 };
    own.enterStrictMode('doc-x');
    expect(session.strictModeDocumentId).toBe(null);

    session.beginOperation('Import FLEx project', { kind: 'import' });
    expect(own.operationGroup).toBe(null);
    session.endOperation?.();
    own.exitStrictMode();

    // the same client on every render
    await view.rerender(<Probe client={session} />);
    expect(seen.client).toBe(own);
    await view.unmount();
  });
});
