import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, all } from '../../test/renderComponent.jsx';

// The Import and export tab plaid-ud and plaid-umr share. The format is the
// app's and is stood in by plain functions here: what is under test is the
// loop around them, the zip names and what the page shows.

const auth = vi.hoisted(() => ({ getClient: vi.fn(), logout: vi.fn(), user: null }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
const notify = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));
vi.mock('../../lib/notify.js', () => notify);

const { ProjectImportExportPage } = await import('./ProjectImportExportPage.jsx');

const PROJECT = { id: 'p1', name: 'Ay/Bee', maintainers: ['u'], writers: [], readers: [] };

const baseFormat = () => ({
  app: 'XY',
  extension: '.xy',
  importTitle: 'Import XY files',
  exportWhat: 'XY files',
  layerInfo: (p) => ({ isConfigured: !!p }),
  prepareImport: vi.fn(async () => async ({ index, name, push }) => {
    push({ key: `${index}`, name, status: 'imported', warnings: [] });
  }),
  exportDocuments: vi.fn(async () => ({ documents: 0, entries: [], skipped: [] })),
  zip: vi.fn(async () => new Blob(['zip'])),
});

const mount = async (format) => {
  const view = await renderComponent(
    <MemoryRouter initialEntries={['/projects/p1/io']}>
      <Routes>
        <Route
          path="/projects/:projectId/io"
          element={
            <ProjectImportExportPage
              tabs={() => null}
              setupHref={(id) => `/setup/${id}`}
              format={format}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  await view.step(settle);
  return view;
};

const settle = () => new Promise((r) => setTimeout(r, 0));
const button = (container, text) =>
  all(container, 'button').find((b) => b.textContent.trim().startsWith(text));

const drop = async (view, files) => {
  const input = view.container.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await view.step(() => input.dispatchEvent(new Event('change', { bubbles: true })));
};

const file = (name, text) => new File([text], name);

beforeEach(() => {
  auth.user = { id: 'u', isAdmin: false };
  auth.getClient.mockReturnValue({ projects: { get: async () => PROJECT } });
  Object.values(notify).forEach((f) => f.mockClear());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => vi.restoreAllMocks());

describe('import', () => {
  it("names each document after its file without the format's extension", async () => {
    const format = baseFormat();
    const view = await mount(format);
    await drop(view, [file('one.xy', 'a'), file('two.txt', 'b'), file('three.other', 'c')]);
    await view.step(async () => {
      button(view.container, 'Import').click();
      await settle();
    });
    const importFile = await format.prepareImport.mock.results[0].value;
    expect(importFile).toBeTypeOf('function');
    expect(view.container.textContent).toContain('Imported 3 of 3');
    const names = all(view.container, 'span.font-medium').map((s) => s.textContent);
    expect(names).toEqual(['three.other', 'two', 'one']);
    await view.unmount();
  });

  it('turns a file its importer throws on into a rejected row, and goes on to the next', async () => {
    const format = baseFormat();
    format.prepareImport = vi.fn(async () => async ({ index, name, push }) => {
      if (index === 0) throw new Error('Bad graph in sentence 2.');
      push({ key: `${index}`, name, status: 'imported', warnings: ['Kept as is.'] });
    });
    const view = await mount(format);
    await drop(view, [file('bad.xy', 'a'), file('good.xy', 'b')]);
    await view.step(async () => {
      button(view.container, 'Import').click();
      await settle();
    });
    expect(view.container.textContent).toContain('Imported 1 of 2, 1 rejected');
    expect(view.container.textContent).toContain('Bad graph in sentence 2.');
    expect(view.container.textContent).toContain('Kept as is.');
    // The blocking dialog is gone.
    expect(document.body.textContent).not.toContain('Importing documents');
    await view.unmount();
  });

  it('closes the blocking dialog when the import cannot start', async () => {
    const format = baseFormat();
    format.prepareImport = vi.fn(async () => {
      throw new Error('boom');
    });
    const view = await mount(format);
    await drop(view, [file('one.xy', 'a')]);
    await view.step(async () => {
      button(view.container, 'Import').click();
      await settle();
    });
    expect(notify.notifyError).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Importing documents');
    expect(button(view.container, 'Import').disabled).toBe(false);
    await view.unmount();
  });

  it('says on a row that it went onto an existing document', async () => {
    const format = baseFormat();
    format.prepareImport = vi.fn(async () => async ({ index, name, push }) => {
      push({ key: `${index}`, name, status: 'imported', attached: true, warnings: [] });
    });
    const view = await mount(format);
    await drop(view, [file('one.xy', 'a')]);
    await view.step(async () => {
      button(view.container, 'Import').click();
      await settle();
    });
    expect(view.container.textContent).toContain('onto the existing document');
    await view.unmount();
  });
});

describe('export', () => {
  const run = async (view) =>
    view.step(async () => {
      button(view.container, 'Export').click();
      await settle();
      await settle();
    });

  it('zips one file per document, a repeated name numbered', async () => {
    const format = baseFormat();
    format.exportDocuments = vi.fn(async ({ onProgress }) => {
      onProgress(2, 2);
      return {
        documents: 2,
        entries: [
          { name: 'Story', text: '1' },
          { name: 'Story', text: '2' },
        ],
        skipped: [],
      };
    });
    const view = await mount(format);
    await run(view);
    expect(format.zip).toHaveBeenCalledWith([
      { path: 'Story.xy', text: '1' },
      { path: 'Story (2).xy', text: '2' },
    ]);
    expect(notify.notifySuccess).toHaveBeenCalledWith('Exported 2 documents.');
    await view.unmount();
  });

  it('says so when the project has no documents, and zips nothing', async () => {
    const format = baseFormat();
    const view = await mount(format);
    await run(view);
    expect(notify.notifyError).toHaveBeenCalledWith('This project has no documents to export.');
    expect(format.zip).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('lists what was skipped in the warning tone', async () => {
    const format = baseFormat();
    format.exportDocuments = vi.fn(async () => ({
      documents: 2,
      entries: [{ name: 'One', text: '1' }],
      skipped: [{ name: 'Two', reason: 'No tokenized content available' }],
    }));
    const view = await mount(format);
    await run(view);
    const box = view.container.querySelector('[data-tone="warning"]');
    expect(box.textContent).toContain('1 document skipped');
    expect(box.querySelector('li').textContent).toBe('Two: No tokenized content available');
    expect(notify.notifyWarning).toHaveBeenCalledWith('Exported 1. 1 skipped (empty).');
    await view.unmount();
  });

  it("shows the app's account of a refused export in place of a toast", async () => {
    const format = baseFormat();
    const refusal = new Error('refused');
    format.exportDocuments = vi.fn(async () => {
      throw refusal;
    });
    format.exportFailure = (err) => (err === refusal ? <p role="alert">Cannot write it.</p> : null);
    const view = await mount(format);
    await run(view);
    expect(view.container.querySelector('[role="alert"]').textContent).toBe('Cannot write it.');
    expect(notify.notifyError).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('reports any other failure as a toast', async () => {
    const format = baseFormat();
    format.exportDocuments = vi.fn(async () => {
      throw new Error('boom');
    });
    format.exportFailure = () => null;
    const view = await mount(format);
    await run(view);
    expect(notify.notifyError).toHaveBeenCalled();
    await view.unmount();
  });
});

describe('a project the app has no layers in', () => {
  it('offers a maintainer the way to set it up, in the warning tone', async () => {
    const format = baseFormat();
    format.layerInfo = () => ({ isConfigured: false });
    const view = await mount(format);
    const box = view.container.querySelector('[data-tone="warning"]');
    expect(box.textContent).toContain('This project is not set up for XY.');
    expect(box.querySelector('a').getAttribute('href')).toBe('/setup/p1');
    await view.unmount();
  });
});
