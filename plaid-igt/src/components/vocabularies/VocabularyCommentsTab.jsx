import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CommentsBrowser } from '@/components/documents/comments/CommentsBrowser.jsx';
import { buildEntryAnchorIndex } from '@/domain/commentAnchors';
import { notifyError } from '@/utils/feedback';

// Every thread on a vocabulary's entries: the vocabulary's counterpart of the
// document Comments tab. The entries are what threads are labeled by (and what
// tells an outdated thread from a current one), so they are loaded here first.
export const VocabularyCommentsTab = ({
  vocabularyId,
  client,
  store,
  fields,
  canWrite,
  canDeleteAny,
}) => {
  const navigate = useNavigate();
  const [items, setItems] = useState(null);

  useEffect(() => {
    if (!client || !vocabularyId) return undefined;
    let alive = true;
    client.vocabLayers
      .get(vocabularyId, true)
      .then((v) => {
        if (alive) setItems(v.items || []);
      })
      .catch((err) => {
        if (!alive) return;
        notifyError('Failed to load vocabulary items', err);
        setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [client, vocabularyId]);

  const hasGloss = useMemo(() => (fields || []).some((f) => f.name === 'gloss'), [fields]);
  const anchors = useMemo(
    () => (items ? buildEntryAnchorIndex(items, { glossField: hasGloss ? 'gloss' : null }) : null),
    [items, hasGloss],
  );

  if (!anchors) {
    return <p className="py-6 text-sm text-muted-foreground">Loading comments…</p>;
  }
  return (
    <CommentsBrowser
      store={store}
      anchors={anchors}
      canWrite={canWrite}
      canDeleteAny={canDeleteAny}
      onJumpTo={(itemId) => navigate(`/vocabularies/${vocabularyId}?item=${itemId}`)}
      jumpTitle="Open the entry"
      emptyText="No entry has comments yet. Open an entry to add one."
      positionLabel="By entry"
    />
  );
};
