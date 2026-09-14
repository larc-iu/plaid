import { describe, it, expect } from 'vitest';
import {
  canEditProject,
  canManageProject,
  canReadProject,
  canManageVocabulary,
} from './permissions.js';

// What each grant means, in the one place that decides it. The document editor
// used to walk the three ACL arrays itself and answered "not read-only" for a
// user with no access at all, because it asked whether they could READ and then
// whether they could write, instead of asking once.

const project = { maintainers: ['m'], writers: ['w'], readers: ['r'] };
const as = (id, isAdmin = false) => ({ id, isAdmin });

describe('project access', () => {
  it('lets a maintainer manage, edit and read', () => {
    expect(canManageProject(project, as('m'))).toBe(true);
    expect(canEditProject(project, as('m'))).toBe(true);
    expect(canReadProject(project, as('m'))).toBe(true);
  });

  it('lets a writer edit and read but not manage', () => {
    expect(canManageProject(project, as('w'))).toBe(false);
    expect(canEditProject(project, as('w'))).toBe(true);
    expect(canReadProject(project, as('w'))).toBe(true);
  });

  it('lets a reader only read', () => {
    expect(canManageProject(project, as('r'))).toBe(false);
    expect(canEditProject(project, as('r'))).toBe(false);
    expect(canReadProject(project, as('r'))).toBe(true);
  });

  it('refuses all three to a stranger', () => {
    expect(canManageProject(project, as('x'))).toBe(false);
    expect(canEditProject(project, as('x'))).toBe(false);
    expect(canReadProject(project, as('x'))).toBe(false);
  });

  it('gives an admin all three without being listed', () => {
    const admin = as('x', true);
    expect(canManageProject(project, admin)).toBe(true);
    expect(canEditProject(project, admin)).toBe(true);
    expect(canReadProject(project, admin)).toBe(true);
  });

  it('answers false for a missing project or a signed-out reader', () => {
    for (const fn of [canManageProject, canEditProject, canReadProject]) {
      expect(fn(null, as('m'))).toBe(false);
      expect(fn(project, null)).toBe(false);
      expect(fn(undefined, undefined)).toBe(false);
    }
  });

  it('does not take an id it was never given as membership', () => {
    // A project whose arrays are absent, and a user with no id: neither may
    // match the other through `undefined`.
    expect(canReadProject({}, as(undefined))).toBe(false);
    expect(canReadProject({ readers: [undefined] }, as(undefined))).toBe(false);
  });
});

describe('vocabulary access', () => {
  const vocab = { maintainers: ['m'] };

  it('is the vocabulary’s own maintainer list, not a project’s', () => {
    expect(canManageVocabulary(vocab, as('m'))).toBe(true);
    expect(canManageVocabulary(vocab, as('w'))).toBe(false);
    expect(canManageVocabulary(project, as('w'))).toBe(false);
  });

  it('includes admins, and nobody else', () => {
    expect(canManageVocabulary(vocab, as('x', true))).toBe(true);
    expect(canManageVocabulary(vocab, as('x'))).toBe(false);
    expect(canManageVocabulary(null, as('m'))).toBe(false);
    expect(canManageVocabulary(vocab, null)).toBe(false);
  });
});
