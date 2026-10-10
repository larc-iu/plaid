import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../contexts/useAuth.js';
import { statusOf } from '../lib/errors.js';
import { useLatestCall } from './useLatestCall.js';

/**
 * The project the route names (`:projectId`), read when the id changes and
 * again on `reload()`, for a project screen.
 *
 * One route component serves every project id, so walking from A to B starts
 * a second read without ending the first and A can answer last. Only the
 * newest read is ever put on screen (useLatestCall).
 *
 * Options:
 * - `withDocuments`: also the project's document listing, as `documents`.
 *   `'optional'` reads a listing that fails as none, where `true` fails the
 *   read.
 * - `logoutOnAuthError`: a read refused as signed out (401, or no client)
 *   signs the reader out, so the login page does not bounce back, and is no
 *   `error`.
 *
 * Returns `{ projectId, project, documents, loading, error, reload }`.
 * `project` and `documents` are the route's project as the last good read
 * of it gave them, so a project the reader left never stands under the next
 * one's id, and a read again keeps the screen as it was until it answers.
 * `error` is the last read's failure, for this project only, or null.
 * `loading` is true while a read runs, and while the route's project has
 * neither been read nor failed (the render after the id changes, before its
 * read starts).
 * `reload({ quiet })` reads again and answers the project, or null; `quiet`
 * leaves `loading` alone, so the screen stays as it is meanwhile.
 */
export const useProject = ({ withDocuments = false, logoutOnAuthError = false } = {}) => {
  const { projectId } = useParams();
  const { getClient, logout } = useAuth();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(null);
  const begin = useLatestCall();

  // Keyed on the project only: getClient's and logout's identities change on
  // every AuthProvider render but do the same.
  const reload = useCallback(
    async ({ quiet = false } = {}) => {
      const isCurrent = begin();
      try {
        if (!quiet) setLoading(true);
        const client = getClient();
        if (!client) throw Object.assign(new Error('Not authenticated'), { status: 401 });
        const listing = !withDocuments
          ? null
          : withDocuments === 'optional'
            ? client.projects.listDocuments(projectId).catch(() => [])
            : client.projects.listDocuments(projectId);
        const [data, docs] = await Promise.all([client.projects.get(projectId), listing]);
        if (!isCurrent()) return null;
        setProject(data);
        setDocuments(docs || []);
        setFailed(null);
        return data;
      } catch (err) {
        if (!isCurrent()) return null;
        if (logoutOnAuthError && statusOf(err) === 401) {
          logout();
          return null;
        }
        console.error('Failed to load the project:', err);
        setFailed({ projectId, err });
        return null;
      } finally {
        if (isCurrent() && !quiet) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, withDocuments, logoutOnAuthError, begin],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  const current = project?.id === projectId ? project : null;
  const error = failed?.projectId === projectId ? failed.err : null;
  return {
    projectId,
    project: current,
    documents: current ? documents : [],
    loading: loading || (!current && !error),
    error,
    reload,
  };
};
