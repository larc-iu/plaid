import { describe, it, expect } from 'vitest';
import {
  DICT_NAMESPACE,
  dictCollator,
  dictTitle,
  isDictionary,
  readDictRecord,
  saveDictRecord,
  slugify,
  validateSetup,
} from './dictConfig.js';

const withDict = (dict) => ({ config: { dict }, name: 'Sena lexicon' });

describe('readDictRecord', () => {
  it('is null for a vocabulary that has no record', () => {
    expect(readDictRecord({})).toBeNull();
    expect(readDictRecord(undefined)).toBeNull();
    expect(readDictRecord({ igt: { fields: {} } })).toBeNull();
  });

  it('fills in every key, trimming strings and normalizing languages', () => {
    const record = readDictRecord({
      dict: {
        title: '  Sena Dictionary ',
        slug: 'sena',
        languages: { object: { name: ' Sena ' } },
      },
    });
    expect(record.title).toBe('Sena Dictionary');
    expect(record.languages.object.name).toBe('Sena');
    expect(record.languages.object.latitude).toBeNull();
    expect(record.languages.meta.name).toBe('');
    expect(record.about).toBe('');
  });

  it('reads a stated alphabet, and nothing when there is none', () => {
    expect(readDictRecord({ dict: { slug: 'x' } }).alphabet).toEqual([]);
    expect(readDictRecord({ dict: { slug: 'x', alphabet: ['a', 'ch', ' ', 3] } }).alphabet).toEqual(
      ['a', 'ch'],
    );
  });

  it('tells a dictionary that chose no layers from one that has not chosen', () => {
    expect(readDictRecord({ dict: { slug: 'x' } }).exampleLayers).toBeNull();
    expect(readDictRecord({ dict: { slug: 'x', exampleLayers: [] } }).exampleLayers).toEqual([]);
    expect(
      readDictRecord({ dict: { slug: 'x', exampleLayers: ['Translation', ' ', 7] } }).exampleLayers,
    ).toEqual(['Translation']);
  });
});

describe('isDictionary', () => {
  it('turns on the slug, not the record', () => {
    expect(isDictionary(withDict({ title: 'Sena Dictionary' }))).toBe(false);
    expect(isDictionary(withDict({ title: 'Sena Dictionary', slug: 'sena' }))).toBe(true);
  });
});

describe('dictTitle', () => {
  it('falls back to the vocabulary name', () => {
    expect(dictTitle(withDict({ slug: 'sena' }))).toBe('Sena lexicon');
    expect(dictTitle(withDict({ slug: 'sena', title: 'Sena Dictionary' }))).toBe('Sena Dictionary');
  });
});

describe('slugify', () => {
  it('lowercases, strips accents, and hyphenates', () => {
    expect(slugify('Sena Dictionary')).toBe('sena-dictionary');
    expect(slugify('Diccionário Xituva!')).toBe('diccionario-xituva');
    expect(slugify('  --  ')).toBe('');
  });
});

describe('validateSetup', () => {
  const ok = { title: 'Sena Dictionary', slug: 'sena' };

  it('accepts a filled-in record', () => {
    expect(validateSetup(ok, ['other'])).toEqual({});
  });

  it('requires a title and a slug', () => {
    expect(validateSetup({ title: '  ', slug: '' })).toEqual({
      title: 'Required.',
      slug: 'Required.',
    });
  });

  it('rejects a slug that is not URL-shaped', () => {
    expect(validateSetup({ ...ok, slug: 'Sena Dictionary' }).slug).toMatch(/Lowercase/);
    expect(validateSetup({ ...ok, slug: '-sena' }).slug).toMatch(/Lowercase/);
    expect(validateSetup({ ...ok, slug: 'sena-2' })).toEqual({});
  });

  it('rejects a slug another dictionary already uses', () => {
    expect(validateSetup(ok, ['sena']).slug).toMatch(/Already used/);
  });
});

