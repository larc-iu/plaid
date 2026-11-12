import { describe, it, expect } from 'vitest';
import {
  canEditProject,
  canManageProject,
  canReadProject,
  canManageVocabulary,
  canEditVocabularyEntries,
  canLinkVocabulary,
  canUnlinkVocabulary,
  canMoveVocabulary,
  isBorrowed,
  vocabularyRole,
  readOnlyReason,
  asDeletedDocument,
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

// A vocabulary's rights are its home project's roles (SPEC vocab-home section 1).
// The table is section 1's, route by route, for the people a screen can be:
// HM, HW, HR the maintainer, writer and reader of the home A; BM, BW, BR the
// same of B, which borrows the vocabulary and whose people hold no role in A;
// N a signed-in stranger; Ad an admin. `true` is the route's success status,
// `false` its 403. A state refusal (409: a borrower in the way, the home asked
// to unlink) is not a right, so a 409 cell is `true` where the person passes
// the gate and the screen shows core's refusal, except the home's own unlink,
// which no one can do and so no screen offers. The delegated token (S) is not
// a person on a screen and has no column here.
describe('vocabulary access, section 1 of the vocabulary home spec', () => {
  const A = { id: 'A', maintainers: ['hm'], writers: ['hw'], readers: ['hr'] };
  const B = { id: 'B', maintainers: ['bm'], writers: ['bw'], readers: ['br'] };
  // Where a move may go: maintained by the home's maintainer and by B's, so a
  // refusal is the home role's and not the target's.
  const T = { id: 'T', maintainers: ['hm', 'hw', 'bm', 'n'] };
  const vocab = { id: 'v', name: 'Lexicon', project: 'A' };
  const PEOPLE = {
    HM: as('hm'),
    HW: as('hw'),
    HR: as('hr'),
    BM: as('bm'),
    BW: as('bw'),
    BR: as('br'),
    N: as('n'),
    Ad: as('admin', true),
  };
  const COLUMNS = Object.keys(PEOPLE);
  const row = (cells) => Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i]]));
  const ok = true;
  const no = false;

  // [route, the question a screen asks, HM HW HR BM BW BR N Ad]
  const SECTION_1 = [
    // 1.1 vocabulary routes
    [
      'PATCH /vocab-layers/{id} (rename)',
      (u) => canManageVocabulary(vocab, A, u),
      [ok, no, no, no, no, no, no, ok],
    ],
    [
      'DELETE /vocab-layers/{id} (and dry run)',
      (u) => canManageVocabulary(vocab, A, u),
      [ok, no, no, no, no, no, no, ok],
    ],
    [
      'PUT, DELETE /vocab-layers/{id}/config',
      (u) => canManageVocabulary(vocab, A, u),
      [ok, no, no, no, no, no, no, ok],
    ],
    [
      'POST /vocab-layers/{id}/items/{item}/restore',
      (u) => canManageVocabulary(vocab, A, u),
      [ok, no, no, no, no, no, no, ok],
    ],
    [
      'GET /vocab-layers/{id}/borrowers',
      (u) => canManageVocabulary(vocab, A, u),
      [ok, no, no, no, no, no, no, ok],
    ],
    [
      'POST /vocab-layers/{id}/move to T',
      (u) => canMoveVocabulary(vocab, A, T, u),
      [ok, no, no, no, no, no, no, ok],
    ],
    [
      'POST /vocab-layers (create in A)',
      (u) => canManageProject(A, u),
      [ok, no, no, no, no, no, no, ok],
    ],
    // 1.2 entry routes
    [
      'POST /vocab-items, /bulk',
      (u) => canEditVocabularyEntries(vocab, A, u),
      [ok, ok, no, no, no, no, no, ok],
    ],
    [
      'PATCH /vocab-items/bulk, fields only',
      (u) => canEditVocabularyEntries(vocab, A, u),
      [ok, ok, no, no, no, no, no, ok],
    ],
    [
      'PUT, PATCH, DELETE /vocab-items/{id}/metadata',
      (u) => canEditVocabularyEntries(vocab, A, u),
      [ok, ok, no, no, no, no, no, ok],
    ],
    [
      'PATCH /vocab-items/{id} (form), bulk with a form',
      (u) => canManageVocabulary(vocab, A, u),
      [ok, no, no, no, no, no, no, ok],
    ],
    [
      'DELETE /vocab-items/{id}, /bulk',
      (u) => canManageVocabulary(vocab, A, u),
      [ok, no, no, no, no, no, no, ok],
    ],
    [
      'POST /vocab-items/{id}/merge',
      (u) => canManageVocabulary(vocab, A, u),
      [ok, no, no, no, no, no, no, ok],
    ],
    // 1.4 project routes
    [
      'POST /projects/B/vocabs/{id} (borrow into B)',
      (u) => canLinkVocabulary(vocab, A, B, u),
      [no, no, no, no, no, no, no, ok],
    ],
    [
      'DELETE /projects/B/vocabs/{id} (end B’s borrowing)',
      (u) => canUnlinkVocabulary(vocab, B, A, u),
      [ok, no, no, ok, no, no, no, ok],
    ],
    [
      'DELETE /projects/A/vocabs/{id} (the home: 409)',
      (u) => canUnlinkVocabulary(vocab, A, A, u),
      [no, no, no, no, no, no, no, no],
    ],
    [
      'DELETE /projects/A (409 while B borrows)',
      (u) => canManageProject(A, u),
      [ok, no, no, no, no, no, no, ok],
    ],
  ];

  describe.each(SECTION_1)('%s', (route, may, cells) => {
    const expected = row(cells);
    it.each(COLUMNS)('%s', (column) => {
      expect(may(PEOPLE[column])).toBe(expected[column]);
    });
  });

  // BM in section 1 holds no role in the home. One who does may borrow it: any
  // role there is enough.
  it('lets a maintainer of the borrowing project borrow with any role in the home', () => {
    const home = { ...A, readers: ['hr', 'bm'] };
    expect(canLinkVocabulary(vocab, home, B, as('bm'))).toBe(true);
    expect(canLinkVocabulary(vocab, home, B, as('bw'))).toBe(false);
    // The home's maintainer, who holds no role in B, may not borrow into it.
    expect(canLinkVocabulary(vocab, A, B, as('hm'))).toBe(false);
  });

  it('moves only between two projects the person maintains', () => {
    expect(canMoveVocabulary(vocab, A, B, as('hm'))).toBe(false);
    expect(canMoveVocabulary(vocab, A, null, as('hm'))).toBe(false);
  });

  it('gives each person their home role, an admin maintainer', () => {
    const roles = Object.fromEntries(COLUMNS.map((c) => [c, vocabularyRole(vocab, A, PEOPLE[c])]));
    expect(roles).toEqual({
      HM: 'maintainer',
      HW: 'writer',
      HR: 'reader',
      BM: null,
      BW: null,
      BR: null,
      N: null,
      Ad: 'maintainer',
    });
  });

  // A screen inside B passes no home for a vocabulary B borrows: read only
  // there, for everyone, an admin and the home's own maintainer included.
  it('answers no role without the home, or with another project as the home', () => {
    for (const column of COLUMNS) {
      const user = PEOPLE[column];
      expect(vocabularyRole(vocab, null, user)).toBe(null);
      expect(vocabularyRole(vocab, B, user)).toBe(null);
      expect(canManageVocabulary(vocab, null, user)).toBe(false);
      expect(canEditVocabularyEntries(vocab, B, user)).toBe(false);
    }
    expect(vocabularyRole(null, A, as('hm'))).toBe(null);
    expect(vocabularyRole(vocab, A, null)).toBe(null);
  });

  // An as-of read from before vocabularies had a project names none.
  it('answers no role for a vocabulary that names no project', () => {
    const past = { ...vocab, project: null };
    expect(vocabularyRole(past, A, as('hm'))).toBe(null);
    expect(vocabularyRole(past, A, as('admin', true))).toBe(null);
  });

  it('changes nothing through a home seen from a deleted document', () => {
    const home = asDeletedDocument(A);
    expect(vocabularyRole(vocab, home, as('hr'))).toBe('reader');
    expect(canManageVocabulary(vocab, home, as('hm'))).toBe(false);
    expect(canEditVocabularyEntries(vocab, home, as('hw'))).toBe(false);
  });

  it('tells a borrowed vocabulary from the project’s own', () => {
    expect(isBorrowed(vocab, A)).toBe(false);
    expect(isBorrowed(vocab, B)).toBe(true);
    expect(isBorrowed(null, A)).toBe(false);
  });

  it('no longer reads a maintainer list on the vocabulary', () => {
    const old = { id: 'v', maintainers: ['x'] };
    expect(canManageVocabulary(old, A, as('x'))).toBe(false);
  });
});

describe('why a document is read-only', () => {
  it('says reader access to a reader, and no access to someone with no role', () => {
    const p = { maintainers: ['m'], writers: ['w'], readers: ['r'] };
    expect(readOnlyReason(p, as('r'))).toBe('You have reader access to this project.');
    expect(readOnlyReason(p, as('gone'))).toBe('You no longer have access to this project.');
  });
});

describe('a deleted document', () => {
  it('is read-only for every role, an admin included, and says it was deleted', () => {
    const p = asDeletedDocument({ maintainers: ['m'], writers: ['w'], readers: ['r'] });
    for (const user of [as('m'), as('w'), as('r'), as('x', true)]) {
      expect(canEditProject(p, user)).toBe(false);
      expect(canManageProject(p, user)).toBe(false);
      expect(readOnlyReason(p, user)).toBe('This document was deleted.');
    }
    expect(canReadProject(p, as('r'))).toBe(true);
  });
});
