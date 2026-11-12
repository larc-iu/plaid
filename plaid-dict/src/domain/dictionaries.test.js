import { describe, it, expect } from 'vitest';
import {
  canManageDictionary,
  classifyVocabularies,
  findBySlug,
  takenSlugs,
} from './dictionaries.js';

const vocab = (id, { name = id, dict = null, project = 'home' } = {}) => ({
  id,
  name,
  project,
  config: { ...(dict ? { dict } : {}) },
});

const luke = { id: 'luke@example.org', isAdmin: false };
const admin = { id: 'root@example.org', isAdmin: true };

// The projects as `projects.list()` gives them, with their role lists.
const project = (id, roles = {}) => ({
  id,
  name: id,
  maintainers: [],
  writers: [],
  readers: [],
  ...roles,
});

describe('who may write a publication record', () => {
  // A dictionary is its vocabulary's settings, so it is the home project's
  // maintainers' (and an admin's) to set up and edit.
  const v = vocab('v', { project: 'home' });

  it('is a maintainer of the vocabulary’s project, or an admin', () => {
    expect(canManageDictionary(v, [project('home', { maintainers: [luke.id] })], luke)).toBe(true);
    expect(canManageDictionary(v, [project('home')], admin)).toBe(true);
  });

  it('is not a writer or reader there', () => {
    expect(canManageDictionary(v, [project('home', { writers: [luke.id] })], luke)).toBe(false);
    expect(canManageDictionary(v, [project('home', { readers: [luke.id] })], luke)).toBe(false);
  });

  it('is not a maintainer of a project that only links it', () => {
    // luke maintains B, which borrows the vocabulary, and cannot read its home.
    expect(canManageDictionary(v, [project('B', { maintainers: [luke.id] })], luke)).toBe(false);
  });

  it('is nobody signed out, or before the projects are read', () => {
    expect(canManageDictionary(v, [project('home', { maintainers: [luke.id] })], null)).toBe(false);
    expect(canManageDictionary(v, [], luke)).toBe(false);
    expect(canManageDictionary(v, null, luke)).toBe(false);
  });
});

describe('classifyVocabularies', () => {
  const projects = [
    project('mineP', { maintainers: [luke.id] }),
    project('writeP', { writers: [luke.id] }),
    project('theirsP'),
  ];
  const vocabs = [
    vocab('published', {
      name: 'Zulu',
      dict: { slug: 'zulu', title: 'Zulu Dictionary' },
      project: 'theirsP',
    }),
    vocab('other', { name: 'Aja', dict: { slug: 'aja' }, project: 'theirsP' }),
    vocab('mine', { name: 'Sena', project: 'mineP' }),
    vocab('written', { name: 'Chewa', project: 'writeP' }),
    vocab('theirs', { name: 'Bemba', project: 'theirsP' }),
    // Any vocabulary counts, not only one that looked like a dictionary
    // already: plaid-igt has no such distinction to make any more.
    vocab('plain', { name: 'A tagset', project: 'mineP' }),
  ];

  it('lists every readable dictionary, whoever maintains it', () => {
    const { dictionaries } = classifyVocabularies(vocabs, projects, luke);
    expect(dictionaries.map((v) => v.id)).toEqual(['other', 'published']);
  });

  it('offers setup for every vocabulary of a project this user maintains', () => {
    expect(classifyVocabularies(vocabs, projects, luke).unpublished.map((v) => v.id)).toEqual([
      'plain',
      'mine',
    ]);
    expect(classifyVocabularies(vocabs, projects, admin).unpublished.map((v) => v.id)).toEqual([
      'plain',
      'theirs',
      'written',
      'mine',
    ]);
  });

  it('sorts by the name shown, which is the title when there is one', () => {
    // "Aja" (no title, so the vocabulary name) before "Zulu Dictionary".
    expect(classifyVocabularies(vocabs, projects, luke).dictionaries.map((v) => v.name)).toEqual([
      'Aja',
      'Zulu',
    ]);
  });
});

describe('findBySlug / takenSlugs', () => {
  const vocabs = [
    vocab('a', { dict: { slug: 'sena' } }),
    vocab('b', { dict: { slug: 'zulu' } }),
    vocab('c'),
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
