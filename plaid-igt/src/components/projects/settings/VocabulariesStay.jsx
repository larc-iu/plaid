import { Fragment, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext.jsx';

// "A", "A and B", "A, B and C", each name in bold.
const nameList = (vocabs) =>
  vocabs.map((v, i) => (
    <Fragment key={v.id}>
      {i === 0 ? '' : i === vocabs.length - 1 ? ' and ' : ', '}
      <strong className="font-text text-foreground" dir="auto">
        {v.name}
      </strong>
    </Fragment>
  ));

/**
 * What the Delete project confirm says of the project's vocabularies (H1-5,
 * M2-5): deleting a project leaves every vocabulary it uses, entries and all,
 * under Vocabularies. It names them, and says that no other project uses them
 * only of the ones it can know that of. An admin lists every project, so for
 * an admin a vocabulary no other project names is one no other project uses.
 * Anyone else lists only the projects they can read, so nothing is said of
 * other projects. Nothing for a project with no vocabulary.
 */
export const VocabulariesStay = ({ project, client }) => {
  const { user } = useAuth();
  const vocabs = project?.vocabs || [];
  const isAdmin = !!user?.isAdmin;
  // The ids of this project's vocabularies some other project uses, null
  // until known.
  const [usedElsewhere, setUsedElsewhere] = useState(null);

  useEffect(() => {
    if (!isAdmin || !vocabs.length || !client) return undefined;
    let cancelled = false;
    client.projects
      .list()
      .then((projects) => {
        const used = new Set();
        for (const p of projects || []) {
          if (p.id === project.id) continue;
          for (const v of p.vocabs || []) used.add(v.id);
        }
        if (!cancelled) setUsedElsewhere(used);
      })
      .catch((err) => console.error('Could not list projects:', err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, client, project?.id]);

  if (!vocabs.length) return null;
  const one = vocabs.length === 1;
  const unused = usedElsewhere ? vocabs.filter((v) => !usedElsewhere.has(v.id)) : [];
  return (
    <>
      {one ? 'The vocabulary ' : 'The vocabularies '}
      {nameList(vocabs)}
      {one
        ? ' stays under Vocabularies with all its entries.'
        : ' stay under Vocabularies with all their entries.'}
      {unused.length === vocabs.length ? (
        <> No other project uses {one ? 'it' : 'them'}.</>
      ) : unused.length ? (
        <> No other project uses {nameList(unused)}.</>
      ) : null}
    </>
  );
};
