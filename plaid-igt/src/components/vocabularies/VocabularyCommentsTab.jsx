import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CommentsIsland } from '@/components/documents/comments/island/CommentsIsland.js';
import { buildEntryAnchorIndex } from '@/domain/commentAnchors';
import { notifyError } from '@/utils/feedback';

// Every thread on a vocabulary's entries, in one place: the vocabulary's
// counterpart of the document Comments tab, mounting the same island. The
// entries are what threads are labeled by (and what tells an outdated thread
// from a live one), so they are loaded here before the island mounts.
export const VocabularyCommentsTab = ({
  vocabularyId,
  client,
  store,
  fields,
  canWrite,
  canDeleteAny,
}) => {
  const navigate = useNavigate();
  const hostRef = useRef(null);
  const islandRef = useRef(null);
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
  const index = useMemo(
    () => (items ? buildEntryAnchorIndex(items, { glossField: hasGloss ? 'gloss' : null }) : null),
    [items, hasGloss],
  );
  // The island asks for the index on every render; a ref keeps the newest one
  // in reach without remounting.
  const indexRef = useRef(index);
  indexRef.current = index;
  const ready = index !== null;

  useEffect(() => {
    if (!store || !ready || !hostRef.current) return undefined;
    islandRef.current = new CommentsIsland(hostRef.current, {
      store,
      anchorIndex: () => indexRef.current,
      canWrite,
      canDeleteAny,
      onJumpTo: (itemId) => navigate(`/vocabularies/${vocabularyId}?item=${itemId}`),
      emptyText: 'No entry has comments yet. Open an entry to add one.',
      jumpTitle: 'Open the entry',
    });
    return () => {
      islandRef.current?.destroy();
      islandRef.current = null;
    };
    // Entries and permissions are synced below without tearing down the island.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ready]);

  useEffect(() => {
    islandRef.current?.setAnchorIndex(() => indexRef.current);
  }, [index]);

  useEffect(() => {
    islandRef.current?.setPermissions({ canWrite, canDeleteAny });
  }, [canWrite, canDeleteAny]);

  if (!ready) {
    return <p className="py-6 text-sm text-muted-foreground">Loading comments…</p>;
  }
  return <div ref={hostRef} className="igt-comments-mount" />;
};
