import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notifyError } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';
import { deleteConversation, jobFor, readMetas, upsert } from './jobs.js';

// The saved conversations behind whichever surface is showing one: the rows,
// how wide the read reaches, the names of the other projects a row may belong
// to, and deleting one.
//
// It also builds the `store` the record layer takes, since everything here is
// a read or a write through it and the chat needs the same one.
export const useConversationList = ({ client, userId, app, projectId, onRemoved }) => {
  // Everything the record layer needs, in one object: which app's keys to
  // write under, whose store, and which project.
  const store = useMemo(
    () => ({ client, userId, app, projectId }),
    [client, userId, app, projectId],
  );
  const [rows, setRows] = useState([]); // sidebar metas, newest first
  const [loading, setLoading] = useState(true);
  // Whether the list reaches past this project. Off by default, so nothing
  // changes for a reader who never asks: the common case is looking for a
  // thread about what is in front of them. On, for the reader who knows they
  // discussed something and not which project it was in.
  const [allProjects, setAllProjects] = useState(false);
  const [projectNames, setProjectNames] = useState(new Map());

  const reload = useCallback(async () => {
    if (!store.userId) return [];
    setLoading(true);
    try {
      const metas = await readMetas(store, { allProjects });
      setRows(metas);
      return metas;
    } catch (e) {
      console.error('[Assistant] could not load conversations', e);
      notifyError(humanizeError(e, 'Past conversations could not be loaded.'));
      return [];
    } finally {
      setLoading(false);
    }
  }, [store, allProjects]);

  // The names of the OTHER projects a listed conversation belongs to. Asked for
  // only once the reader widens the list, because it is a call this screen has
  // no other reason to make.
  useEffect(() => {
    if (!allProjects || !client) return undefined;
    let alive = true;
    client.projects
      .list()
      .then((all) => {
        if (alive) setProjectNames(new Map((all || []).map((pr) => [pr.id, pr.name])));
      })
      .catch(() => {
        // Without the names a row still lists and still links. It just cannot
        // say which project it is in, which is better than not listing it.
        if (alive) setProjectNames(new Map());
      });
    return () => {
      alive = false;
    };
  }, [allProjects, client]);

  // An entry after a write, back in its place in the list.
  const applyMeta = useCallback((meta) => setRows(upsert(meta)), []);

  const removedRef = useRef(onRemoved);
  removedRef.current = onRemoved;

  // `m` is the WHOLE row, because a row from another project is deleted under
  // that project's keys and only the row knows which.
  const remove = useCallback(
    async (m) => {
      const j = jobFor(m.id);
      if (j) {
        notifyError(
          j.done
            ? 'That conversation is still being saved.'
            : j.kind === 'apply'
              ? 'That conversation is still applying changes.'
              : 'That conversation is still waiting for an answer.',
        );
        return;
      }
      try {
        await deleteConversation(store, m);
        setRows((prev) => prev.filter((row) => row.id !== m.id));
        removedRef.current?.(m.id);
      } catch (e) {
        notifyError(humanizeError(e, 'The conversation could not be deleted.'));
      }
    },
    [store],
  );

  return {
    store,
    rows,
    loading,
    allProjects,
    setAllProjects,
    projectNames,
    reload,
    applyMeta,
    remove,
  };
};
