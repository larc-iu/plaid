// Which of the vocabularies a user can see are dictionaries, and which ones
// they could turn into dictionaries.

import { canManageVocabulary } from '@ui/domain/permissions.js';
import { isDictionary, readDictRecord, dictTitle } from './dictConfig.js';

/**
 * Whether `user` may set up or edit the dictionary of `vocab`: a publication
 * record is the vocabulary's settings, so a maintainer of its project (its
 * home, found among `projects`, the user's `projects.list()`) or an admin.
 */
export const canManageDictionary = (vocab, projects, user) =>
  canManageVocabulary(vocab, (projects || []).find((p) => p.id === vocab?.project) ?? null, user);

/**
 * The vocabulary list split for the landing screen: the dictionaries anyone
 * here can read, and the vocabularies this user may set up that have no
 * publication record yet. Both sorted by the name shown.
 */
export const classifyVocabularies = (vocabs, projects, user) => {
  const dictionaries = [];
  const unpublished = [];
  for (const v of vocabs || []) {
    if (isDictionary(v)) dictionaries.push(v);
    else if (canManageDictionary(v, projects, user)) unpublished.push(v);
  }
  const byName = (a, b) => dictTitle(a).localeCompare(dictTitle(b));
  return { dictionaries: dictionaries.sort(byName), unpublished: unpublished.sort(byName) };
};

/** The dictionary a slug names, or null. */
export const findBySlug = (vocabs, slug) =>
  (vocabs || []).find((v) => readDictRecord(v.config)?.slug === slug) || null;

/**
 * The slugs already spoken for, ignoring one vocabulary (the one being edited).
 * Only covers what this user can read, which is as far as the check can go
 * until the public routes exist.
 */
export const takenSlugs = (vocabs, exceptId) =>
  (vocabs || [])
    .filter((v) => v.id !== exceptId)
    .map((v) => readDictRecord(v.config)?.slug)
    .filter(Boolean);
