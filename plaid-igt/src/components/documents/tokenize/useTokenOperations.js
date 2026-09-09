import { useState, useEffect, useRef } from 'react';
import { cpLength, cpSlice, TASKS } from '@larc-iu/plaid-client';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { useServiceRequest } from '../hooks/useServiceRequest.js';
import { useServiceSpot } from '../hooks/useServiceSpot.js';
import { useRunProgress, useMirroredProgress } from '../hooks/useRunProgress.js';
import {
  countAnnotationLossForWord,
  countSubWordAnnotationLoss,
  countReTokenizeLoss,
} from '../../../domain/annotationLoss.js';
import { BUILTIN_TOKENIZE_RULE_BASED } from '../../../domain/serviceDefaults.js';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';

// The rule-based tokenizer is always available and declares no options.
const TOKENIZE_BUILTINS = [
  {
    name: BUILTIN_TOKENIZE_RULE_BASED,
    label: 'Built-in (rule-based punctuation)',
    description: 'finds words only; sentence boundaries stay as they are',
  },
];

// Tokenize tab operations, backed by the shared IgtDocument. Structural edits
// (split/merge/delete/create token + sentence split/merge) delegate straight to
// the domain methods, which do the optimistic patch + morpheme cleanup +
// reload-on-error; doc.sentences re-derives the token/gap `pieces` after each.
// Only the service glue, method selection, and progress are local.
export const useTokenOperations = () => {
  const { doc, acquireWriteLock } = useDocumentCtx();
  useIgtDocument(doc);
  const project = doc.project;

  const {
    availableServices,
    isDiscovering,
    discoverServices,
    isProcessing,
    requestService,
    hasServices,
    progressPercent,
    progressMessage,
  } = useServiceRequest();

  const [isTokenizing, setIsTokenizing] = useState(false);

  // Discover services on mount.
  useEffect(() => {
    if (project?.id) discoverServices(project.id);
  }, [project?.id, discoverServices]);

  const spot = useServiceSpot({
    task: TASKS.TOKENIZE,
    project,
    services: availableServices,
    builtins: TOKENIZE_BUILTINS,
    storageId: 'tokenize',
  });
  const tokenizeRun = useRunProgress();
  useMirroredProgress(tokenizeRun, {
    percent: progressPercent,
    message: progressMessage,
    active: tokenizeRun.running && !!spot.service,
  });

  // --- Structural ops (delegate to the domain model) ---
  // splitToken / mergeTokens are defined below — both gated by an annotation-loss
  // confirm, since they delete the affected words' morphemes (and their glosses).

  // Token deletion: "delete or don't" — deletion is FINAL. (The old Undo
  // toast restored only IGT's own layers, silently losing other apps'
  // annotations on the same word while reporting success.) Unannotated
  // tokens delete instantly (the high-frequency mid-tokenization case); a
  // token carrying annotations — IGT's own or another app's, e.g. UD
  // material invisible here — opens a count-based confirm instead
  // (pendingDelete drives the dialog in DocumentTokenize).
  const [pendingDelete, setPendingDelete] = useState(null); // {tokenId, content, annotations, links}
  // All structural doc mutations from this tab are funneled through one
  // promise chain (same idiom as the Analyze island's _run). IgtDocument's
  // _withSaving is single-flight — it DROPS a call that overlaps an in-flight
  // one — so two quick clicks used to lose the second silently.
  const chainRef = useRef(Promise.resolve());
  const run = (fn) => {
    const next = chainRef.current.then(fn);
    chainRef.current = next.catch(() => {});
    return next;
  };
  const deleteToken = async (tokenId) => {
    const word = (doc.layerInfo.primaryTokenLayer?.tokens || []).find((t) => t.id === tokenId);
    const loss = countAnnotationLossForWord(doc.layerInfo, doc.vocabularies, word);
    if (loss.annotations + loss.links === 0) return run(() => doc.deleteToken(tokenId));
    setPendingDelete({
      tokenId,
      content: word ? cpSlice(doc.body || '', word.begin, word.end) : 'this token',
      ...loss,
    });
    return false; // nothing deleted yet — the dialog decides
  };
  const confirmPendingDelete = async () => {
    if (!pendingDelete) return false;
    const { tokenId } = pendingDelete;
    setPendingDelete(null);
    return run(() => doc.deleteToken(tokenId));
  };
  const cancelPendingDelete = () => setPendingDelete(null);

  // Split and merge cascade-delete the affected words' (full-width) morphemes
  // and their morpheme-scope glosses — silent data loss unless we warn, exactly
  // as deleteToken does. Word-scope spans survive (split resizes, merge
  // reparents), so only sub-word loss is counted. pendingStructural drives a
  // confirm dialog in DocumentTokenize; null means the op already ran (nothing
  // to lose).
  const [pendingStructural, setPendingStructural] = useState(null); // {kind, payload, label, annotations, links}
  const splitToken = async (tokenId, splitOffset) => {
    const word = (doc.layerInfo.primaryTokenLayer?.tokens || []).find((t) => t.id === tokenId);
    const loss = countSubWordAnnotationLoss(doc.layerInfo, doc.vocabularies, word ? [word] : []);
    if (loss.annotations + loss.links === 0) return run(() => doc.splitToken(tokenId, splitOffset));
    setPendingStructural({
      kind: 'split',
      payload: { tokenId, splitOffset },
      label: word ? cpSlice(doc.body || '', word.begin, word.end) : 'this word',
      ...loss,
    });
    return false; // nothing changed yet — the dialog decides
  };
  const mergeTokens = async (tokenIds) => {
    const ids = tokenIds instanceof Set ? Array.from(tokenIds) : Array.from(tokenIds || []);
    const words = (doc.layerInfo.primaryTokenLayer?.tokens || []).filter((t) => ids.includes(t.id));
    const loss = countSubWordAnnotationLoss(doc.layerInfo, doc.vocabularies, words);
    if (loss.annotations + loss.links === 0) return run(() => doc.mergeTokens(ids));
    setPendingStructural({
      kind: 'merge',
      payload: { ids },
      label: words.map((w) => cpSlice(doc.body || '', w.begin, w.end)).join(' + ') || 'these words',
      ...loss,
    });
    return false;
  };
  const confirmPendingStructural = async () => {
    if (!pendingStructural) return false;
    const p = pendingStructural;
    setPendingStructural(null);
    return run(() =>
      p.kind === 'split'
        ? doc.splitToken(p.payload.tokenId, p.payload.splitOffset)
        : doc.mergeTokens(p.payload.ids),
    );
  };
  const cancelPendingStructural = () => setPendingStructural(null);
  const mergeSentence = (sentenceId) => run(() => doc.mergeSentence(sentenceId));
  const splitSentence = (charPos) => run(() => doc.splitSentence(charPos));

  // Create a token from a DOM text selection inside an untokenized `piece`.
  // The Range math (mapping the selection to char offsets) must stay here since
  // it depends on the rendered DOM; the actual create delegates to the domain.
  const createTokenFromSelection = async (event, piece) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    const spanElement = event.target;
    try {
      const spanRange = document.createRange();
      spanRange.setStart(spanElement.firstChild || spanElement, 0);
      spanRange.setEnd(range.startContainer, range.startOffset);
      // Code-point counts: piece.begin / token offsets are code points, and the
      // DOM Range strings are UTF-16, so measure them in code points too.
      const selectionStart = cpLength(spanRange.toString());
      const selectionLength = cpLength(selectedText);
      if (
        selectionStart < 0 ||
        selectionStart + selectionLength > cpLength(spanElement.textContent)
      ) {
        return;
      }
      const actualStart = piece.begin + selectionStart;
      const actualEnd = actualStart + selectionLength;
      await run(() => doc.createToken(actualStart, actualEnd));
    } catch (error) {
      console.error('Create token from selection:', error);
    } finally {
      selection.removeAllRanges();
    }
  };

  // --- Tokenization (built-in delegates to doc; NLP service stays here) ---
  // Run an NLP tokenization service. `overwrite` is granted only after the user
  // confirms a destructive re-tokenize (see handleTokenize / pendingTokenize).
  const runServiceTokenize = async (serviceId, { overwrite = false } = {}) => {
    // Held for the whole run: it rewrites the token layers and ends in a
    // reload, so nothing may be edited underneath it.
    const release = acquireWriteLock('Tokenize');
    if (!release) return;
    setIsTokenizing(true);
    tokenizeRun.start(['Tokenize']);
    try {
      const layers = doc.layerInfo;
      await requestService(
        project.id,
        doc.document.id,
        serviceId,
        {
          // User-controlled arguments declared by the service, spread FIRST so
          // the fixed layer/doc params below always win over any same-named arg.
          ...spot.params.coerced(),
          // Granted by the user's confirm — lets the run discard the existing
          // annotations the sentence-partition reset cascade-deletes.
          ...(overwrite ? { overwrite: true } : {}),
          documentId: doc.document.id,
          textLayerId: layers.primaryTextLayer?.id,
          primaryTokenLayerId: layers.primaryTokenLayer.id,
          sentenceLayerId: layers.sentenceTokenLayer?.id,
        },
        {
          successTitle: 'Tokenization Complete',
          successMessage: 'Document has been tokenized successfully',
          errorTitle: 'Tokenization Failed',
          errorMessage: 'An error occurred during tokenization',
        },
      );
      // Re-reading the document after a service run is seconds of work on a
      // large one, so it is named rather than left as dead air.
      tokenizeRun.report({ percent: null, message: 'Loading the tokens…' });
      await doc._reload();
    } catch (error) {
      // useServiceRequest already shows an error toast (errorTitle/errorMessage);
      // just log here so a failed run doesn't double-toast.
      console.error('Tokenization failed:', error);
    } finally {
      setIsTokenizing(false);
      tokenizeRun.finish();
      release();
    }
  };

  // A service re-tokenize of a single-sentence doc resets the sentence partition,
  // cascade-deleting existing word/morpheme/sentence annotations. Surface that as
  // a confirm (pendingTokenize drives the dialog in DocumentTokenize); on approval
  // we re-run granting overwrite. null = nothing destructive / not pending.
  const [pendingTokenize, setPendingTokenize] = useState(null); // {serviceId, annotations, links}
  const handleTokenize = async () => {
    if (spot.service) {
      // Block on unmet required service arguments before doing any work.
      const missing = Object.values(spot.params.errors);
      if (missing.length) {
        notifyError(missing[0], 'Missing required option');
        return;
      }
      const serviceId = spot.service.serviceId;
      const loss = countReTokenizeLoss(doc.layerInfo, doc.vocabularies);
      if (loss.annotations + loss.links > 0) {
        setPendingTokenize({ serviceId, ...loss });
        return; // the dialog decides
      }
      return runServiceTokenize(serviceId, { overwrite: false });
    }

    // Built-in rule-based tokenizer fills untokenized ranges only — non-destructive.
    // It still writes and reloads, so it takes the lock like the service path.
    const release = acquireWriteLock('Tokenize');
    if (!release) return;
    setIsTokenizing(true);
    tokenizeRun.start(['Tokenize']);
    try {
      const created = await doc.tokenize(); // built-in rule-based; reloads internally
      // null = failure (already toasted by the domain via doc.onError); 0 = nothing
      // to do; N = created.
      if (created === null) return;
      if (created > 0) notifySuccess(`Created ${created} tokens`, 'Success');
      else notifyInfo('Text is already fully tokenized', 'Complete');
    } catch (error) {
      console.error('Tokenization failed:', error);
      notifyError(error.message || 'An error occurred during tokenization', 'Tokenization Failed');
    } finally {
      setIsTokenizing(false);
      tokenizeRun.finish();
      release();
    }
  };
  const confirmPendingTokenize = async () => {
    if (!pendingTokenize) return;
    const { serviceId } = pendingTokenize;
    setPendingTokenize(null);
    return runServiceTokenize(serviceId, { overwrite: true });
  };
  const cancelPendingTokenize = () => setPendingTokenize(null);

  const handleClearTokens = async () => {
    setIsTokenizing(true);
    const ok = await doc.clearTokens();
    if (ok) notifySuccess('Tokens cleared', 'Success');
    setIsTokenizing(false);
  };

  const handleClearSentences = async () => {
    setIsTokenizing(true);
    const ok = await doc.clearSentences();
    if (ok) notifySuccess('Reset to single sentence', 'Success');
    setIsTokenizing(false);
  };

  return {
    // structural ops
    splitToken,
    deleteToken,
    pendingDelete,
    confirmPendingDelete,
    cancelPendingDelete,
    mergeTokens,
    pendingStructural,
    confirmPendingStructural,
    cancelPendingStructural,
    pendingTokenize,
    confirmPendingTokenize,
    cancelPendingTokenize,
    mergeSentence,
    splitSentence,
    createTokenFromSelection,
    // tokenization
    handleTokenize,
    handleClearTokens,
    handleClearSentences,
    // method + run clock
    spot,
    tokenizeRun,
    isTokenizing,
    // service discovery
    isDiscovering,
    discoverServices,
    isProcessing,
    hasServices,
  };
};
