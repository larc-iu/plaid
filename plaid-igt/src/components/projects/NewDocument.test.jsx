import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { renderComponent, byText } from '@ui/test/renderComponent.jsx';
import { buildRawDoc, makeIgtDoc, resetIds, settle } from '@/domain/test-helpers.js';
import { segmentServer } from '@/test/segmentServer.js';

// New document makes the document, then its empty text in a request of its
// own, so every document made here has a text. The document is made before
// its text: a later step that fails must not leave the dialog open, where
// Create again made a second document (REV2-idempotency). It opens the
// document made, whose first write makes the text it lacks.
const feedback = vi.hoisted(() => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));
vi.mock('@/utils/feedback', () => feedback);
const { NewDocument } = await import('./NewDocument.jsx');

const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const Where = ({ onAt }) => {
  onAt(useLocation().pathname);
  return null;
};

// Press New document, name it "Story" and press Create. Answers the path
// opened.
const create = async (client) => {
  let at = null;
  const v = await renderComponent(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <NewDocument projectId="p1" client={client} canManage={false} />
              <Where onAt={(p) => (at = p)} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  await v.step(() => byText(v.container, 'button', 'New document').click());
  await v.step(() => type(document.body.querySelector('#doc-name'), 'Story'));
  await v.step(async () => {
    byText(document.body, 'button', 'Create').click();
  });
  await v.step(async () => {});
  await v.step(async () => {});
  return { v, at: () => at };
};

beforeEach(() => {
  resetIds();
  feedback.notifyError.mockClear();
});

describe('New document', () => {
  it('opens the document it made when giving it a text fails', async () => {
    const client = {
      documents: { create: vi.fn(async (_p, _n, _m, _a, { id }) => ({ id })) },
      projects: {
        get: vi.fn(async () => ({
          textLayers: [{ id: 'tl', config: { plaid: { role: 'baseline' } } }],
        })),
      },
      texts: {
        create: vi.fn(async () => {
          throw Object.assign(new Error('HTTP 500'), { status: 500 });
        }),
      },
    };
    const { v, at } = await create(client);
    const made = client.documents.create.mock.calls[0][4].id;
    expect(client.documents.create).toHaveBeenCalledTimes(1);
    expect(client.texts.create).toHaveBeenCalledTimes(1);
    expect(at()).toBe(`/projects/p1/documents/${made}`);
    expect(feedback.notifyError).not.toHaveBeenCalled();
    expect(document.body.querySelector('#doc-name')).toBe(null);
    await v.unmount();
  });

  // Two tabs open on the document just made, before either writes: the
  // second tab's segment goes over the text the first one's made.
  it("gives the document its empty text, so a second tab's segment lands", async () => {
    const raw = buildRawDoc({ body: '', words: [], morphemes: [], sentences: [] });
    delete raw.textLayers[0].text;
    const server = segmentServer(raw);
    const client = {
      documents: { create: vi.fn(async () => ({ id: server.stored.id })) },
      projects: { get: vi.fn(async () => ({ textLayers: server.stored.textLayers })) },
      texts: { create: server.client.texts.create },
    };
    const { v } = await create(client);
    await v.unmount();

    const tab = (user) => {
      const doc = makeIgtDoc({
        raw: structuredClone(server.stored),
        client: server.client,
        user: { id: user },
      });
      const errors = [];
      doc.onError = (message) => errors.push(String(message));
      return { doc, errors };
    };
    const idle = async (doc) => {
      while (doc.isSaving) await settle();
    };
    const a = tab('a');
    const b = tab('b');
    expect(await a.doc.createAlignment({ text: 'kai', timeBegin: 0, timeEnd: 1 })).toBe(true);
    await idle(a.doc);
    expect(await b.doc.createAlignment({ text: 'pele', timeBegin: 1, timeEnd: 2 })).toBe(true);
    await idle(b.doc);
    expect(b.errors).toEqual([]);
    expect(server.body).toBe('kai pele');
    expect(server.segments()).toHaveLength(2);
  });

  // REV-RL2-4: a name of only invisible characters is no name, as one of only
  // spaces is not: Create stays disabled and Enter makes nothing. A name with
  // a visible character goes as typed.
  it('takes a name of only invisible characters as none', async () => {
    const client = { documents: { create: vi.fn() } };
    const v = await renderComponent(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <NewDocument projectId="p1" client={client} canManage={false} />
      </MemoryRouter>,
    );
    await v.step(() => byText(v.container, 'button', 'New document').click());
    const field = () => document.body.querySelector('#doc-name');
    const create = () => byText(document.body, 'button', 'Create');
    const cp = (...cps) => String.fromCodePoint(...cps);
    for (const name of [
      '   ',
      cp(0x200b),
      cp(0x200b, 0x200c),
      cp(0xfeff),
      cp(0x3164),
      cp(0xfe0f),
    ]) {
      await v.step(() => type(field(), name));
      expect(create().disabled).toBe(true);
      await v.step(() =>
        field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
      );
    }
    expect(client.documents.create).not.toHaveBeenCalled();
    // Drawn, though Cf: an end of ayah alone, and a joiner inside a word.
    for (const name of [cp(0x06dd), cp(0x0915, 0x094d, 0x200d, 0x0937), cp(0x200b, 0x61)]) {
      await v.step(() => type(field(), name));
      expect(create().disabled).toBe(false);
    }
    await v.unmount();
  });
});