describe('saveDictRecord', () => {
  // Writes are recorded only when made on a batch, and each batch is
  // recorded when it is sent.
  const fakeClient = () => {
    const calls = [];
    return {
      calls,
      withOperation: (message, fn) => {
        calls.push(['operation', message]);
        return fn();
      },
      batched: async (fn) => {
        await fn({
          vocabLayers: {
            setConfig: (id, ns, key, value, _audit, options) =>
              calls.push(['set', id, ns, key, value, options]),
            deleteConfig: (id, ns, key, _audit, options) =>
              calls.push(['delete', id, ns, key, options]),
          },
        });
        calls.push(['batch sent']);
      },
    };
  };

  it('writes a new record under one operation, leaving out the empty keys', async () => {
    const client = fakeClient();
    await saveDictRecord(client, 'v1', { title: 'Sena Dictionary', slug: 'sena', about: '' });

    expect(client.calls[0]).toEqual(['operation', 'Set up dictionary "Sena Dictionary"']);
    const written = client.calls.filter(([kind]) => kind === 'set').map(([, , , key]) => key);
    const removed = client.calls.filter(([kind]) => kind === 'delete').map(([, , , key]) => key);
    // `languages` and `alphabet` are never strings, so a new record writes
    // them. A blank key has nothing stored to remove.
    expect(written).toEqual(['title', 'slug', 'languages', 'alphabet']);
    expect(removed).toEqual([]);
    expect(
      client.calls.every(
        (c) => ['operation', 'batch sent'].includes(c[0]) || c[2] === DICT_NAMESPACE,
      ),
    ).toBe(true);
    // One request, sent last.
    expect(client.calls.filter(([kind]) => kind === 'batch sent')).toHaveLength(1);
    expect(client.calls.at(-1)).toEqual(['batch sent']);
  });

  // A page opened before someone else saved the record wrote every key from
  // its copy, putting their changes back (V6). Only the keys the draft changed
  // are written, each expecting what the page read.
  it('writes only the changed keys, expecting what the page read', async () => {
    const loaded = {
      [DICT_NAMESPACE]: { title: 'Sena', slug: 'sena', about: 'Old', alphabet: ['a'] },
    };
    const draft = { title: 'Sena', slug: 'sena', about: '', credits: 'Me', alphabet: ['a'] };
    const client = fakeClient();
    await saveDictRecord(client, 'v1', draft, { loaded });
    const touched = client.calls.filter(([kind]) => kind !== 'operation');
    expect(touched).toEqual([
      ['set', 'v1', DICT_NAMESPACE, 'credits', 'Me', { expected: undefined }],
      ['delete', 'v1', DICT_NAMESPACE, 'about', { expected: 'Old' }],
      ['batch sent'],
    ]);
  });

  // An empty exampleLayers is a choice (show no layer) and must not read back
  // as "not chosen", so it is written, where an unmade choice is removed.
  it('writes a chosen-none example layer list and removes an unmade choice', async () => {
    const client = fakeClient();
    await saveDictRecord(client, 'v1', { title: 'T', slug: 't', exampleLayers: [] });
    expect(client.calls.find(([, , , key]) => key === 'exampleLayers').slice(0, 1)).toEqual([
      'set',
    ]);
    expect(client.calls.find(([, , , key]) => key === 'exampleLayers')[4]).toEqual([]);
    const none = fakeClient();
    await saveDictRecord(
      none,
      'v1',
      { title: 'T', slug: 't', exampleLayers: null },
      { loaded: { [DICT_NAMESPACE]: { title: 'T', slug: 't', exampleLayers: ['x'] } } },
    );
    expect(none.calls.find(([, , , key]) => key === 'exampleLayers')[0]).toBe('delete');
  });

  it('takes the label the caller passes', async () => {
    const client = fakeClient();
    await saveDictRecord(client, 'v1', { title: 'X', slug: 'x' }, { label: 'Update dictionary' });
    expect(client.calls[0]).toEqual(['operation', 'Update dictionary']);
  });
});

describe('dictCollator', () => {
  it('sorts by the object language when it has an ISO code', () => {
    const collator = dictCollator({ languages: { object: { iso639P3: 'seh' } } });
    expect(collator.compare('a', 'b')).toBeLessThan(0);
  });

  it('falls back when there is no code', () => {
    expect(dictCollator(null).compare('b', 'a')).toBeGreaterThan(0);
  });
});
