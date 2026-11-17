import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// A document's header holds History and nothing of the app's own: no button
// there sets up a job (the owner, 2026-11-17). The shell is a stand-in that
// hands the test what IGT gave it.
const shell = vi.hoisted(() => ({ app: null }));
vi.mock('@ui/components/shared/DocumentEditorShell.jsx', () => ({
  DocumentEditorShell: ({ app }) => {
    shell.app = app;
    return null;
  },
}));
vi.mock('./contexts/StrictModeContext.jsx', () => ({ useStrictClient: () => ({}) }));

const { DocumentDetail } = await import('./DocumentDetail.jsx');

describe("a document's header", () => {
  it('has no action of the app’s own beside History', async () => {
    const v = await renderComponent(<DocumentDetail />);
    expect(shell.app).not.toBeNull();
    expect(shell.app.headerActions).toBeUndefined();
    await v.unmount();
  });
});
