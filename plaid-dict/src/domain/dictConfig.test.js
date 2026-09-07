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
    expect(readDictRecord({ igt: { dictionary: true } })).toBeNull();
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
  const fakeClient = () => {
    const calls = [];
    return {
      calls,
      withOperation: (message, fn) => {
        calls.push(['operation', message]);
        return fn();
      },
      vocabLayers: {
        setConfig: (id, ns, key, value) => calls.push(['set', id, ns, key, value]),
        deleteConfig: (id, ns, key) => calls.push(['delete', id, ns, key]),
      },
    };
  };

  it('writes every key under one operation, removing the empty ones', async () => {
    const client = fakeClient();
    await saveDictRecord(client, 'v1', { title: 'Sena Dictionary', slug: 'sena', about: '' });

    expect(client.calls[0]).toEqual(['operation', 'Set up dictionary "Sena Dictionary"']);
    const written = client.calls.filter(([kind]) => kind === 'set').map(([, , , key]) => key);
    const removed = client.calls.filter(([kind]) => kind === 'delete').map(([, , , key]) => key);
    // `languages` and `exampleLayers` are not strings, so they are always
    // written; the blank strings are removed. An empty exampleLayers is a
    // choice (show no layer) and must not read back as "not chosen".
    expect(written).toEqual(['title', 'slug', 'languages', 'exampleLayers']);
    expect(removed).toEqual(['credits', 'citation', 'about']);
    expect(client.calls.find(([, , , key]) => key === 'exampleLayers')[4]).toEqual([]);
    expect(client.calls.every((c) => c[0] === 'operation' || c[2] === DICT_NAMESPACE)).toBe(true);
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
