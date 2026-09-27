// The project's document fields on the Details tab. The name, the copy and the
// delete are the shared Details page's and are tested there. What is pinned
// here is this section's half: Save writes only what changed, waits for a
// change, refuses a value its tagset refuses, and never offers Plaid's own
// keys as fields.
import { describe, it, expect, vi } from 'vitest';
import { mountDocumentHook, fakeDocument } from '@/test/mountDocumentHook.jsx';
import { useMetadataOperations } from './useMetadataOperations.js';

const FIELDS = [{ name: 'Date' }, { name: 'Speakers' }];

const doc = (over = {}) =>
  fakeDocument({
    projectId: 'proj-1',
    document: { id: 'doc-1', name: 'Test Doc', metadata: { Date: '2020', Speakers: 'Ana' } },
    project: { config: { igt: { documentMetadata: FIELDS } } },
    saveNameAndMetadata: vi.fn(async () => true),
    ...over,
  });

const mount = (d) => mountDocumentHook(useMetadataOperations, { doc: d, args: [d] });

describe('the document fields on the Details tab', () => {
  it('shows what is stored and has nothing to save until a field changes', async () => {
    const h = await mount(doc());
    expect(h.api.values).toEqual({ Date: '2020', Speakers: 'Ana' });
    expect(h.api.dirty).toBe(false);
    await h.step(() => h.api.updateValue('Date', '2021'));
    expect(h.api.dirty).toBe(true);
    // Typed back to what is stored: nothing to save again.
    await h.step(() => h.api.updateValue('Date', '2020'));
    expect(h.api.dirty).toBe(false);
    await h.unmount();
  });

  it('saves the fields and no name, and is clean once the save lands', async () => {
    const d = doc();
    const h = await mount(d);
    await h.step(() => h.api.updateValue('Speakers', 'Ana, Ben'));
    await h.step(() => h.api.handleSave());
    expect(d.saveNameAndMetadata).toHaveBeenCalledWith(null, {
      Date: '2020',
      Speakers: 'Ana, Ben',
    });
    expect(h.api.saving).toBe(false);
    await h.unmount();
  });

  it('keeps what was typed when the save is refused', async () => {
    const d = doc({ saveNameAndMetadata: vi.fn(async () => false) });
    const h = await mount(d);
    await h.step(() => h.api.updateValue('Date', '2021'));
    await h.step(() => h.api.handleSave());
    expect(h.api.values.Date).toBe('2021');
    expect(h.api.dirty).toBe(true);
    await h.unmount();
  });

  it('holds Save back while a field has a value its tagset refuses', async () => {
    const d = doc({
      project: {
        config: {
          igt: {
            documentMetadata: [{ name: 'Genre', tagset: 'genres' }],
            tagsets: { genres: { mode: 'closed', values: [{ value: 'narrative' }] } },
          },
        },
      },
      document: { id: 'doc-1', name: 'Test Doc', metadata: {} },
    });
    const h = await mount(d);
    await h.step(() => h.api.updateValue('Genre', 'poem'));
    expect(h.api.metadataValid).toBe(false);
    await h.step(() => h.api.updateValue('Genre', 'narrative'));
    expect(h.api.metadataValid).toBe(true);
    await h.unmount();
  });

  it('never offers plaid as a field, even when the project declares one', async () => {
    const d = doc({
      project: { config: { igt: { documentMetadata: [{ name: 'plaid' }, { name: 'Date' }] } } },
      document: { id: 'doc-1', name: 'Test Doc', metadata: { plaid: { textDirection: 'rtl' } } },
    });
    const h = await mount(d);
    expect(h.api.metadataFields.map((f) => f.name)).toEqual(['Date']);
    expect(Object.keys(h.api.values)).toEqual(['Date']);
    await h.unmount();
  });

  it('never offers a provenance key as a field, even when the project declares one', async () => {
    const d = doc({
      project: {
        config: { igt: { documentMetadata: [{ name: 'provSource' }, { name: 'Date' }] } },
      },
      document: { id: 'doc-1', name: 'Test Doc', metadata: { provSource: 'user:a@b.com' } },
    });
    const h = await mount(d);
    expect(h.api.metadataFields.map((f) => f.name)).toEqual(['Date']);
    await h.unmount();
  });
});
