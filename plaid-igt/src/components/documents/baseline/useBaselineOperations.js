import { useRef, useState } from 'react';
import { applyTextOps, gapsToOps } from '@larc-iu/plaid-client';
import { useDocumentCtx, useUnsavedDraft } from '../contexts/DocumentContext.jsx';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { useEditLog } from '@ui/hooks/useEditLog.js';
import { deletesSentenceOrRow, removedStretches } from '@ui/lib/editLog.js';
import { rebaseEdits } from '@ui/lib/textMerge.js';
import { notifyError, notifySuccess } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { countDeleteLoss, holdsPersonsWork, lossPhrase } from '@ui/domain/annotationLoss.js';
import { t, listOf } from '@ui/lib/i18n.js';
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

// What a save that takes away `ranges` (plaid-ui removedStretches) deletes,
// as a sentence for its question, or '' when it deletes nothing that asks:
// - the words wholly inside a removed stretch
// - the sentences and segments it deletes, by the rule core takes (R45, see
//   plaid-ui deletesSentenceOrRow): one whose letters all go, unless a
//   stretch that types letters is exactly its text or reaches into it, which
//   keeps it and what is on it (R42 Q1)
// - each sentence's translations, and each segment's times
// - the shared loss counter's count of what else hangs off every token that
//   goes (a word's or morpheme's own content included), and what is only cut
//   down
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
  for (const tok of layer?.tokens || []) {
    (isTokenIgnored(body.slice(tok.begin, tok.end).join(''), cfg) ? ignored : shown).push(tok);
  }
  const inIgnored = (tok) => ignored.some((g) => g.begin <= tok.begin && tok.end <= g.end);
  const held = new Set(
    [info?.sentenceTokenLayer?.id, info?.alignmentTokenLayer?.id].filter(Boolean),
  );
  const inside = (tok) => ranges.some(([b, e]) => b <= tok.begin && tok.end <= e);
  const goes = (tok) => deletesSentenceOrRow(ranges, tok, doc.body);
  // What goes: a sentence or a segment by the rule core takes, every other
  // token wholly inside a removed stretch (a point strictly inside), as
  // countTextDeleteLoss reads it, less the ignored words and what is in them
  const dying = tokenLayers.flatMap((tl) =>
    (tl.tokens || []).filter((tok) => {
      if (held.has(tl.id)) return goes(tok);
      if (tl.id === layer?.id && !shown.includes(tok)) return false;
      if (tl.id !== layer?.id && inIgnored(tok)) return false;
      return tok.begin === tok.end
        ? ranges.some(([b, e]) => b < tok.begin && tok.end < e)
        : inside(tok);
    }),
  );
  const loss = countDeleteLoss(
    tokenLayers,
    dying.map((tok) => tok.id),
    {
      vocabLinks: Object.values(doc.vocabularies || {}).flatMap((v) => v?.vocabLinks || []),
      // A token's own content counts as one annotation, as for the Tokenize
      // tab's word delete, but for the sentences and segments named apart.
      content: (tok, layerId) => !held.has(layerId) && holdsPersonsWork(tok),
    },
  );
  const gone = (tl) => (tl?.tokens || []).filter(goes);
  const sentences = gone(info?.sentenceTokenLayer).length;
  const segments = gone(info?.alignmentTokenLayer);
  const timed = segments.some((tok) => tok.metadata?.timeBegin != null);
  const translations = (info?.sentenceTokenLayer?.spanLayers || [])
    .filter((sl) => readSentenceRole(sl.config) === SENTENCE_ROLES.TRANSLATION)
    .reduce((n, sl) => n + (loss.byLayer?.get(sl.id) ?? 0), 0);
  const words = shown.filter(inside).length;
  const annotations = loss.annotations - translations;
  const asks = words || segments.length || translations || annotations || loss.links;
  // Each part a counted phrase of its own, the parts a list.
  const what = listOf(
    [
      sentences &&
        (translations
          ? t(
              '{s, plural, one {# sentence} other {# sentences}} with {tr, plural, one {# translation} other {# translations}}',
              { s: sentences, tr: translations },
            )
          : t('{n, plural, one {# sentence} other {# sentences}}', { n: sentences })),
      segments.length &&
        (timed
          ? t('{n, plural, one {# segment with its times} other {# segments with their times}}', {
              n: segments.length,
            })
          : t('{n, plural, one {# segment} other {# segments}}', { n: segments.length })),
      words && t('{n, plural, one {# word} other {# words}}', { n: words }),
      lossPhrase({ annotations, links: loss.links }),
    ].filter(Boolean),
  );
  const cut = lossPhrase(loss.shortened);
  const said = [
    asks && what && t('Deletes {what}.', { what }),
    cut && t('Shortens {cut}.', { cut }),
  ]
    .filter(Boolean)
    .join(' ');
  if (said) return said;
  const touched = shown.filter((tok) =>
    ranges.some(([b, e]) => b < tok.end && tok.begin < e),
  ).length;
  return touched ? t('Changes {n, plural, one {# word} other {# words}}.', { n: touched }) : '';
}

