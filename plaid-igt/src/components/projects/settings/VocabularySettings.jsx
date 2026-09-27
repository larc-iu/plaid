import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { VocabularyManager } from './VocabularyManager';
import { notifyError } from '@/utils/feedback';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { canManageVocabulary } from '@ui/domain/permissions.js';

// What to show for a refused write: the server's own words when it gave any
// (a refused link says who may make it), otherwise the error for the toast to
// humanize.
const refusal = (error) => error?.responseData?.error || error;

export const VocabularySettings = ({ projectId, client }) => {
  const { user } = useAuth();
  const [hasError, setHasError] = useState(false);
  // Bumped after a failed save, which may have linked some vocabularies and
  // not others, so the list reloads from the server.
  const [reloadKey, setReloadKey] = useState(0);

  // Load current project vocabularies
  const handleLoadData = async () => {
    try {
      setHasError(false);

      if (!client) {
        throw new Error('Not authenticated');
      }

      // Get all available vocabularies
      const allVocabs = await client.vocabLayers.list();

      // Get the project to see which vocabularies are linked
      const project = await client.projects.get(projectId);
      const linkedVocabIds = (project.vocabs || []).map((v) => v.id);

      // Transform to component format. Linking a vocabulary takes one of its
      // maintainers, so an unlinked row the user does not maintain is locked.
      // Unlinking stays open to any project maintainer.
      const vocabularies = allVocabs.map((vocab) => {
        const enabled = linkedVocabIds.includes(vocab.id);
        return {
          name: vocab.name || vocab.id,
          id: vocab.id,
          enabled,
          isCustom: false, // All existing vocabs from API are not custom
          locked: !enabled && !canManageVocabulary(vocab, user),
        };
      });

      return { vocabularies };
    } catch (error) {
      console.error('Failed to load vocabularies configuration:', error);
      setHasError(true);
      throw error;
    }
  };

  // Save changes to the API
  const handleSaveChanges = async (data) => {
    try {
      setHasError(false);

      if (!client) {
        throw new Error('Not authenticated');
      }

      // Get current project state
      const project = await client.projects.get(projectId);
      const currentLinkedVocabIds = (project.vocabs || []).map((v) => v.id);

      // Which vocabularies should be linked. Settings only links and unlinks:
      // a vocabulary is CREATED on the New vocabulary screen or by the setup
      // wizard, both of which seed its fields. This screen never makes one, so
      // handleLoadData stamps every row isCustom: false.
      const targetLinkedVocabIds = data.vocabularies
        .filter((vocab) => vocab.enabled)
        .map((vocab) => vocab.id);

      // Link new vocabularies BEFORE unlinking removed ones: a failure midway
      // through the links leaves every previously linked vocab still in place,
      // whereas unlink-first could strip links the user meant to keep. A
      // failure during the unlinks leaves extra links — harmless, and a
      // re-save (which re-diffs against fresh project state) cleans them up.
      for (const vocabId of targetLinkedVocabIds) {
        if (!currentLinkedVocabIds.includes(vocabId)) {
          await client.projects.linkVocab(projectId, vocabId);
        }
      }

      for (const vocabId of currentLinkedVocabIds) {
        if (!targetLinkedVocabIds.includes(vocabId)) {
          await client.projects.unlinkVocab(projectId, vocabId);
        }
      }
    } catch (error) {
      console.error('Failed to save vocabularies configuration:', error);
      throw error;
    }
  };

  // A failed load has already swapped the screen for the panel below. A failed
  // save says why in a toast and reloads the list.
  const handleError = (error) => {
    notifyError(refusal(error), 'Vocabularies not updated');
    setReloadKey((k) => k + 1);
  };

  if (hasError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">Configuration Error</p>
            <p className="text-sm text-muted-foreground">
              Failed to load or save vocabularies configuration. Please refresh the page and try
              again.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">Vocabularies</h2>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Link vocabularies to your project. Vocabularies allow you to link tokens to
        document-independent vocabulary entries, allowing you to track constructs such as morphemes,
        words, or multi-word expressions.
      </p>

      <VocabularyManager
        key={reloadKey}
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        showTitle={false}
        isSettings={true}
      />
    </div>
  );
};
