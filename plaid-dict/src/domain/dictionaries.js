// Which of the vocabularies a user can see are dictionaries, and which ones
// they could turn into dictionaries.

import { readDictionaryEnabled } from '@igt/domain/vocabDictionary.js';
import { isDictionary, readDictRecord, dictTitle } from './dictConfig.js';

/** Whether a user may write a vocabulary's publication record. */
export const canManage = (vocab, user) =>
  !!(user?.isAdmin || (user?.id && vocab?.maintainers?.includes(user.id)));

/**
 * The vocabulary list split for the landing screen: the dictionaries anyone
 * here can read, and the Lexicography Mode vocabularies this user maintains
 * that have no publication record yet. Both sorted by the name shown.
 */
export const classifyVocabularies = (vocabs, user) => {
  const dictionaries = [];
  const unpublished = [];
  for (const v of vocabs || []) {
    if (isDictionary(v)) dictionaries.push(v);
    else if (readDictionaryEnabled(v.config) && canManage(v, user)) unpublished.push(v);
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
