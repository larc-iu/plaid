import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { finishImport } from '@/domain/importFinish';
import { notifyError, notifyWarning } from '@/utils/feedback';
import { NOT_IN_FORCE_TITLE } from '@/components/projects/settings/refusedValues';

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
 * enough: it puts IGT's rules in force as the import's end would, drops the
 * record and opens the project. `resumeProject` is the
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
      description: 'What the import did not reach is missing.',
      confirmLabel: 'Use it',
    });
    if (!ok) return;
    const { cleared, warnings } = await finishImport(client, resumeId);
    if (warnings.length) notifyWarning(warnings.join(' '), NOT_IN_FORCE_TITLE);
    if (!cleared) {
      notifyError('The import record could not be cleared.', 'Failed to finish the import');
      // What the record says now: an archive import that began ending is
      // only ended again.
      client.projects
        .get(resumeId)
        .then((p) => setResumeProject(p ?? null))
        .catch(() => {});
      return;
    }
    navigate(`/projects/${resumeId}`, { replace: true });
  };

  return { resumeId, resumeName, resumeProject, finishAsIs };
}
