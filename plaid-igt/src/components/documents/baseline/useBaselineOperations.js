import { useState } from 'react';
import { applyTextOps, gapsToOps } from '@larc-iu/plaid-client';
import { useDocumentCtx, useUnsavedDraft } from '../contexts/DocumentContext.jsx';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { useEditLog } from '@ui/hooks/useEditLog.js';
import { deletesSentenceOrRow, removedStretches } from '@ui/lib/editLog.js';
import { notifyError, notifySuccess } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { countDeleteLoss, lossPhrase } from '@ui/domain/annotationLoss.js';
import { countOf } from '@ui/lib/plural.js';
import {
  SENTENCE_ROLES,
  isTokenIgnored,
  readIgnoredTokens,
  readSentenceRole,
} from '@/domain/igtConfig';

// Baseline tab operations, backed by the shared IgtDocument. The box keeps
// its changes as edits made at the caret (plaid-ui's useEditLog), and the
// save (doc.editBaselineText) sends them as such, so each stands where it was
// typed. The hook owns the local editing state.
//
// The box stays open while a save is on its way. The log is split at the
// send: what is typed meanwhile is kept as edits of the text sent. When the
// save lands with nothing typed since, the tab leaves edit mode. Otherwise it
// stays in it, over the text stored, with what was typed since moved onto
// that text (or kept as typed when it cannot be). A save that is refused puts
// its edits back in front of what was typed since. One that landed and then
// failed at a step after it does not: its edits never come back into the
// draft, and what was typed since is moved onto the text stored, as after a
// save that landed. A save whose answer is lost is sent again until it is
// answered (the document's write queue), so it ends as one or the other.
//
// `changedElsewhere` is true while the draft cannot go onto the text stored
// because the same passage was changed elsewhere: a save refused for it, or
// text typed during a save that landed that cannot be moved onto it. It lasts
// until the next save or Cancel.

// "a", "a and b", "a, b and c".
const listed = (parts) => {
  const xs = parts.filter(Boolean);
  return xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};

// What a save that takes away `ranges` (plaid-ui removedStretches) deletes,
// as a sentence for its question, or '' when it deletes nothing that asks:
// - the words wholly inside a removed stretch
// - the sentences and segments it deletes, by the rule core takes (R45, see
//   plaid-ui deletesSentenceOrRow): one whose letters all go, unless a
//   stretch that types letters is exactly its text or reaches into it, which
//   keeps it and what is on it (R42 Q1)
// - each sentence's translations, and each segment's times
// - the shared loss counter's count of what else hangs off every token that
//   goes, and what is only cut down
// A token the ignored-tokens rule excludes reads as text here (punctuation
// ud's Tokenize made, say), so neither it nor what another app nested in it
// or put on it is counted: the question is the one the same text with no
// such token gets (ruling 29). A sentence with nothing on it asks nothing
// when it goes alone. A stretch that only cuts a word down changes that word.
export function baselineLossSentence(doc, ranges) {
  const info = doc.layerInfo;
  const layer = info?.primaryTokenLayer;
  const tokenLayers = info?.primaryTextLayer?.tokenLayers || [];
  const cfg = readIgnoredTokens(layer?.config);
  const body = Array.from(doc.body || '');
  const ignored = [];
  const shown = [];
  for (const t of layer?.tokens || []) {
    (isTokenIgnored(body.slice(t.begin, t.end).join(''), cfg) ? ignored : shown).push(t);
  }
  const inIgnored = (t) => ignored.some((g) => g.begin <= t.begin && t.end <= g.end);
  const held = new Set(
    [info?.sentenceTokenLayer?.id, info?.alignmentTokenLayer?.id].filter(Boolean),
  );
  const inside = (t) => ranges.some(([b, e]) => b <= t.begin && t.end <= e);
  const goes = (t) => deletesSentenceOrRow(ranges, t, doc.body);
  // What goes: a sentence or a segment by the rule core takes, every other
  // token wholly inside a removed stretch (a point strictly inside), as
  // countTextDeleteLoss reads it, less the ignored words and what is in them
  const dying = tokenLayers.flatMap((tl) =>
    (tl.tokens || []).filter((t) => {
      if (held.has(tl.id)) return goes(t);
      if (tl.id === layer?.id && !shown.includes(t)) return false;
      if (tl.id !== layer?.id && inIgnored(t)) return false;
      return t.begin === t.end ? ranges.some(([b, e]) => b < t.begin && t.end < e) : inside(t);
    }),
  );
  const loss = countDeleteLoss(
    tokenLayers,
    dying.map((t) => t.id),
    { vocabLinks: Object.values(doc.vocabularies || {}).flatMap((v) => v?.vocabLinks || []) },
  );
  const gone = (tl) => (tl?.tokens || []).filter(goes);
  const sentences = gone(info?.sentenceTokenLayer).length;
  const segments = gone(info?.alignmentTokenLayer);
  const timed = segments.some((t) => t.metadata?.timeBegin != null);
  const translations = (info?.sentenceTokenLayer?.spanLayers || [])
    .filter((sl) => readSentenceRole(sl.config) === SENTENCE_ROLES.TRANSLATION)
    .reduce((n, sl) => n + (loss.byLayer?.get(sl.id) ?? 0), 0);
  const words = shown.filter(inside).length;
  const annotations = loss.annotations - translations;
  const asks = words || segments.length || translations || annotations || loss.links;
  const what = listed([
    sentences &&
      `${countOf(sentences, 'sentence')}${translations ? ` with ${countOf(translations, 'translation')}` : ''}`,
    segments.length &&
      `${countOf(segments.length, 'segment')}${timed ? (segments.length === 1 ? ' with its times' : ' with their times') : ''}`,
    words && countOf(words, 'word'),
    lossPhrase({ annotations, links: loss.links }),
  ]);
  const cut = lossPhrase(loss.shortened);
  const said = [asks && what && `Deletes ${what}.`, cut && `Shortens ${cut}.`]
    .filter(Boolean)
    .join(' ');
  if (said) return said;
  const touched = shown.some((t) => ranges.some(([b, e]) => b < t.end && t.begin < e));
  return touched ? 'Changes the words in the removed text.' : '';
}