export const useBaselineOperations = () => {
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
  //
  // One save at a time: a press while one is reading, asking or sending
  // does nothing (Save is disabled then too, REV-G1-3).
  const busy = useRef(false);
  const handleSave = async () => {
    if (busy.current) return;
    busy.current = true;
    const at = { sent: null, settled: false };
    try {
      await save(at);
    } catch (err) {
      if (at.sent && !at.settled) {
        editLog.unsend(at.sent);
        setBase(base);
      }
      setSaving(false);
      notifyError(err, t('Failed to save baseline text'));
    } finally {
      busy.current = false;
    }
  };

  // The question a save of the box asks, as the document is stored now, or ''.
  // A save that removes no text deletes nothing, whatever was added
  // elsewhere, and reads nothing. Otherwise the document is read, and the
  // edits are moved onto the text stored when someone saved it meanwhile, as
  // the save moves them. Edits that cannot be moved are refused by the save
  // unsent, so they ask nothing.
  const removedOn = (body, gaps) => {
    const words = (doc.layerInfo?.primaryTokenLayer?.tokens || []).map((tok) => [
      tok.begin,
      tok.end,
    ]);
    return removedStretches(body, gaps, words);
  };
  const lossOfSave = async (gaps) => {
    const base = editLog.log.base;
    if (removedOn(base, gaps).length === 0) return '';
    await doc.reload();
    const stored = doc.body || '';
    const moved = stored === base ? { gaps } : rebaseEdits(base, gaps, stored);
    if (moved.conflict) return '';
    const removed = removedOn(stored, moved.gaps);
    return removed.length > 0 ? baselineLossSentence(doc, removed) : '';
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
    //
    // What it deletes is counted on the document as stored when Save is
    // pressed (H2-1-1): the page may have been opened before someone else
    // annotated the words it deletes. It is read again once the question is
    // answered, and asks again when what it deletes changed meanwhile. The
    // tab shows Saving from here, through the reads (REV-G1-3).
    setSaving(true);
    // What is typed in the box while a read is on its way is counted before
    // it is sent: the count goes round again when the edits changed
    // (REV-G1-4).
    let asked = '';
    for (;;) {
      const gaps = editLog.gaps();
      const loses = await lossOfSave(gaps);
      if (JSON.stringify(gaps) !== JSON.stringify(editLog.gaps())) continue;
      if (!loses || loses === asked) break;
      const yes = await confirm({
        title: t('Save baseline changes?'),
        description: loses,
        confirmLabel: t('Save anyway'),
        destructive: true,
      });
      if (!yes) {
        setSaving(false);
        return;
      }
      asked = loses;
    }
    // Typed back to what it was during a read: nothing to send.
    if (editLog.gaps().length === 0) {
      setSaving(false);
      handleCancel();
      return;
    }
    setChangedElsewhere(false);
    const sent = editLog.send();
    at.sent = sent;
    // What was sent, as the base of what is typed while it is on its way.
    setBase(shown(applyTextOps(sent.base, gapsToOps(sent.gaps))));
    const outcome = {};
    const ok = await doc.editBaselineText(sent, outcome);
    at.settled = true;
    setSaving(false);
    if (!ok && !outcome.landed) {
      editLog.unsend(sent);
      setBase(base);
      setChangedElsewhere(!!outcome.conflict);
      return;
    }
    if (ok) notifySuccess(t('Baseline text saved'));
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
  useUnsavedDraft(isEditing && editedText !== base ? t('The baseline text you have typed') : null);

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
