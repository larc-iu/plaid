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
      // maintainers, so a row the user does not maintain cannot be ticked.
      // Unlinking stays open to any project maintainer.
      const vocabularies = allVocabs.map((vocab) => ({
        name: vocab.name || vocab.id,
        id: vocab.id,
        enabled: linkedVocabIds.includes(vocab.id),
        isCustom: false, // All existing vocabs from API are not custom
        canLink: canManageVocabulary(vocab, user),
      }));

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
  const handleSaveChanges = async ({ change }) => {
    if (!client) throw new Error('Not authenticated');
    if (!change) return;
    const project = await client.projects.get(projectId);
    const linked = (project.vocabs || []).some((v) => v.id === change.id);
    if (change.enabled && !linked) {
      await client.projects.linkVocab(projectId, change.id);
    } else if (!change.enabled && linked) {
      await client.projects.unlinkVocab(projectId, change.id);
    }
  };

  // A failed send says why, and its row is already back as it was.
  const handleError = (error) => {
    notifyError(refusal(error), 'Vocabularies not updated');
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
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        showTitle={false}
        isSettings={true}
      />
    </div>
  );
};
