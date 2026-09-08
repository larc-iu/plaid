import { describe, it, expect } from 'vitest';
import { canManage, classifyVocabularies, findBySlug, takenSlugs } from './dictionaries.js';

const vocab = (id, { name = id, dict = null, maintainers = [] } = {}) => ({
  id,
  name,
  maintainers,
  config: { ...(dict ? { dict } : {}) },
});

const luke = { id: 'luke@example.org', isAdmin: false };
const admin = { id: 'root@example.org', isAdmin: true };

describe('canManage', () => {
  it('is maintainership, or admin', () => {
    expect(canManage(vocab('v', { maintainers: [luke.id] }), luke)).toBe(true);
    expect(canManage(vocab('v'), luke)).toBe(false);
    expect(canManage(vocab('v'), admin)).toBe(true);
    expect(canManage(vocab('v'), null)).toBe(false);
  });
});

describe('classifyVocabularies', () => {
  const vocabs = [
    vocab('published', { name: 'Zulu', dict: { slug: 'zulu', title: 'Zulu Dictionary' } }),
    vocab('other', { name: 'Aja', dict: { slug: 'aja' } }),
    vocab('mine', { name: 'Sena', maintainers: [luke.id] }),
    vocab('theirs', { name: 'Bemba' }),
  ];

  it('lists every readable dictionary, whoever maintains it', () => {
    const { dictionaries } = classifyVocabularies(vocabs, luke);
    expect(dictionaries.map((v) => v.id)).toEqual(['other', 'published']);
  });

  it('offers setup only for the vocabularies this user maintains', () => {
    expect(classifyVocabularies(vocabs, luke).unpublished.map((v) => v.id)).toEqual(['mine']);
    expect(classifyVocabularies(vocabs, admin).unpublished.map((v) => v.id)).toEqual([
      'theirs',
      'mine',
    ]);
  });

  it('sorts by the name shown, which is the title when there is one', () => {
    // "Aja" (no title, so the vocabulary name) before "Zulu Dictionary".
    expect(classifyVocabularies(vocabs, luke).dictionaries.map((v) => v.name)).toEqual([
      'Aja',
      'Zulu',
    ]);
  });
});

describe('findBySlug / takenSlugs', () => {
  const vocabs = [
    vocab('a', { dict: { slug: 'sena' } }),
    vocab('b', { dict: { slug: 'zulu' } }),
    vocab('c', { lexicography: true }),
  ];

  it('resolves a slug to its vocabulary', () => {
    expect(findBySlug(vocabs, 'zulu').id).toBe('b');
    expect(findBySlug(vocabs, 'nope')).toBeNull();
  });

  it('leaves out the vocabulary being edited', () => {
    expect(takenSlugs(vocabs)).toEqual(['sena', 'zulu']);
    expect(takenSlugs(vocabs, 'a')).toEqual(['zulu']);
  });
});
