import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// R57: a project import that stops is never picked up again. The project it
// made keeps its import record, so it does not open, and the import page
// offers to delete it, with the vocabularies the import made. Deleting it is
// what lets the same page import again, into a project of its own.

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
    client.vocabs.set(vocabId, { id: vocabId, name: `Lexicon ${made.count}`, config: {} });
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
const { notifyWarning } = await import('@/utils/feedback');

// A server holding each project's igt config, its vocabularies and which
// project links which.
const serverClient = () => {
  const config = new Map(); // projectId -> igt config
  const deleted = [];
  const vocabsDeleted = [];
  const client = {
    config,
    deleted,
    vocabsDeleted,
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
      delete: async (id) => {
        deleted.push(id);
        config.delete(id);
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
      // As core answers it: with onlyInProject, refused while any other
      // project links the vocabulary, readable by the caller or not.
      delete: async (id, _message, { onlyInProject } = {}) => {
        if (client.failVocabDelete) throw client.failVocabDelete;
        const elsewhere = [...client.links.entries()].some(
          ([pid, ids]) => pid !== onlyInProject && ids.includes(id),
        );
        if (onlyInProject && elsewhere) {
          throw Object.assign(new Error('Another project uses this vocabulary.'), {
            status: 409,
          });
        }
        vocabsDeleted.push(id);
        client.vocabs.delete(id);
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

    await confirmDelete(view, 'Half');
    expect(client.deleted).toEqual([id]);
    expect(client.vocabsDeleted).toEqual(record.vocabsMade);
    expect(read().unfinished).toBe(null);
    expect(view.container.textContent).not.toContain('This import did not finish.');
    await view.unmount();
  });

  // REV-FX-R57-2-2: core decides, from every project linking it, readable by
  // the person deleting or not. One another project links stays, and is named.
  it('keeps a vocabulary the import made that another project links, even one the deleter cannot read', async () => {
    const client = serverClient();
    const { view, read } = await mount(client, stopping);
    await view.step(async () => buttons('Go')[0].click());
    const { id } = read().unfinished;
    const [vocab] = client.config.get(id).import.vocabsMade;
    // Someone else's project, which projects.list() does not show.
    client.links.set('someone-elses', [vocab]);
    notifyWarning.mockClear();
    await confirmDelete(view, 'Half');
    expect(client.deleted).toEqual([id]);
    expect(client.vocabsDeleted).toEqual([]);
    expect(client.vocabs.has(vocab)).toBe(true);
    expect(notifyWarning).toHaveBeenCalledWith(
      `“${client.vocabs.get(vocab).name}” stays (used by another project).`,
      'Vocabularies kept',
    );
    // REV-FX-R57-3-1: kept, it is an ordinary vocabulary again.
    expect(client.vocabs.get(vocab).config.igt.import).toBeUndefined();
    await view.unmount();
  });

  // REV-FX-R57-3-1: a vocabulary Delete could not remove is never left
  // marked, and the notice says why it stayed.
  it.each([
    [403, 'stays (you do not maintain it).'],
    [502, 'could not be deleted. Try again from the Vocabularies page.'],
  ])(
    'takes the mark off a vocabulary whose delete answers %s, and says so',
    async (status, said) => {
      const client = serverClient();
      const { view, read } = await mount(client, stopping);
      await view.step(async () => buttons('Go')[0].click());
      const { id } = read().unfinished;
      const [vocab] = client.config.get(id).import.vocabsMade;
      client.failVocabDelete = Object.assign(new Error('refused'), { status });
      notifyWarning.mockClear();
      await confirmDelete(view, 'Half');
      expect(client.deleted).toEqual([id]);
      expect(client.vocabs.get(vocab).config.igt.import).toBeUndefined();
      expect(notifyWarning).toHaveBeenCalledWith(
        `“${client.vocabs.get(vocab).name}” ${said}`,
        'Vocabularies kept',
      );
      await view.unmount();
    },
  );

  // R59: entries the import added to a lexicon the person keeps stay there,
  // and the screen says how many.
  it('says how many entries it added to a lexicon the person keeps', async () => {
    const client = serverClient();
    client.vocabs.set('kept', { id: 'kept', name: 'Our lexicon', config: {} });
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
