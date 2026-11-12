import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '../../test/renderComponent.jsx';

// The Documents tab's heading carries the app's controls for a writer: its
// way to make a new document, and beside it whatever else the app offers
// there (igt's Start job, the jobs round of 2026-11-12). A reader gets none.

vi.mock('./DocumentTable.jsx', () => ({ DocumentTable: () => <div data-testid="table" /> }));

const { ProjectDocumentsList } = await import('./ProjectDocumentsList.jsx');

const NewDocument = ({ projectId }) => <button type="button">New document {projectId}</button>;

const mount = (canEdit) =>
  renderComponent(
    <ProjectDocumentsList
      projectId="p1"
      documents={[]}
      canEdit={canEdit}
      newDocument={NewDocument}
      actions={<button type="button">Start job</button>}
      href={() => '#'}
    />,
  );

describe('the Documents heading', () => {
  it('draws the app’s actions beside New document for a writer', async () => {
    const view = await mount(true);
    expect(all(view.container, 'button').map((b) => b.textContent)).toEqual([
      'New document p1',
      'Start job',
    ]);
    await view.unmount();
  });

  it('draws neither for a reader', async () => {
    const view = await mount(false);
    expect(all(view.container, 'button')).toHaveLength(0);
    await view.unmount();
  });
});
