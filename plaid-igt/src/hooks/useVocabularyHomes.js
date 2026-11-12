import { useEffect, useState } from 'react';
import { statusOf } from '@ui/lib/errors.js';

// A vocabulary's rights are the person's role in its home project, wherever
// they stand (SPEC 1.2): a maintainer of the home who works in a project that
// borrows the vocabulary still adds, edits and renames its entries there. A
// screen inside a project has that project for its own vocabularies, and
// reads here the home of each one it borrows, as the vocabulary page reads
// its own: the project with its role lists, or null when this person cannot
// read it (403), which is no role.

const borrowedHomeIds = (project) =>
  [
    ...new Set(
      (project?.vocabs || []).map((v) => v.project).filter((id) => id && id !== project?.id),
    ),
  ].sort();

const readHome = (client, id) =>
  client.projects.get(id).catch((err) => {
    if (statusOf(err) !== 403) console.error('Error reading a vocabulary’s project:', err);
    return null;
  });

const NONE = new Map();

/**
 * The homes of the vocabularies `project` borrows, as a Map from project id
 * to the project read with its role lists (null where it cannot be read).
 * Empty until read, so a borrowed vocabulary answers no role until then.
 */
export const useVocabularyHomes = (client, project) => {
  const ids = borrowedHomeIds(project);
  const key = ids.join(' ');
  const [read, setRead] = useState({ key: '', homes: NONE });
  useEffect(() => {
    if (!client || !key) return undefined;
    let alive = true;
    const wanted = key.split(' ');
    Promise.all(wanted.map((id) => readHome(client, id))).then((projects) => {
      if (alive) setRead({ key, homes: new Map(wanted.map((id, i) => [id, projects[i]])) });
    });
    return () => {
      alive = false;
    };
  }, [client, key]);
  return read.key === key ? read.homes : NONE;
};

/**
 * The home of `vocabulary` as this person has it, for the permission helpers
 * of plaid-ui: `project` itself for one of its own, else the home read by
 * useVocabularyHomes, else null.
 */
export const vocabularyHome = (vocabulary, project, homes) => {
  if (!vocabulary?.project) return null;
  if (vocabulary.project === project?.id) return project;
  return homes?.get(vocabulary.project) ?? null;
};
