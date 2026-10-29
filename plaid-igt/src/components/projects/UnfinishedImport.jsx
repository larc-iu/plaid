import { useState } from 'react';
import { Button } from '@ui/components/ui/button';
import { DeleteProjectDialog } from '@ui/components/shared/DeleteProjectDialog.jsx';
import { DELETE_BUTTON_CLASS } from '@ui/lib/destructive.js';
import { statusOf } from '@ui/lib/errors.js';
import { notifyError, notifySuccess, notifyWarning, humanizeError } from '@/utils/feedback';
import { readImportState } from '@/domain/igtConfig';

const quoted = (vocabs) => vocabs.map((v) => `“${v.name}”`).join(', ');
const kept = (vocabs) =>
  `${quoted(vocabs)} ${vocabs.length === 1 ? 'stays' : 'stay'} (used by another project).`;

/**
 * The vocabularies the import made (the record's `vocabsMade`), split into
 * those Delete takes and those another project links, which stay. A
 * vocabulary the person chose that was there before is never on the record.
 */
async function vocabsOf(client, projectId) {
  const project = await client.projects.get(projectId);
  const made = readImportState(project?.config)?.vocabsMade ?? [];
  if (!made.length) return { remove: [], keep: [] };
  const others = (await client.projects.list()).filter((p) => p.id !== projectId);
  const linkedElsewhere = new Set(others.flatMap((p) => (p.vocabs || []).map((v) => v.id)));
  const remove = [];
  const keep = [];
  for (const id of made) {
    let vocab;
    try {
      vocab = await client.vocabLayers.get(id);
    } catch (err) {
      if (statusOf(err) === 404) continue;
      throw err;
    }
    (linkedElsewhere.has(id) ? keep : remove).push({ id, name: vocab?.name ?? id });
  }
  return { remove, keep };
}

/**
 * What a project whose import did not finish shows in place of itself
 * (config.igt.import, see `readImportState`): its page, a link to one of its
 * documents or another of its screens, and the import page once its run
 * stops. Such a project is only ever deleted, by a maintainer and only on
 * request: an import may still be running in another tab. Delete takes the
 * vocabularies the import made, unless another project links one, which
 * stays and is named.
 *
 * `project` is `{id, name}`. `onDeleted` runs once the project is gone.
 */
export const UnfinishedImport = ({ client, project, canManage, onDeleted }) => {
  const [open, setOpen] = useState(false);
  const [vocabs, setVocabs] = useState({ remove: [], keep: [] });

  const ask = async () => {
    try {
      setVocabs(await vocabsOf(client, project.id));
      setOpen(true);
    } catch (err) {
      console.error('Could not read what the import made:', err);
      notifyError(humanizeError(err), 'Failed to delete project');
    }
  };

  const remove = async () => {
    await client.projects.delete(project.id);
    const failed = [];
    for (const v of vocabs.remove) {
      try {
        await client.vocabLayers.delete(v.id);
      } catch (err) {
        console.error('Could not delete the vocabulary:', err);
        failed.push(v);
      }
    }
    notifySuccess(`Deleted “${project.name ?? 'the project'}”`);
    if (failed.length) {
      notifyWarning(`${quoted(failed)} could not be deleted.`, 'Vocabularies kept');
    }
    if (vocabs.keep.length) {
      notifyWarning(kept(vocabs.keep), 'Vocabularies kept');
    }
    setOpen(false);
    onDeleted?.();
  };

  const name = (
    <strong className="font-text text-foreground" dir="auto">
      {project.name}
    </strong>
  );
  const consequence = (
    <>
      {name}
      {vocabs.remove.length
        ? ` and the vocabularies its import made (${quoted(vocabs.remove)}) are deleted.`
        : ' is deleted.'}{' '}
      This cannot be undone.
      {vocabs.keep.length ? ` ${kept(vocabs.keep)}` : ''}
    </>
  );

  return (
    <div className="flex flex-col items-start gap-2">
      <p>
        This import did not finish.{' '}
        {canManage ? 'Delete it and import again.' : 'A project maintainer can delete it.'}
      </p>
      {canManage && (
        <Button variant="outline" size="sm" className={DELETE_BUTTON_CLASS} onClick={ask}>
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
