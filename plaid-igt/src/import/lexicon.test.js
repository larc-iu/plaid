import { describe, it, expect, vi } from 'vitest';
import { maintainedLexicons, writeVocabConfig } from './lexicon.js';

// A vocabulary's settings are written by a maintainer of the project it
// belongs to. An import into one whose project the person no longer
// maintains is refused, and says which project.

const refused = () => Object.assign(new Error('HTTP 403'), { status: 403 });
const LEXICON = { id: 'v1', name: 'Lexicon', project: 'pa', config: { igt: { fields: {} } } };

describe('writeVocabConfig', () => {
  it('names the project whose maintainer can import into the vocabulary', async () => {
    const client = { projects: { get: vi.fn(async () => ({ id: 'pa', name: 'Field notes' })) } };
    await expect(
      writeVocabConfig(client, LEXICON, 'igt', 'fields', { gloss: {} }, async () => {
        throw refused();
      }),
    ).rejects.toThrow(
      'Only a maintainer of the project “Field notes” can import into the vocabulary “Lexicon”.',
    );
    expect(client.projects.get).toHaveBeenCalledWith('pa');
  });

  it('says the project it belongs to when that project cannot be read', async () => {
    const client = {
      projects: {
        get: async () => {
          throw refused();
        },
      },
    };
    await expect(
      writeVocabConfig(client, LEXICON, 'igt', 'fields', { gloss: {} }, async () => {
        throw refused();
      }),
    ).rejects.toThrow(
      'Only a maintainer of the project it belongs to can import into the vocabulary “Lexicon”.',
    );
  });

  it('writes nothing that is already there', async () => {
    const write = vi.fn();
    expect(await writeVocabConfig({}, LEXICON, 'igt', 'fields', {}, write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

// FLEx "Add to a lexicon you maintain": the import's new project borrows the
// lexicon and writes its entries and fields, which takes a maintainer of the
// project the lexicon belongs to (core judges by that project's role, not by
// the project the import makes).
describe('maintainedLexicons', () => {
  const user = { id: 'me@x.org', isAdmin: false };
  const PROJECTS = [
    { id: 'pm', name: 'Mine', maintainers: ['me@x.org'] },
    { id: 'pw', name: 'Written', writers: ['me@x.org'] },
    { id: 'pr', name: 'Read', readers: ['me@x.org'] },
  ];
  const VOCABS = [
    { id: 'v-m', name: 'Maintained', project: 'pm' },
    { id: 'v-w', name: 'Written', project: 'pw' },
    { id: 'v-r', name: 'Read', project: 'pr' },
    { id: 'v-x', name: 'Elsewhere', project: 'px' },
    { id: 'v-half', name: 'Half', project: 'pm', config: { igt: { import: { projectId: 'pm' } } } },
  ];

  it('lists only the vocabularies of projects the user maintains, an unfinished import’s left out', () => {
    expect(maintainedLexicons(VOCABS, PROJECTS, user).map((v) => v.id)).toEqual(['v-m']);
  });

  it('lists every vocabulary whose project an admin has', () => {
    const admin = { id: 'a@x.org', isAdmin: true };
    expect(maintainedLexicons(VOCABS, PROJECTS, admin).map((v) => v.id)).toEqual([
      'v-m',
      'v-w',
      'v-r',
    ]);
  });
});
