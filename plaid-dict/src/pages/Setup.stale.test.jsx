import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// Two maintainers on one dictionary's Setup. A save refused because the other
// saved the same key since reads the vocabulary again, and the form then
// shows what is stored: a second Save must not put back the keys the other
// maintainer changed and this one never touched.

const server = vi.hoisted(() => ({ dict: null, writes: [] }));

vi.mock('@ui/lib/notify.js', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));

vi.mock('@/contexts/AuthContext', () => {
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const conflict = () => Object.assign(new Error('Changed elsewhere'), { status: 409 });
  const cas = (key, options) => {
    if (options && 'expected' in options && !same(server.dict[key], options.expected))
      throw conflict();
  };
  const client = {
    withOperation: async (_label, fn) => fn(),
    projects: { list: async () => [] },
    vocabLayers: {
      get: async () => ({ items: [] }),
      setConfig: async (_id, _ns, key, value, _msg, options) => {
        cas(key, options);
        server.dict = { ...server.dict, [key]: value };
        server.writes.push(key);
      },
      deleteConfig: async (_id, _ns, key, _msg, options) => {
        cas(key, options);
        const next = { ...server.dict };
        delete next[key];
        server.dict = next;
        server.writes.push(key);
      },
    },
  };
  // One batch is one transaction: a refused op writes nothing of the others.
  client.batched = async (fn) => {
    const queued = [];
    const queue =
      (name) =>
      (...args) =>
        queued.push([name, args]);
    await fn({
      vocabLayers: { setConfig: queue('setConfig'), deleteConfig: queue('deleteConfig') },
    });
    const before = { dict: server.dict, writes: [...server.writes] };
    try {
      for (const [name, args] of queued) await client.vocabLayers[name](...args);
    } catch (err) {
      server.dict = before.dict;
      server.writes = before.writes;
      throw err;
    }
  };
  return { useAuth: () => ({ client, user: { id: 'a@b.com', isAdmin: true } }) };
});

vi.mock('@/contexts/CatalogContext', async () => {
  const vocab = () => ({
    id: 'v1',
    name: 'Sena',
    maintainers: ['a@b.com'],
    config: { dict: server.dict },
  });
  return {
    useCatalog: () => {
      const [vocabularies, setVocabularies] = useState(() => [vocab()]);
      return { vocabularies, loading: false, reload: async () => setVocabularies([vocab()]) };
    },
  };
});

const { Setup } = await import('./Setup.jsx');

const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const saveButton = (container) =>
  [...container.querySelectorAll('button')].find((b) => /^(Save|Set up)$/.test(b.textContent));

describe('dictionary Setup against another maintainer', () => {
  it('shows the stored record after a refused save, and a second Save keeps their keys', async () => {
    server.dict = { title: 'Sena', slug: 'sena' };
    server.writes = [];
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/setup/v1']}>
        <Routes>
          <Route path="/setup/:vocabularyId" element={<Setup />} />
        </Routes>
      </MemoryRouter>,
    );
    const title = view.container.querySelector('#title');
    expect(title.value).toBe('Sena');

    // The other maintainer renames the dictionary and moves its address.
    server.dict = { title: 'Sena (Malawi)', slug: 'sena-mw' };

    // This one retitles it too, and is refused.
    await view.step(() => type(title, 'Chisena'));
    await view.step(() => saveButton(view.container).click());
    expect(server.writes).toEqual([]);

    // The form now shows what is stored.
    expect(view.container.querySelector('#title').value).toBe('Sena (Malawi)');
    expect(view.container.querySelector('#slug').value).toBe('sena-mw');

    // A second Save puts nothing of the old page back.
    await view.step(() => saveButton(view.container)?.click());
    expect(server.dict).toEqual({ title: 'Sena (Malawi)', slug: 'sena-mw' });
    await view.unmount();
  });

  // Written key by key, a Save refused on a later key had already stored the
  // earlier ones, though it said the Save failed.
  it('stores none of a Save that is refused on one of its keys', async () => {
    server.dict = { title: 'Sena', slug: 'sena', about: 'Old' };
    server.writes = [];
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/setup/v1']}>
        <Routes>
          <Route path="/setup/:vocabularyId" element={<Setup />} />
        </Routes>
      </MemoryRouter>,
    );
    // The other maintainer rewrites About.
    server.dict = { ...server.dict, about: 'Theirs' };
    await view.step(() => type(view.container.querySelector('#title'), 'Chisena'));
    const about = view.container.querySelector('#about');
    await view.step(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(about, 'Mine');
      about.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await view.step(() => saveButton(view.container).click());
    expect(server.writes).toEqual([]);
    expect(server.dict).toEqual({ title: 'Sena', slug: 'sena', about: 'Theirs' });
    await view.unmount();
  });
});
