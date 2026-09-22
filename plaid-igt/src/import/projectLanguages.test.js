import { describe, it, expect } from 'vitest';
import { recordProjectLanguages } from './projectLanguages.js';

// One writer for the project's language identity. It had two: CLDF wrote the
// record itself, with its own empty literal that had no `tag` in it and no
// check that the project had not already named a language.

const stub = () => {
  const written = [];
  return {
    written,
    client: { projects: { setConfig: async (...args) => written.push(args) } },
  };
};
const value = (written) => written[0][3];

describe('recordProjectLanguages', () => {
  it('records a bare tag, and reads a 3-letter one as the code too', async () => {
    const { client, written } = stub();
    expect(await recordProjectLanguages(client, { id: 'p1', config: {} }, { object: 'pmy' })).toBe(
      true,
    );
    expect(value(written).object).toEqual({
      name: '',
      glottocode: '',
      iso639P3: 'pmy',
      tag: 'pmy',
      latitude: null,
      longitude: null,
    });
    expect(value(written).meta).toEqual({
      name: '',
      glottocode: '',
      iso639P3: '',
      tag: '',
      latitude: null,
      longitude: null,
    });
  });

  it('keeps a tag that is not a code out of the code', async () => {
    const { client, written } = stub();
    await recordProjectLanguages(client, { id: 'p1', config: {} }, { object: 'qaa-x-abc' });
    expect(value(written).object).toMatchObject({ tag: 'qaa-x-abc', iso639P3: '' });
  });

  it('takes a whole record, and its code as the tag', async () => {
    const { client, written } = stub();
    await recordProjectLanguages(
      client,
      { id: 'p1', config: {} },
      {
        object: {
          name: 'Spanish',
          glottocode: 'stan1288',
          iso639P3: 'spa',
          latitude: 40.1,
          longitude: -4.2,
        },
        meta: { name: 'English', iso639P3: 'eng' },
      },
    );
    expect(value(written).object).toEqual({
      name: 'Spanish',
      glottocode: 'stan1288',
      iso639P3: 'spa',
      tag: 'spa',
      latitude: 40.1,
      longitude: -4.2,
    });
    expect(value(written).meta).toMatchObject({ name: 'English', tag: 'eng' });
  });

  it('is a first record, never a correction', async () => {
    const { client, written } = stub();
    const project = { id: 'p1', config: { igt: { languages: { object: { tag: 'pmy' } } } } };
    expect(await recordProjectLanguages(client, project, { object: 'spa' })).toBe(false);
    expect(written).toEqual([]);
  });

  it('writes nothing when the source named nothing', async () => {
    const { client, written } = stub();
    const project = { id: 'p1', config: {} };
    expect(await recordProjectLanguages(client, project, { object: null, meta: null })).toBe(false);
    // A record whose every field is blank is nothing named, not a language.
    expect(
      await recordProjectLanguages(client, project, { object: { name: '', glottocode: '' } }),
    ).toBe(false);
    expect(written).toEqual([]);
  });
});
