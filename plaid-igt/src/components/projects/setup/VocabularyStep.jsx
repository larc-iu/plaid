import { VocabularyManager } from '../settings/VocabularyManager.jsx';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { canLinkVocabulary } from '@ui/domain/permissions.js';
import { vocabImporting, withLiveMarks } from '@/domain/igtConfig';

export const VocabularyStep = ({ data, onDataChange, client, projectId, isNewProject }) => {
  const { user } = useAuth();
  // The project being set up, which only its maintainers do (the wizard's
  // guard). Its role lists are not needed past that, and a new one has no id.
  const settingUp = { id: isNewProject ? undefined : projectId, maintainers: [user?.id] };
  // Load vocabularies from API on mount
  const handleLoadData = async () => {
    try {
      if (!client) throw new Error('Not authenticated');

      const [listed, readable] = await Promise.all([
        client.vocabLayers.list(),
        client.projects.list(),
      ]);
      const vocabList = await withLiveMarks(client, listed || []);
      const homes = new Map((readable || []).map((p) => [p.id, p]));

      // Transform API vocabs into our format. A project set up again already
      // holds its own vocabularies, linked for good.
      const initialVocabs = (vocabList || []).map((vocab) => {
        const own = !!settingUp.id && vocab.project === settingUp.id;
        const home = homes.get(vocab.project) ?? null;
        return {
          name: vocab.name || vocab.id,
          id: vocab.id,
          enabled: own,
          isCustom: false, // Existing vocabs from API
          own,
          ...(own ? {} : { from: home?.name ?? null }),
          // Setup links the ticked ones at the end, and linking one takes a
          // role in the project it belongs to, so the others cannot be ticked
          // here. One an unfinished import made is linked into no project (R58).
          canLink:
            !own &&
            canLinkVocabulary(vocab, home, settingUp, user) &&
            !vocabImporting(vocab.config),
          ...(vocabImporting(vocab.config) ? { lockNote: 'Import did not finish.' } : {}),
        };
      });

      return { vocabularies: initialVocabs };
    } catch (err) {
      console.error('Error fetching vocabularies:', err);
      throw err;
    }
  };

  // Handle saving changes - interface with parent's onDataChange
  const handleSaveChanges = async (newData) => {
    onDataChange(newData);
  };

  return (
    <div className="flex flex-col gap-8">
      {/* Explanatory header */}
      <div>
        <p className="text-sm">
          A vocabulary is a lexicon. Words and morphemes link to its entries, so one entry is
          glossed the same way everywhere. A vocabulary that belongs to another project is changed
          by the writers and maintainers of that project.
        </p>
        {/* It starts empty and stays empty until someone puts entries in it,
          which the sentence above does not say. A linguist read it, made one,
          glossed 45 morphemes, and found nothing in it: the gloss suggestions
          they were getting came from what they had already typed in this
          project, not from the lexicon, so it looked like the lexicon was
          doing the work. Name the three ways in. */}
        <p className="mt-2 text-sm text-muted-foreground">
          A new vocabulary starts empty. Fill it from the Vocabularies screen, by linking a word or
          morpheme to a new entry as you gloss, or with Auto-analyze.
        </p>
      </div>

      {/* Use the reusable manager component */}
      <VocabularyManager
        initialData={data}
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        showTitle={true}
        isSettings={false}
        client={client}
      />
    </div>
  );
};

// Validation function for this step
VocabularyStep.isValid = () => {
  // Step is always valid - vocabularies are optional
  // Users can proceed without any vocabularies if they don't need this feature
  return true;
};
