import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';
import { Button } from '@ui/components/ui/button';
import { DeleteProjectDialog } from '@ui/components/shared/DeleteProjectDialog.jsx';
import { DELETE_BUTTON_CLASS } from '@ui/lib/destructive.js';
import { statusOf } from '@ui/lib/errors.js';
import { countOf } from '@ui/lib/plural.js';
import { notifySuccess, notifyWarning } from '@/utils/feedback';
import { readImportState } from '@/domain/igtConfig';

const quoted = (vocabs) => vocabs.map((v) => `“${v.name}”`).join(', ');

// A vocabulary's name, or null when it cannot be read.
const nameOf = async (client, id) => {
  try {
    return (await client.vocabLayers.get(id))?.name ?? null;
  } catch {
    return null;
  }
};

/**
 * What the import record says the import left in vocabularies: the ones it
 * made (`made`, which Delete takes unless another project links one) and the
 * entries it added to a lexicon the person keeps (`added`, `[{name, n}]`,
 * which stay).
 */
async function whatItLeft(client, project) {
  const config = project.config ?? (await client.projects.get(project.id))?.config;
  const record = readImportState(config) ?? {};
  const made = [];
  for (const id of record.vocabsMade ?? []) {
    made.push({ id, name: (await nameOf(client, id)) ?? 'an unnamed vocabulary' });
  }
  const added = [];
  for (const [id, n] of Object.entries(record.entriesAdded ?? {})) {
    if (n > 0) added.push({ name: (await nameOf(client, id)) ?? 'a lexicon', n });
  }
  return { made, added };
}

/**
 * What a project whose import did not finish shows in place of itself
 * (config.igt.import, see `readImportState`): its page, a link to one of its
 * documents or another of its screens, and the import page once its run
 * stops. Such a project is only ever deleted, by a maintainer and only on
 * request: an import may still be running in another tab.
 *
 * Delete takes the vocabularies the import made (R58), each only when no
 * project but this one links it. Core decides that, from every project
 * linking it whether or not the person can read it, and a vocabulary it keeps
 * is named. Entries the import added to a lexicon the person keeps stay, and
 * the screen says how many (R59).
 *
 * `project` is `{id, name}`, with `config` when the caller has it.
 * `onDeleted` runs once the project is gone.
 */
export const UnfinishedImport = ({ client, project, canManage, onDeleted }) => {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState({ made: [], added: [] });

  useEffect(() => {
    let alive = true;
    whatItLeft(client, project)
      .then((l) => alive && setLeft(l))
      .catch((err) => console.error('Could not read what the import made:', err));
    return () => {
      alive = false;
    };
  }, [client, project]);

  const remove = async () => {
    await client.projects.delete(project.id);
    const kept = [];
    for (const v of left.made) {
      try {
        await client.vocabLayers.delete(v.id, undefined, { onlyInProject: project.id });
      } catch (err) {
        if (statusOf(err) === 404) continue;
        console.error('Could not delete the vocabulary:', err);
        kept.push(v);
      }
    }
    notifySuccess(`Deleted “${project.name ?? 'the project'}”`);
    if (kept.length) {
      notifyWarning(
        `${quoted(kept)} ${kept.length === 1 ? 'stays' : 'stay'} (used by another project, or you do not maintain it).`,
        'Vocabularies kept',
      );
    }
    setOpen(false);
    onDeleted?.();
  };

  const consequence = (
    <>
      <strong className="font-text text-foreground" dir="auto">
        {project.name}
      </strong>
      {left.made.length
        ? ` and the vocabularies its import made (${quoted(left.made)}) are deleted, a vocabulary another project uses excepted.`
        : ' is deleted.'}{' '}
      This cannot be undone.
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
