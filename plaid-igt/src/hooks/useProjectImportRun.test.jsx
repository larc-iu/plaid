import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { PlaidClient } from '@larc-iu/plaid-client';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// R57: a project import that stops is never picked up again. The project it
// made keeps its import record, so it does not open, and the import page
// offers to delete it. The vocabularies the import made belong to that
// project, and core deletes them with it. Deleting it is what lets the same
// page import again, into a project of its own.

const made = vi.hoisted(() => ({ count: 0 }));
// Setup as the hook sees it: the project, then each new vocabulary, each
// reported as it is made.
vi.mock('@/components/projects/setup/executeSetup', () => ({
  executeProjectSetup: async ({ client, onProjectCreated, onVocabCreated }) => {
    made.count += 1;
    const projectId = `p${made.count}`;
    client.made.add(projectId);
    await onProjectCreated(projectId);
    const vocabId = `v${made.count}`;
    client.vocabs.set(vocabId, {
      id: vocabId,
      name: `Lexicon ${made.count}`,
      project: projectId,
      config: {},
    });
    client.links.set(projectId, [vocabId]);
    await onVocabCreated(vocabId);
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
const { FinishPending, ImportRunPanel } = await import('@/components/projects/ImportPanels.jsx');
const { ImportCancelled } = await import('@/import/stamps.js');
const { UnfinishedImport } = await import('@/components/projects/UnfinishedImport.jsx');

// A server holding each project's igt config, its vocabularies (each with its
// home project) and which project links which.
const serverClient = () => {
  const config = new Map(); // projectId -> igt config
  const deleted = [];
  const vocabsDeleted = [];
  // The project's own vocabularies, or core's 409 while another project links
  // one of them.
  const refuseIfBorrowed = (id) => {
    const own = [...client.vocabs.values()].filter((v) => v.project === id);
    const borrowers = [...client.links.entries()].filter(
      ([pid, ids]) => pid !== id && own.some((v) => ids.includes(v.id)),
    ).length;
    if (borrowers) {
      const said = `${borrowers} other project uses a vocabulary of this project.`;
      throw Object.assign(new Error(said), {
        status: 409,
        responseData: { error: said, 'other-projects': borrowers },
      });
    }
    return own;
  };
  const client = {
    config,
    deleted,
    vocabsDeleted,
    // Every project delete asked, as `[id, read]`: true for the read of what
    // it takes, false for the delete.
    deletes: [],
    made: new Set(),
    vocabs: new Map(),
    links: new Map(), // projectId -> [vocabId]
    failSet: false,
    failClears: 0,
    projects: {
      setConfig: async (id, ns, key, value) => {
        if (client.failSet) throw new Error('offline');
        config.set(id, { ...(config.get(id) || {}), [key]: value });
      },
      deleteConfig: async (id, ns, key) => {
        if (client.failClears > 0) {
          client.failClears -= 1;
          throw Object.assign(new Error('Bad gateway'), { status: 502 });
        }
        const { [key]: _, ...rest } = config.get(id) || {};
        config.set(id, rest);
      },
      get: async (id) => ({
        id,
        config: { igt: config.get(id) || {} },
        vocabs: (client.links.get(id) || []).map((v) => client.vocabs.get(v)),
      }),
      list: async () =>
        [...client.made]
          .filter((id) => !deleted.includes(id))
          .map((id) => ({
            id,
            vocabs: (client.links.get(id) || []).map((v) => client.vocabs.get(v)),
          })),
      // As core answers it: refused while another project links one of the
      // project's own vocabularies, readable by the caller or not. The read
      // of the delete names its own vocabularies and writes nothing. The
      // delete takes them with the project.
      deletion: async (id) => {
        client.deletes.push([id, true]);
        const own = refuseIfBorrowed(id);
        return { vocabularies: own.map(({ id: vid, name }) => ({ id: vid, name })) };
      },
      delete: async (id) => {
        client.deletes.push([id, false]);
        const own = refuseIfBorrowed(id);
        deleted.push(id);
        config.delete(id);
        client.links.delete(id);
        for (const v of own) {
          vocabsDeleted.push(v.id);
          client.vocabs.delete(v.id);
        }
      },
    },
    vocabLayers: {
      get: async (id) => {
        const v = client.vocabs.get(id);
        if (!v) throw Object.assign(new Error('Not found'), { status: 404 });
        return v;
      },
      setConfig: async (id, ns, key, value) => {
        const v = client.vocabs.get(id);
        v.config = { ...v.config, [ns]: { ...(v.config[ns] || {}), [key]: value } };
      },
      deleteConfig: async (id, ns, key) => {
        const v = client.vocabs.get(id);
        const { [key]: _, ...rest } = v.config[ns] || {};
        v.config = { ...v.config, [ns]: rest };
      },
      // The project delete takes the vocabularies: none is deleted on its own.
      delete: async (id) => {
        throw new Error(`vocabLayers.delete(${id}) sent`);
      },
    },
  };
  return client;
};

const Page = ({ client, run, onRun }) => {
  const r = useProjectImportRun({ client, kind: 'CLDF' });
  onRun(r);
  return (
    <>
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
      {r.stage === 'done' && r.finishPending && <FinishPending onRetry={r.retryFinish} />}
    </>
  );
};

const buttons = (label) =>
  [...document.body.querySelectorAll('button')].filter((b) => b.textContent.trim() === label);

// What a person types into the delete confirm.
const typeName = async (view, name) => {
  const input = document.body.querySelector('#delete-project-confirm');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  await view.step(async () => {
    set.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const confirmDelete = async (view, name) => {
  await view.step(async () => buttons('Delete')[0].click());
  await typeName(view, name);
  const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find(
    (b) => b.textContent.trim() === 'Delete project',
  );
  await view.step(async () => confirm.click());
};

const mount = async (client, run) => {
  let r = null;
  const view = await renderComponent(<Page client={client} run={run} onRun={(x) => (r = x)} />);
  return { view, read: () => r };
};

const stopping = async () => {
  throw new ImportCancelled();
};

describe('a project import that stops', () => {
  it('leaves its project marked unfinished, offers Delete, and Delete removes it and the vocabulary the import made', async () => {
    const client = serverClient();
    const { view, read } = await mount(client, stopping);
    await view.step(async () => buttons('Go')[0].click());

    expect(read().stopped).toBe(true);
    const { id } = read().unfinished;
    expect(read().unfinished).toEqual({ id, name: 'Half' });
    // The record stays, so the project does not open, and names what setup made.
    const record = client.config.get(id).import;
    expect(record).toMatchObject({ kind: 'CLDF' });
    expect(record.vocabsMade).toHaveLength(1);
    // R58: the vocabulary it made is marked with it, so it does not open either.
    expect(client.vocabs.get(record.vocabsMade[0]).config.igt.import).toEqual({ projectId: id });
    expect(view.container.textContent).toContain('Import stopped');
    expect(view.container.textContent).toContain(
      'This import did not finish. Delete it and import again.',
    );
    expect(client.deleted).toEqual([]);

    await view.step(async () => buttons('Delete')[0].click());
    const dialog = document.body.querySelector('[role="alertdialog"]').textContent;
    expect(dialog).toContain('Half is deleted. This cannot be undone.');
    expect(dialog).toContain('Its vocabulary “Lexicon');
    expect(dialog).toContain('is deleted with it.');
    expect(dialog).not.toContain('excepted');
    // Opening the confirm asks only what the delete takes.
    expect(client.deletes).toEqual([[id, true]]);
    await view.step(async () => buttons('Cancel')[0].click());

    await confirmDelete(view, 'Half');
    expect(client.deleted).toEqual([id]);
    expect(client.vocabsDeleted).toEqual(record.vocabsMade);
    expect(read().unfinished).toBe(null);
    expect(view.container.textContent).not.toContain('This import did not finish.');
    await view.unmount();
  });

  // Core refuses the delete while another project links a vocabulary the
  // import made, readable by the person deleting or not, and the confirm
  // says so with Cancel only.
  it('is refused while another project uses a vocabulary the import made, even one the deleter cannot read', async () => {
    const client = serverClient();
    const { view, read } = await mount(client, stopping);
    await view.step(async () => buttons('Go')[0].click());
    const { id } = read().unfinished;
    const [vocab] = client.config.get(id).import.vocabsMade;
    // Someone else's project, which projects.list() does not show.
    client.links.set('someone-elses', [vocab]);
    await view.step(async () => buttons('Delete')[0].click());
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog.textContent).toContain(
      '1 other project uses a vocabulary of this project. It can be deleted once that project unlinks it.',
    );
    expect(document.body.querySelector('#delete-project-confirm')).toBeNull();
    expect(
      [...dialog.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean),
    ).toEqual(['Cancel']);
    expect(client.deletes).toEqual([[id, true]]);
    expect(client.deleted).toEqual([]);
    expect(client.vocabs.has(vocab)).toBe(true);
    await view.unmount();
  });

  // A project borrowed the vocabulary after the confirm opened: the delete's
  // own refusal turns the confirm into it.
  it('shows the refusal when the delete itself is refused', async () => {
    const client = serverClient();
    const { view, read } = await mount(client, stopping);
    await view.step(async () => buttons('Go')[0].click());
    const { id } = read().unfinished;
    const [vocab] = client.config.get(id).import.vocabsMade;
    await view.step(async () => buttons('Delete')[0].click());
    await typeName(view, 'Half');
    client.links.set('p-late', [vocab]);
    const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find(
      (b) => b.textContent.trim() === 'Delete project',
    );
    await view.step(async () => confirm.click());
    expect(document.body.querySelector('[role="alertdialog"]').textContent).toContain(
      '1 other project uses a vocabulary of this project.',
    );
    expect(client.deleted).toEqual([]);
    expect(read().unfinished).toEqual({ id, name: 'Half' });
    await view.unmount();
  });

  // R59: entries the import added to a lexicon the person keeps stay there,
  // and the screen says how many.
  it('says how many entries it added to a lexicon the person keeps', async () => {
    const client = serverClient();
    client.vocabs.set('kept', { id: 'kept', name: 'Our lexicon', project: 'ours', config: {} });
    const run = async ({ onEntriesMade }) => {
      await onEntriesMade('kept', 2);
      await onEntriesMade('kept', 1);
      throw new ImportCancelled();
    };
    const { view } = await mount(client, run);
    await view.step(async () => buttons('Go')[0].click());
    await view.step(async () => {});
    expect(view.container.textContent).toContain(
      'The import added 3 entries to “Our lexicon” before it stopped. They stay there.',
    );
    await confirmDelete(view, 'Half');
    expect(client.vocabs.has('kept')).toBe(true);
    await view.unmount();
  });

  it('deletes nothing until the project name is typed', async () => {
    const client = serverClient();
    const { view } = await mount(client, stopping);
    await view.step(async () => buttons('Go')[0].click());
    await view.step(async () => buttons('Delete')[0].click());
    await typeName(view, 'Hal');
    const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find(
      (b) => b.textContent.trim() === 'Delete project',
    );
    expect(confirm.disabled).toBe(true);
    expect(client.deleted).toEqual([]);
    await view.unmount();
  });

  it('makes a new project when it runs again, and clears the record once the whole run is in', async () => {
    const client = serverClient();
    let stop = true;
    const run = async () => {
      if (stop) throw new ImportCancelled();
      return { imported: 1, warnings: [] };
    };
    const { view, read } = await mount(client, run);
    await view.step(async () => buttons('Go')[0].click());
    const first = read().unfinished.id;
    stop = false;
    await view.step(async () => read().clearUnfinished());
    await view.step(async () => buttons('Go')[0].click());
    expect(read().stage).toBe('done');
    expect(read().projectIdRef.current).not.toBe(first);
    expect(client.config.get(read().projectIdRef.current).import).toBeUndefined();
    // The whole run's vocabulary opens: its mark went with the record.
    const second = `v${read().projectIdRef.current.slice(1)}`;
    expect(client.vocabs.get(second).config.igt.import).toBeUndefined();
    // Nothing deleted the first: only the person does.
    expect(client.config.get(first).import).toMatchObject({ kind: 'CLDF' });
    await view.unmount();
  });
});

// REV-FX-R57-3: the run knows it finished. A record clear that fails is
// tried again, and failing that the page says so and offers Try again,
// never Delete.
describe('a whole import whose record cannot be cleared', () => {
  const whole = async () => ({ imported: 1, warnings: [] });

  it('tries the clear again and finishes when one lands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = serverClient();
    client.failClears = 2;
    const { view, read } = await mount(client, whole);
    await view.step(async () => {
      buttons('Go')[0].click();
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();
    expect(read().stage).toBe('done');
    expect(read().finishPending).toBe(false);
    expect(read().unfinished).toBe(null);
    expect(client.config.get(read().projectIdRef.current).import).toBeUndefined();
    await view.unmount();
  });

  it('says it finished but could not be marked done, with Try again and no Delete', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = serverClient();
    client.failClears = 99;
    const { view, read } = await mount(client, whole);
    await view.step(async () => {
      buttons('Go')[0].click();
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();
    expect(read().stage).toBe('done');
    expect(read().finishPending).toBe(true);
    expect(read().unfinished).toBe(null);
    expect(view.container.textContent).toContain(
      'The import finished but could not be marked done.',
    );
    expect(buttons('Delete')).toEqual([]);
    client.failClears = 0;
    await view.step(async () => buttons('Try again')[0].click());
    await act(async () => {});
    expect(read().finishPending).toBe(false);
    expect(client.config.get(read().projectIdRef.current).import).toBeUndefined();
    await view.unmount();
  });
});

// R57 leftover: Try again outlived only the import page. Once the page was
// left or loaded again, every screen offered Delete for a whole project.
describe('a whole import whose record clear failed, read again later', () => {
  it('offers Try again and no Delete, and Try again clears the record', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = serverClient();
    client.failClears = 99;
    const { view, read } = await mount(client, async () => ({ imported: 1, warnings: [] }));
    await view.step(async () => {
      buttons('Go')[0].click();
      await vi.runAllTimersAsync();
    });
    vi.useRealTimers();
    const id = read().projectIdRef.current;
    await view.unmount();

    // The project as a screen reads it after a reload.
    const project = { id, name: 'Half', config: (await client.projects.get(id)).config };
    const onFinished = vi.fn();
    const again = await renderComponent(
      <UnfinishedImport client={client} project={project} canManage onFinished={onFinished} />,
    );
    await act(async () => {});
    expect(again.container.textContent).toContain(
      'The import finished but could not be marked done.',
    );
    expect(buttons('Delete')).toEqual([]);
    client.failClears = 0;
    await again.step(async () => buttons('Try again')[0].click());
    await act(async () => {});
    expect(client.config.get(id).import).toBeUndefined();
    expect(onFinished).toHaveBeenCalled();
    await again.unmount();
  });
});

// S4: a record that cannot be written stops the import before anything else.
describe('a record that cannot be written', () => {
  it('stops the import with an error, before the engine runs', async () => {
    const client = serverClient();
    client.failSet = true;
    const run = vi.fn(async () => ({ imported: 1, warnings: [] }));
    const { view, read } = await mount(client, run);
    await view.step(async () => buttons('Go')[0].click());
    expect(run).not.toHaveBeenCalled();
    expect(read().stage).toBe('review');
    expect(read().runError).toBe('offline');
    expect(view.container.textContent).toContain('Failed to import');
    await view.unmount();
  });
});

// What the confirm SENDS, through the real plaid-client-js over a stubbed
// fetch: what the delete takes is a GET of its own, never the DELETE with a
// flag that a core or client without it would obey as the delete (VH-UI's
// hazard).
describe('the unfinished import delete, as sent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends only the read of the delete when the confirm opens, then the delete of the project alone', async () => {
    const sent = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const line = `${init.method ?? 'GET'} ${String(url).replace('http://plaid.test', '')}`;
      sent.push(line);
      const body =
        line === 'GET /api/v1/projects/p1/deletion'
          ? { vocabularies: [{ id: 'v1', name: 'Lexicon' }] }
          : line.startsWith('GET /api/v1/vocab-layers/')
            ? { id: 'v1', name: 'Lexicon', project: 'p1', config: {} }
            : null;
      return body
        ? new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(null, { status: 204 });
    });
    const client = new PlaidClient('http://plaid.test', 'token');
    const project = {
      id: 'p1',
      name: 'Half',
      config: { igt: { import: { kind: 'CLDF', vocabsMade: ['v1'] } } },
    };
    const onDeleted = vi.fn();
    const view = await renderComponent(
      <UnfinishedImport client={client} project={project} canManage onDeleted={onDeleted} />,
    );
    await act(async () => {});
    const before = sent.length;
    await view.step(async () => buttons('Delete')[0].click());
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(sent.slice(before)).toEqual(['GET /api/v1/projects/p1/deletion']);
    expect(document.body.querySelector('[role="alertdialog"]').textContent).toContain(
      'Its vocabulary “Lexicon” is deleted with it.',
    );
    await typeName(view, 'Half');
    const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find(
      (b) => b.textContent.trim() === 'Delete project',
    );
    await view.step(async () => confirm.click());
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(sent.slice(before)).toEqual([
      'GET /api/v1/projects/p1/deletion',
      'DELETE /api/v1/projects/p1',
    ]);
    expect(sent.some((l) => l.includes('/vocab-layers') && !l.startsWith('GET'))).toBe(false);
    expect(onDeleted).toHaveBeenCalled();
    await view.unmount();
  });
});
