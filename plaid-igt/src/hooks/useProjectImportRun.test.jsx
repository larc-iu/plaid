import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// R57: a project import that stops is never picked up again. The project it
// made keeps its import record, so it does not open, and the import page
// offers to delete it. Deleting it is what lets the same page import again,
// into a project of its own.

const made = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/projects/setup/executeSetup', () => ({
  executeProjectSetup: async ({ onProjectCreated }) => {
    made.count += 1;
    const projectId = `p${made.count}`;
    await onProjectCreated(projectId);
    return { projectId, failures: [], resources: {} };
  },
}));
vi.mock('@/utils/feedback', () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  notifyWarning: vi.fn(),
  humanizeError: (e) => e.message,
}));

const { useProjectImportRun } = await import('./useProjectImportRun.js');
const { ImportRunPanel } = await import('@/components/projects/ImportPanels.jsx');
const { ImportCancelled } = await import('@/import/stamps.js');

// A server holding each project's igt config.
const serverClient = () => {
  const config = new Map(); // projectId -> igt config
  const deleted = [];
  return {
    config,
    deleted,
    projects: {
      setConfig: async (id, ns, key, value) => {
        config.set(id, { ...(config.get(id) || {}), [key]: value });
      },
      deleteConfig: async (id, ns, key) => {
        const { [key]: _, ...rest } = config.get(id) || {};
        config.set(id, rest);
      },
      get: async (id) => ({ id, config: { igt: config.get(id) || {} } }),
      delete: async (id) => {
        deleted.push(id);
        config.delete(id);
      },
    },
  };
};

const Page = ({ client, run, onRun }) => {
  const r = useProjectImportRun({ client, kind: 'CLDF' });
  onRun(r);
  return (
    <ImportRunPanel
      stage={r.stage}
      runError={r.runError}
      stopped={r.stopped}
      unfinished={r.unfinished}
      client={client}
      onDeleted={r.clearUnfinished}
    >
      <button
        type="button"
        onClick={() => r.start({ setupData: { basicInfo: { projectName: 'Half' } }, run })}
      >
        Go
      </button>
    </ImportRunPanel>
  );
};

const buttons = (label) =>
  [...document.body.querySelectorAll('button')].filter((b) => b.textContent.trim() === label);

describe('a project import that stops', () => {
  it('leaves its project marked unfinished, offers Delete, and Delete removes it', async () => {
    const client = serverClient();
    let r = null;
    const stopping = async () => {
      throw new ImportCancelled();
    };
    const view = await renderComponent(
      <ConfirmProvider>
        <Page client={client} run={stopping} onRun={(x) => (r = x)} />
      </ConfirmProvider>,
    );
    await view.step(async () => buttons('Go')[0].click());

    expect(r.stopped).toBe(true);
    const { id } = r.unfinished;
    expect(r.unfinished).toEqual({ id, name: 'Half' });
    // The record stays, so the project does not open.
    expect(client.config.get(id).import).toMatchObject({ kind: 'CLDF' });
    expect(view.container.textContent).toContain('Import stopped');
    expect(view.container.textContent).toContain(
      'This import did not finish. Delete it and import again.',
    );
    expect(client.deleted).toEqual([]);

    await view.step(async () => buttons('Delete')[0].click());
    const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find(
      (b) => b.textContent.trim() === 'Delete',
    );
    await view.step(async () => confirm.click());
    expect(client.deleted).toEqual([id]);
    expect(r.unfinished).toBe(null);
    expect(view.container.textContent).not.toContain('This import did not finish.');
    await view.unmount();
  });

  it('makes a new project when it runs again, and clears the record once the whole run is in', async () => {
    const client = serverClient();
    let r = null;
    let stop = true;
    const run = async () => {
      if (stop) throw new ImportCancelled();
      return { imported: 1, warnings: [] };
    };
    const view = await renderComponent(
      <ConfirmProvider>
        <Page client={client} run={run} onRun={(x) => (r = x)} />
      </ConfirmProvider>,
    );
    await view.step(async () => buttons('Go')[0].click());
    const first = r.unfinished.id;
    stop = false;
    await view.step(async () => r.clearUnfinished());
    await view.step(async () => buttons('Go')[0].click());
    expect(r.stage).toBe('done');
    expect(r.projectIdRef.current).not.toBe(first);
    expect(client.config.get(r.projectIdRef.current).import).toBeUndefined();
    // Nothing deleted the first: only the person does.
    expect(client.config.get(first).import).toMatchObject({ kind: 'CLDF' });
    await view.unmount();
  });
});
