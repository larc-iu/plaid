import { useState, useEffect } from 'react';
import { cpLength, filterServicesByTask, TASKS } from '@larc-iu/plaid-client';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { useServiceRequest } from '../hooks/useServiceRequest.js';
import { useServiceParams } from '../hooks/useServiceParams.js';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';

// Tokenize tab operations, backed by the shared IgtDocument. Structural edits
// (split/merge/delete/create token + sentence split/merge) delegate straight to
// the domain methods, which do the optimistic patch + morpheme cleanup +
// reload-on-error; doc.sentences re-derives the token/gap `pieces` after each.
// Only the NLP-service glue, algorithm selection, and progress UI are local.
export const useTokenOperations = () => {
  const { doc } = useDocumentCtx();
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

  const [algorithm, setAlgorithmState] = useState('rule-based-punctuation');
  const [algorithmOptions, setAlgorithmOptions] = useState([
    { value: 'rule-based-punctuation', label: 'Rule-based Punctuation' },
  ]);
  const [isTokenizing, setIsTokenizing] = useState(false);
  const [tokenizationProgress, setTokenizationProgress] = useState(0);
  const [currentOperation, setCurrentOperation] = useState('');
  const [hasRestoredCache, setHasRestoredCache] = useState(false);

  // Discover services on mount.
  useEffect(() => {
    if (project?.id) discoverServices(project.id);
  }, [project?.id, discoverServices]);

  // Populate options when services change; restore cached selection once.
  // Services are matched by their declared `tasks` (legacy `tok:` id-prefix as a
  // fallback), not hard-coded prefixes.
  useEffect(() => {
    const options = [{ value: 'rule-based-punctuation', label: 'Rule-based Punctuation' }];
    filterServicesByTask(availableServices, TASKS.TOKENIZE).forEach((service) => {
      options.push({ value: `service:${service.serviceId}`, label: service.serviceName });
    });
    setAlgorithmOptions(options);
    const has = (val) => options.some((opt) => opt.value === val);

    // One-time: restore a cached selection once services have been discovered.
    if (options.length > 1 && !hasRestoredCache) {
      const cached = localStorage.getItem('plaid_tokenization_algorithm');
      if (cached && has(cached)) setAlgorithmState(cached);
      else if (cached) localStorage.removeItem('plaid_tokenization_algorithm');
      setHasRestoredCache(true);
      return;
    }
    // Every (re)discovery: if the selected service has vanished, fall back to the
    // built-in (mirrors the media tab; a no-op when the selection is still valid).
    setAlgorithmState((cur) =>
      cur.startsWith('service:') && !has(cur) ? 'rule-based-punctuation' : cur);
  }, [availableServices, hasRestoredCache]);

  const setAlgorithm = (value) => {
    setAlgorithmState(value);
    if (value) localStorage.setItem('plaid_tokenization_algorithm', value);
    else localStorage.removeItem('plaid_tokenization_algorithm');
  };

  // The selected NLP service (null for the built-in rule-based option) and its
  // user-controllable arguments.
  const selectedServiceId = algorithm.startsWith('service:') ? algorithm.slice(8) : null;
  const selectedService = selectedServiceId
    ? availableServices.find((s) => s.serviceId === selectedServiceId) || null
    : null;
  const { schema: paramSchema, values: paramValues, setParam: setParamValue, coerced: coerceParams, errors: paramErrors } =
    useServiceParams(selectedService, 'plaid_tokenization_params_');

  const updateProgress = (percent, operation) => {
    setTokenizationProgress(percent);
    setCurrentOperation(operation);
  };

  // --- Structural ops (delegate to the domain model) ---
  const splitToken = (tokenId, splitOffset) => doc.splitToken(tokenId, splitOffset);
  const deleteToken = (tokenId) => doc.deleteToken(tokenId);
  const mergeTokens = (tokenIds) => doc.mergeTokens(tokenIds);
  const mergeSentence = (sentenceId) => doc.mergeSentence(sentenceId);
  const splitSentence = (charPos) => doc.splitSentence(charPos);

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
      if (selectionStart < 0 || selectionStart + selectionLength > cpLength(spanElement.textContent)) {
        return;
      }
      const actualStart = piece.begin + selectionStart;
      const actualEnd = actualStart + selectionLength;
      await doc.createToken(actualStart, actualEnd);
    } catch (error) {
      console.error('Create token from selection:', error);
    } finally {
      selection.removeAllRanges();
    }
  };

  // --- Tokenization (built-in delegates to doc; NLP service stays here) ---
  const handleTokenize = async () => {
    // Block on unmet required service arguments before doing any work.
    if (algorithm.startsWith('service:')) {
      const missing = Object.values(paramErrors);
      if (missing.length) {
        notifyError(missing[0], 'Missing required option');
        return;
      }
    }
    setIsTokenizing(true);
    setTokenizationProgress(0);
    try {
      if (algorithm.startsWith('service:')) {
        const serviceId = algorithm.substring(8);
        const layers = doc.layerInfo;
        updateProgress(10, 'Requesting tokenization from NLP service...');
        await requestService(
          project.id,
          doc.document.id,
          serviceId,
          {
            // User-controlled arguments declared by the service, spread FIRST so
            // the fixed layer/doc params below always win over any same-named arg.
            ...coerceParams(),
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
        updateProgress(100, 'Tokenization complete!');
        await doc._reload();
        return;
      }

      updateProgress(50, 'Tokenizing…');
      const created = await doc.tokenize(); // built-in rule-based; reloads internally
      updateProgress(100, 'Tokenization complete!');
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
      setTokenizationProgress(0);
      setCurrentOperation('');
    }
  };

  const handleClearTokens = async () => {
    setIsTokenizing(true);
    updateProgress(25, 'Deleting tokens...');
    const ok = await doc.clearTokens();
    updateProgress(100, 'Tokens cleared!');
    if (ok) notifySuccess('Tokens cleared', 'Success');
    setIsTokenizing(false);
    setTokenizationProgress(0);
    setCurrentOperation('');
  };

  const handleClearSentences = async () => {
    setIsTokenizing(true);
    updateProgress(25, 'Resetting sentences...');
    const ok = await doc.clearSentences();
    updateProgress(100, 'Sentence tokens reset!');
    if (ok) notifySuccess('Reset to single sentence', 'Success');
    setIsTokenizing(false);
    setTokenizationProgress(0);
    setCurrentOperation('');
  };

  return {
    // structural ops
    splitToken,
    deleteToken,
    mergeTokens,
    mergeSentence,
    splitSentence,
    createTokenFromSelection,
    // tokenization
    handleTokenize,
    handleClearTokens,
    handleClearSentences,
    // algorithm + progress UI state
    algorithm,
    setAlgorithm,
    algorithmOptions,
    // selected-service args + summary
    selectedService,
    paramSchema,
    paramValues,
    setParamValue,
    paramErrors,
    isTokenizing,
    tokenizationProgress,
    currentOperation,
    // service discovery
    isDiscovering,
    discoverServices,
    isProcessing,
    hasServices,
    progressPercent,
    progressMessage,
  };
};