// `onSend(text)` is called as a save goes out, with the text it stores, and
// `onRefused()` when that save is refused and the draft stays.
export const useBaselineOperations = ({ onSend, onRefused } = {}) => {
  const { doc } = useDocumentCtx();
  useDocumentModel(doc);
  const confirm = useConfirm();

  const body = doc.body || '';
  const primaryTextLayer = doc.layerInfo?.primaryTextLayer || null;

  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editedText, setEditedText] = useState('');
  // The body the draft was typed over. A save moves the draft's changes onto
  // the body stored by then (see editBaselineText), so a passage someone else
  // saved meanwhile is not put back as it was here.
  const [base, setBase] = useState('');
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const editLog = useEditLog();

  const handleEdit = () => {
    setEditedText(body);
    setBase(body);
    editLog.reset(body, primaryTextLayer?.text?.digest ?? null);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setChangedElsewhere(false);
    setEditedText('');
    setBase('');
    editLog.reset('');
    setIsEditing(false);
  };

  // `text` as the box shows it: every line break a `\n`.
  const shown = (text) => text.replace(/\r\n?/g, '\n');

  // A throw anywhere in a save is reported and leaves the draft as it was,
  // so Save works again (rather than a button that does nothing).
  const handleSave = async () => {
    const at = { sent: null, settled: false };
    try {
      await save(at);
    } catch (err) {
      if (at.sent && !at.settled) {
        editLog.unsend(at.sent);
        setBase(base);
        onRefused?.();
      }
      setSaving(false);
      notifyError(err, 'Failed to save baseline text');
    }
  };

  const save = async (at) => {
    // Nothing changed (or typed and taken back): nothing to send, and no
    // operation is written for it.
    if (editLog.gaps().length === 0 || editedText === base) {
      handleCancel();
      return;
    }
    // A save that deletes or replaces text can delete words, sentences and
    // segments and what is on them, so it asks first. One that only inserts,
    // glued to a word or not, keeps every token (Luke, 2026-10-16), and one
    // that touches no word and deletes no sentence or segment with anything
    // on it changes none.
    const removed = removedStretches(editLog.log.base, editLog.gaps());
    const loses = removed.length > 0 ? baselineLossSentence(doc, removed) : '';
    if (
      loses &&
      !(await confirm({
        title: 'Save baseline changes?',
        description: loses,
        confirmLabel: 'Save anyway',
        destructive: true,
      }))
    ) {
      return;
    }
    setSaving(true);
    setChangedElsewhere(false);
    const sent = editLog.send();
    at.sent = sent;
    // What was sent, as the base of what is typed while it is on its way.
    const sending = shown(applyTextOps(sent.base, gapsToOps(sent.gaps)));
    setBase(sending);
    onSend?.(sending);
    const outcome = {};
    const ok = await doc.editBaselineText(sent, outcome);
    at.settled = true;
    setSaving(false);
    if (!ok && !outcome.landed) {
      editLog.unsend(sent);
      setBase(base);
      onRefused?.();
      setChangedElsewhere(!!outcome.conflict);
      return;
    }
    if (ok) notifySuccess('Baseline text saved');
    if (editLog.gaps().length === 0) {
      handleCancel();
      return;
    }
    // Typed while the save was on its way: moved onto the text stored now,
    // which holds what was sent and what anyone else saved meanwhile.
    const stored = doc.body || '';
    const storedDigest = doc.layerInfo?.primaryTextLayer?.text?.digest ?? null;
    const moved = editLog.rebase(stored, storedDigest);
    if (moved.conflict) {
      setChangedElsewhere(true);
      return;
    }
    setBase(shown(stored));
    setEditedText(moved.body);
  };

  // Leaving the tab with text typed and not saved asks first: this tab holds
  // a whole document's baseline, and it used to go without a word. What a
  // save on its way sends is not asked about: it lands whether or not the tab
  // is left. What was typed since is.
  useUnsavedDraft(isEditing && editedText !== base ? 'The baseline text you have typed' : null);

  // The box's change, with the selection before it (editLogHandlers) and the
  // caret after it, kept as an edit.
  const handleTextChange = (event) => {
    editLog.onChange(event);
    setEditedText(event.target.value);
  };

  return {
    body,
    primaryTextLayer,
    isEditing,
    saving,
    editedText,
    changedElsewhere,

    handleEdit,
    handleCancel,
    handleSave,
    handleTextChange,
    editLogHandlers: editLog.handlers,
  };
};
