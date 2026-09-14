import { useEffect, useMemo, useState } from 'react';
import { flattenOptions, normalizeOptions } from '../shared/comboboxOptions.js';
import { activeMention, filterMentions, insertMention } from './mentions.js';

// `@` in the composer: a typeahead over the reference spellings the model
// already reads, so a reader can name a sentence they are not looking at, or
// the entry that needs its homograph number. What it inserts is plain text: the
// message is the record (see mentions.js).
//
// Two halves feed the list. `offer` is the SCREEN's, which knows what it is
// showing; the project's documents are read here, once, because no screen has
// them all.
//
// `enabled` is whether a mention can be started at all, which is whether a
// message can be sent.
export const useMentions = ({ client, projectId, enabled, text, setText, inputRef, offer }) => {
  // Where the caret is, which is the other half of knowing whether an `@` is
  // being typed (see mentions.js).
  const [caret, setCaret] = useState(0);
  // The offset of an `@` the reader dismissed with Escape. It stays dismissed
  // until they start another one, or the list would come back on the next
  // keystroke.
  const [dismissed, setDismissed] = useState(-1);
  const [activeValue, setActiveValue] = useState(null); // the highlighted value
  const [documents, setDocuments] = useState(null); // the project's documents, once

  const mention = enabled ? activeMention(text, caret) : null;
  const open = !!mention && mention.from !== dismissed;

  // The project's documents, read once and filtered here. There is no name
  // query on the endpoint, so this takes one page of the server's largest: a
  // project past that lists its first thousand, and the reader names the rest
  // the way they always have, by typing.
  //
  // `bypassBatch`: the panel is app chrome on the client the importers and the
  // Grew runner hold batches on. Queued into one, this read answers
  // `{batched: true}` instead of an envelope and takes a slot in the batch's
  // results, which shifts every created id the batch's owner reads back.
  useEffect(() => {
    setDocuments(null);
  }, [projectId]);
  useEffect(() => {
    if (!open || documents || !client || !projectId) return undefined;
    let alive = true;
    client.projects
      .listDocumentsPage(projectId, { limit: 1000, bypassBatch: true })
      .then((page) => alive && setDocuments(page?.entries || []))
      // Without them the list still offers what the screen knows, which is
      // the half a reader is most likely to want.
      .catch(() => alive && setDocuments([]));
    return () => {
      alive = false;
    };
  }, [open, documents, client, projectId]);

  // What the screen offers first, then the project's documents: a reference to
  // what is in front of you is the common case.
  const groups = useMemo(() => {
    if (!open) return [];
    const own = offer?.(mention.query) || [];
    const docs = (documents || []).map((d) => ({ value: d.name, label: d.name }));
    const all = [...own, ...(docs.length ? [{ group: 'Documents', items: docs }] : [])];
    return filterMentions(normalizeOptions(all), mention.query);
  }, [open, mention, offer, documents]);
  const items = useMemo(() => flattenOptions(groups), [groups]);

  // The highlight follows the list: the row it was on may not have survived
  // the last keystroke.
  useEffect(() => {
    if (!items.length) return;
    if (!items.some((m) => m.value === activeValue)) setActiveValue(items[0].value);
  }, [items, activeValue]);

  const pick = (item) => {
    const next = insertMention(text, caret, item.value);
    setText(next.text);
    setDismissed(-1);
    // After the paint, or the caret is set against the old value and the
    // browser puts it back at the end.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  // The list takes the keys it needs BEFORE the composer sees them, which is
  // the contract the shared Combobox documents at its head and the reason this
  // is arbitrated rather than left to bubble: Enter sends a message. True means
  // the list took the key.
  const handleKeyDown = (e) => {
    if (!open || !items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = items.findIndex((m) => m.value === activeValue);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const at = (i + step + items.length) % items.length;
      setActiveValue(items[at].value);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const picked = items.find((m) => m.value === activeValue) || items[0];
      e.preventDefault();
      pick(picked);
      return true;
    }
    if (e.key === 'Escape') {
      // The typed text is left exactly as it is. Escape closes the list, it
      // does not undo what the reader wrote.
      e.preventDefault();
      setDismissed(mention.from);
      return true;
    }
    return false;
  };

  return {
    open,
    groups,
    items,
    activeValue,
    setActiveValue,
    loading: documents === null,
    pick,
    handleKeyDown,
    // The caret moves without the text changing (a click, an arrow key), and
    // the list has to follow.
    noteCaret: (pos) => setCaret(pos ?? 0),
    trackCaret: (e) => setCaret(e.target.selectionStart ?? 0),
  };
};
