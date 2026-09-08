import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useConfirm } from '@/components/shared/ConfirmProvider';
import { markImportFinished } from '@/domain/igtConfig';
import { notifyError } from '@/utils/feedback';

/**
 * The project an import is being run over again, named by `?resume=<id>` on an
 * import route, plus its name once it has been read and the way out of it.
 *
 * A project whose import never finished carries a record of it (see
 * `readImportState`) and sends its maintainers here rather than opening: the
 * resume deletes and redoes the documents it did not complete, so there is
 * nothing safe to do in the project until it is over. Every importer writes
 * into an existing project when it is given one: project setup returns early
 * for a project already set up, the documents already done are skipped, and
 * the lexicon's structure is filled in for the entries still missing it.
 *
 * `finishAsIs` is the other way out, for a partial import somebody decides is
 * enough: it drops the record and opens the project. `resumeProject` is the
 * project as read, for what the record names (the lexicon it writes into).
 */
export function useResumeImport(client) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const resumeId = params.get('resume');
  const [resumeProject, setResumeProject] = useState(null);
  const resumeName = resumeProject?.name ?? null;
  useEffect(() => {
    if (!resumeId) return undefined;
    let alive = true;
    client.projects
      .get(resumeId)
      .then((p) => {
        if (alive) setResumeProject(p ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, resumeId]);

  const finishAsIs = async () => {
    if (!resumeId) return;
    const ok = await confirm({
      title: 'Use the project as it is?',
      description: 'What the import did not reach stays missing.',
      confirmLabel: 'Use it',
    });
    if (!ok) return;
    if (!(await markImportFinished(client, resumeId))) {
      notifyError('The import record could not be cleared.', 'Not finished');
      return;
    }
    navigate(`/projects/${resumeId}`, { replace: true });
  };

  return { resumeId, resumeName, resumeProject, finishAsIs };
}
