import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';
import { Button } from '@ui/components/ui/button';
import { DeleteProjectDialog } from '@ui/components/shared/DeleteProjectDialog.jsx';
import { DELETE_BUTTON_CLASS } from '@ui/lib/destructive.js';
import { countOf } from '@ui/lib/plural.js';
import { notifyError, notifySuccess } from '@/utils/feedback';
import { importRanWhole, markImportFinished, readImportState } from '@/domain/igtConfig';

// A vocabulary's name, or null when it cannot be read.
const nameOf = async (client, id) => {
  try {
    return (await client.vocabLayers.get(id))?.name ?? null;
  } catch {
    return null;
  }
};

/**
 * What the import record says the import left in vocabularies of other
 * projects: the entries it added to a lexicon the person keeps (`added`,
 * `[{name, n}]`, which stay), and whether its run was whole and only the
 * clear is left (`whole`). The vocabularies it made belong to its project.
 */
async function whatItLeft(client, project) {
  const config = project.config ?? (await client.projects.get(project.id))?.config;
  const record = readImportState(config) ?? {};
  const added = [];
  for (const [id, n] of Object.entries(record.entriesAdded ?? {})) {
    if (n > 0) added.push({ name: (await nameOf(client, id)) ?? 'a lexicon', n });
  }
  return { added, whole: importRanWhole(record) };
}

/**
 * What a project whose import did not finish shows in place of itself
 * (config.igt.import, see `readImportState`): its page, a link to one of its
 * documents or another of its screens, and the import page once its run
 * stops. Such a project is only ever deleted, by a maintainer and only on
 * request: an import may still be running in another tab.
 *
 * Delete deletes the project, and core deletes the vocabularies the import
 * made with it, since they belong to it. The shared confirm names them, and
 * shows core's refusal while another project links one (whether or not the
 * person can read that project). Entries the import added to a lexicon the
 * person keeps stay, and the screen says how many (R59).
 *
 * A run that was whole but whose record could not be cleared (`finished` on
 * the record) is not offered for deletion: the screen says it finished and
 * offers Try again, as the import page did before a reload.
 *
 * `project` is `{id, name}`, with `config` when the caller has it.
 * `onDeleted` runs once the project is gone, `onFinished` once Try again has
 * cleared the record (the page is loaded again when it is not given).
 */
export const UnfinishedImport = ({ client, project, canManage, onDeleted, onFinished }) => {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState({ added: [], whole: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    whatItLeft(client, project)
      .then((l) => alive && setLeft(l))
      .catch((err) => console.error('Could not read what the import made:', err));
    return () => {
      alive = false;
    };
  }, [client, project]);

  // A refusal throws, and the confirm shows it (core's 409 while another
  // project links one of its vocabularies) or reports it.
  const remove = async () => {
    await client.projects.delete(project.id);
    notifySuccess(`Deleted “${project.name ?? 'the project'}”`);
    setOpen(false);
    onDeleted?.();
  };

  const tryAgain = async () => {
    setBusy(true);
    try {
      if (await markImportFinished(client, project.id)) {
        if (onFinished) onFinished();
        else window.location.reload();
      } else {
        notifyError('The import could not be marked done.', 'Try again');
      }
    } finally {
      setBusy(false);
    }
  };

  // Read off the config the caller has at once, so a whole run never flashes
  // Delete while the rest of the record is read.
  if (left.whole || importRanWhole(readImportState(project.config))) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p>
          The import finished but could not be marked done.
          {canManage ? '' : ' A project maintainer can try again.'}
        </p>
        {canManage && (
          <Button variant="outline" size="sm" disabled={busy} onClick={tryAgain}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  // The confirm adds the vocabularies the delete takes, from core.
  const consequence = (
    <>
      <strong className="font-text text-foreground" dir="auto">
        {project.name}
      </strong>{' '}
      is deleted. This cannot be undone.
    </>
  );

  return (
    <div className="flex flex-col items-start gap-2">
      <p>
        This import did not finish.{' '}
        {canManage ? 'Delete it and import again.' : 'A project maintainer can delete it.'}
      </p>
      {left.added.map((a) => (
        <p key={a.name}>
          The import added {countOf(a.n, 'entry', 'entries')} to “{a.name}” before it stopped. They
          stay there.
        </p>
      ))}
      {canManage && (
        <Button
          variant="outline"
          size="sm"
          className={DELETE_BUTTON_CLASS}
          onClick={() => setOpen(true)}
        >
          Delete
        </Button>
      )}
      <DeleteProjectDialog
        open={open}
        onOpenChange={setOpen}
        project={project}
        client={client}
        consequence={consequence}
        onDelete={remove}
      />
    </div>
  );
};

/**
 * A maintainer's screen of the project (setup, Add ELAN documents) reached by
 * address while its import did not finish: the same notice in place of the
 * screen. Delete goes to the project list.
 */
export const UnfinishedImportScreen = ({ client, project }) => {
  const navigate = useNavigate();
  return (
    <div className={FORM_PAGE_WIDTH}>
      <Notice role="status" icon={null}>
        <UnfinishedImport
          client={client}
          project={project}
          canManage
          onDeleted={() => navigate('/projects', { replace: true })}
        />
      </Notice>
    </div>
  );
};
