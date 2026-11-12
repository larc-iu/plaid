import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Plus } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { VocabularyManager } from './VocabularyManager';
import { notifyError } from '@/utils/feedback';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { canLinkVocabulary, canManageProject, isBorrowed } from '@ui/domain/permissions.js';
import { TYPE } from '@ui/lib/typeScale.js';
import { vocabImporting, withLiveMarks } from '@/domain/igtConfig';
import { entryMorphTypesOf } from '@/domain/vocabLookup';
import { planKeptTypes, queueKeptTypes, busyLinkedDocument } from '@/domain/keptMorphType';

// What to show for a refused write: the server's own words when it gave any
// (a refused link says who may make it), otherwise the error for the toast to
// humanize.
const refusal = (error) => error?.responseData?.error || error;

// The links shown are the page's project's, and each link or unlink sent reads
// the page's project again (onProjectUpdate), so every section shows it.
export const VocabularySettings = ({ project, projectId, client, onProjectUpdate }) => {
  const { user } = useAuth();
  const [hasError, setHasError] = useState(false);

  // Load current project vocabularies
  const handleLoadData = async () => {
    try {
      setHasError(false);

      // Every vocabulary the user can read, and the projects they can read
      // with their role lists: a vocabulary's home is one of them, or one the
      // user holds no role in.
      const [listed, readable] = await Promise.all([
        client.vocabLayers.list(),
        client.projects.list(),
      ]);
      const allVocabs = await withLiveMarks(client, listed);
      const homes = new Map((readable || []).map((p) => [p.id, p]));

      const linkedVocabIds = (project.vocabs || []).map((v) => v.id);

      // Transform to component format. This project's own vocabularies are
      // linked for good (core refuses to unlink a vocabulary from its home).
      // Borrowing one takes a maintainer of this project with a role in its
      // home, so a row the user may not link cannot be ticked. Unlinking a
      // borrowed one stays open to any project maintainer.
      const vocabularies = allVocabs.map((vocab) => {
        const own = !isBorrowed(vocab, project);
        const home = own ? project : (homes.get(vocab.project) ?? null);
        const canRelink = !own && canLinkVocabulary(vocab, home, project, user);
        return {
          name: vocab.name || vocab.id,
          id: vocab.id,
          enabled: own || linkedVocabIds.includes(vocab.id),
          isCustom: false, // All existing vocabs from API are not custom
          own,
          // The home's name where the user can read it, else null.
          ...(own ? {} : { from: home?.name ?? null }),
          // One an unfinished import made is linked into no other project (R58).
          canLink: canRelink && !vocabImporting(vocab.config),
          // The unlink confirm says when the user could not link it again.
          canRelink,
          ...(vocabImporting(vocab.config) ? { lockNote: 'Import did not finish.' } : {}),
        };
      });

      return { vocabularies };
    } catch (error) {
      // The panel below takes the screen's place. Not rethrown, since the
      // manager would report it as a send that failed.
      console.error('Failed to load vocabularies configuration:', error);
      setHasError(true);
      return { vocabularies: [] };
    }
  };

  // Send one link or unlink. The row is already ticked or unticked on screen,
  // and a refusal puts it back. Settings only links and unlinks: a vocabulary
  // is CREATED on the New vocabulary screen or by the setup wizard, both of
  // which seed its fields, so handleLoadData stamps every row isCustom: false.
  // The send asks the project first, so a send whose premise an earlier one
  // already settled (a refused link, then an untick) does nothing.
  // Each is labelled with the vocabulary's name, which History and Activity
  // show in place of the id core writes ("Remove vocab 01a1… from project …").
  const handleSaveChanges = async ({ vocabularies, change }) => {
    if (!change) return;
    const live = await client.projects.get(projectId);
    const linked = (live.vocabs || []).some((v) => v.id === change.id);
    const name = vocabularies?.find((v) => v.id === change.id)?.name ?? change.id;
    if (change.enabled && !linked) {
      await client.withOperation(`Link vocabulary “${name}”`, () =>
        client.projects.linkVocab(projectId, change.id),
      );
    } else if (!change.enabled && linked) {
      // The unlink takes the project's links into the vocabulary, and each
      // morpheme they leave keeps the type its entry gave it, in the same
      // batch (Q1).
      const { items = [] } = (await client.vocabLayers.get(change.id, true)) || {};
      const types = entryMorphTypesOf(items);
      const kept = await planKeptTypes(client, user, { vocabId: change.id, projectId }, (id) =>
        types.get(id),
      );
      await client.withOperation(`Unlink vocabulary “${name}”`, () =>
        client.batched((b) => {
          queueKeptTypes(b, kept);
          b.projects.unlinkVocab(projectId, change.id);
        }),
      );
    } else return;
    // The link has landed, so a read that fails is not a failed send.
    await Promise.resolve(onProjectUpdate?.()).catch((err) =>
      console.error('Failed to reload the project:', err),
    );
  };

  // How many links this project has into a vocabulary: an unlink removes them.
  const handleCountLinks = async (vocab) => {
    const res = await client.query({
      where: [
        ['vocab', '?v', { layer: vocab.id }],
        ['link', '?l', { item: '?v' }],
      ],
      return: { group: [], aggregates: [['count']] },
      scope: { projectIds: [projectId] },
    });
    const n = res?.results?.[0]?.[0];
    return typeof n === 'number' ? n : 0;
  };

  // A failed send says why, and its row is already back as it was.
  const handleError = (error) => {
    notifyError(busyLinkedDocument(error) ?? refusal(error), 'Vocabularies not updated');
  };

  if (hasError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">
              Failed to load or save the vocabularies
            </p>
            <p className="text-sm text-muted-foreground">Refresh the page and try again.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className={TYPE.card}>Vocabularies</h2>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Vocabularies linked to this project. Words, morphemes and multi-word expressions link to
        their entries.
      </p>

      <VocabularyManager
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        showTitle={false}
        isSettings={true}
        client={client}
        onCountLinks={handleCountLinks}
      />

      {canManageProject(project, user) && (
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link to={`/vocabularies/new?project=${encodeURIComponent(projectId)}`}>
            <Plus className="h-4 w-4" /> New vocabulary
          </Link>
        </Button>
      )}
    </div>
  );
};
