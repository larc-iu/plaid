import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { isolate } from '@ui/lib/bidi.js';
import { canEditProject, canUnlinkVocabulary } from '@ui/domain/permissions.js';
import { t } from '@ui/lib/i18n.js';
import { notifyError } from '@/utils/feedback';
import { entryMorphTypesOf } from '@/domain/vocabLookup';
import { planKeptTypes, queueKeptTypes } from '@/domain/keptMorphType';

// The projects that link a vocabulary of another project (its borrowers), on
// that vocabulary's Settings tab, for a maintainer of its project. Each can be
// unlinked from here. A project this person cannot read is listed without its
// name, each as "Another project", so only how many there are is learnt.
export const VocabularyBorrowers = ({ client, user, vocabulary, home }) => {
  const confirm = useConfirm();
  // `[{ id, name }]`, `name` null where this person cannot read the project.
  // Null while read.
  const [borrowers, setBorrowers] = useState(null);
  const [failed, setFailed] = useState(false);
  const vocabId = vocabulary.id;

  const load = useCallback(async () => {
    try {
      const list = await client.vocabLayers.borrowers(vocabId);
      setBorrowers(list || []);
      setFailed(false);
    } catch (err) {
      console.error('Error reading the projects that use the vocabulary:', err);
      setFailed(true);
    }
  }, [client, vocabId]);

  useEffect(() => {
    load();
  }, [load]);

  const unlink = async (borrower) => {
    // What the unlink takes: the links in that project's documents, asked of
    // core's read of it, never the unlink itself.
    let links;
    try {
      ({ links } = await client.projects.vocabUnlinking(borrower.id, vocabId));
    } catch (err) {
      notifyError(err, t('Failed to unlink the vocabulary'));
      return;
    }
    const n = links ?? 0;
    // A morpheme that went by its entry's type keeps it only where this person
    // can write the project (planKeptTypes below). Elsewhere it is left with
    // none, which the confirm says first.
    let writable = false;
    if (n && borrower.name) {
      writable = canEditProject(await client.projects.get(borrower.id).catch(() => null), user);
    }
    const ok = await confirm({
      title: borrower.name
        ? t('Unlink “{vocabulary}” from “{project}”?', {
            vocabulary: isolate(vocabulary.name),
            project: isolate(borrower.name),
          })
        : t('Unlink “{vocabulary}” from another project?', {
            vocabulary: isolate(vocabulary.name),
          }),
      description: n
        ? (borrower.name
            ? t(
                '{n, plural, one {# word/morpheme in “{project}” is} other {# words/morphemes in “{project}” are}} linked to its entries. Those links will be removed.',
                { n, project: isolate(borrower.name) },
              )
            : t(
                '{n, plural, one {# word/morpheme in that project is} other {# words/morphemes in that project are}} linked to its entries. Those links will be removed.',
                { n },
              )) +
          (writable
            ? ''
            : ` ${t('Morphemes there that took their type from an entry will have none.')}`)
        : '',
      confirmLabel: t('Unlink'),
      destructive: true,
    });
    if (!ok) return;
    setBorrowers((list) => (list || []).filter((b) => b.id !== borrower.id));
    try {
      // Each morpheme the unlink leaves keeps the type its entry gave it, in
      // the same batch (Q1), where this person can write that project. One
      // they cannot read has nothing here to plan from.
      let kept = [];
      if (borrower.name && n) {
        const { items = [] } = (await client.vocabLayers.get(vocabId, true)) || {};
        const types = entryMorphTypesOf(items);
        kept = await planKeptTypes(client, user, { vocabId, projectId: borrower.id }, (id) =>
          types.get(id),
        );
      }
      await client.withOperation(`Unlink vocabulary “${vocabulary.name}”`, () =>
        client.batched((b) => {
          queueKeptTypes(b, kept);
          b.projects.unlinkVocab(borrower.id, vocabId);
        }),
      );
    } catch (err) {
      console.error('Error unlinking the vocabulary:', err);
      notifyError(err, t('Failed to unlink the vocabulary'));
    }
    await load();
  };

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-4">
        <h3 className="text-base font-semibold">{t('Used by other projects')}</h3>
        {failed ? (
          <p className="text-sm text-muted-foreground">
            {t('The projects that use it could not be read.')}
          </p>
        ) : borrowers === null ? (
          <Loading />
        ) : borrowers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('No other project uses this vocabulary.')}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {borrowers.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
              >
                {b.name ? (
                  <Link to={`/projects/${b.id}`} dir="auto" className="font-text hover:underline">
                    {b.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{t('Another project')}</span>
                )}
                {canUnlinkVocabulary(vocabulary, { id: b.id }, home, user) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={
                      b.name
                        ? t('Unlink from {project}', { project: b.name })
                        : t('Unlink from another project')
                    }
                    onClick={() => unlink(b)}
                  >
                    {t('Unlink')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
