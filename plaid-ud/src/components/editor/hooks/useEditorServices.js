import { useCallback, useEffect, useMemo, useRef } from 'react';
import { TASKS } from '@larc-iu/plaid-client';
import { useServiceRequest } from '@ui/hooks/useServiceRequest.js';
import { useServiceSpot } from '@ui/hooks/useServiceSpot.js';
import { useRunProgress, useMirroredProgress } from '@ui/hooks/useRunProgress.js';
import { writeRunRecord, clearRunRecord } from '@ui/domain/runRecord.js';
import { notifySuccess, notifyError } from '../../../utils/notify.js';
import { BUILTIN_TOKENIZE_SEGMENTER, languageParamSeed } from '../../../utils/serviceDefaults.js';
import { readProjectLanguage } from '../../../utils/udLayerUtils.js';
import { parseNotice } from '../../../domain/parseNotice.js';

// How long a service may say NOTHING, not a cap on the run: the client
// restarts this clock on every progress event. A model load plus a neural
// pipeline is one long quiet stretch, so it is generous.
const PARSE_SILENCE_MS = 5 * 60 * 1000;

// The browser's own segmenter, always available. It reads the project's
// tokenizer locale and declares no options of its own.
const TOKENIZE_BUILTINS = [
  {
    name: BUILTIN_TOKENIZE_SEGMENTER,
    label: 'Unicode segmentation (this browser)',
    description: "sentences and words by the project's tokenizer locale",
  },
];

// The editor's two integration spots, Parse and Tokenize, on the idiom every
// service run in every app wears (see @ui/components/services).
//
// One `useServiceRequest` for both, deliberately: the write lock already allows
// one run at a time on a document, so a second request could never be in
// flight, and sharing means Stop and the progress line always name whatever is
// actually running. Discovery happens once here rather than once per spot.
//
// The shell owns this hook and hands it down, so the Text Editor's dialog and
// the Annotate toolbar's button are the same run, not two.
export const useEditorServices = ({ client, projectId, doc, project, acquireWriteLock }) => {
  const {
    availableServices,
    isDiscovering,
    discoverServices,
    requestService,
    cancelRequest,
    isProcessing,
    progressPercent,
    progressMessage,
  } = useServiceRequest(client);

  useEffect(() => {
    if (projectId) discoverServices(projectId);
  }, [projectId, discoverServices]);

  const projectLanguage = useMemo(() => readProjectLanguage(project), [project]);
  // Answered from the project itself, and so the lowest layer of the merge:
  // whatever a maintainer set for this spot, or this user last ran with, wins.
  const seedLanguage = useCallback(
    (schema) => languageParamSeed(schema, projectLanguage),
    [projectLanguage],
  );

  const parseSpot = useServiceSpot({
    task: TASKS.PARSE,
    project,
    services: availableServices,
    storageId: 'parse',
    seedParams: seedLanguage,
  });
  const tokenizeSpot = useServiceSpot({
    task: TASKS.TOKENIZE,
    project,
    services: availableServices,
    builtins: TOKENIZE_BUILTINS,
    storageId: 'tokenize',
  });

  const parseRun = useRunProgress();
  const tokenizeRun = useRunProgress();
  useMirroredProgress(parseRun, {
    percent: progressPercent,
    message: progressMessage,
    active: parseRun.running,
  });
  useMirroredProgress(tokenizeRun, {
    percent: progressPercent,
    message: progressMessage,
    active: tokenizeRun.running && !!tokenizeSpot.service,
  });

  // The banner is the only surface once the dialog is shut and the user has
  // moved to the other tab.
  const lockRef = useRef(null);
  useEffect(() => {
    if (progressMessage) lockRef.current?.setStatus(progressMessage);
  }, [progressMessage]);

  // One service run, start to finish: the lock, the record, the request, the
  // reload. `args` are merged under the fixed ones the app supplies.
  const runService = useCallback(
    async ({ spot, run, label, serviceId, args, timeout, copy }) => {
      const missing = Object.values(spot.params.errors);
      if (missing.length) {
        notifyError(missing[0], 'Missing required option');
        return;
      }
      const lock = acquireWriteLock(label, { onCancel: cancelRequest });
      if (!lock) return;
      lockRef.current = lock;
      run.start([label]);
      let stillOut = false; // the request survived our giving up on it
      try {
        await requestService(
          projectId,
          doc.id,
          serviceId,
          // The service's own declared arguments spread FIRST, so the fixed
          // ones below always win over a same-named argument.
          { ...spot.params.coerced(), ...args },
          {
            timeout,
            ...copy,
            // Written down before the request is submitted, so a reload in
            // that window can still find the run.
            onRequestId: (requestId) => writeRunRecord(doc.id, { requestId, projectId, label }),
          },
        );
        // Re-reading a large document is seconds of work, so it is named
        // rather than left as dead air.
        run.report({ percent: null, message: 'Loading results…' });
        lock.setStatus('Loading results…');
        await doc._reload();
      } catch (error) {
        // requestService has already said it out loud; log so a failed run
        // does not toast twice.
        console.error(`${label} failed:`, error);
        stillOut = error?.pending === true;
      } finally {
        if (!stillOut) clearRunRecord(doc.id);
        run.finish();
        lockRef.current = null;
        lock.release();
      }
    },
    [acquireWriteLock, cancelRequest, requestService, projectId, doc],
  );

  const runParse = useCallback(
    () =>
      runService({
        spot: parseSpot,
        run: parseRun,
        label: 'Parse',
        serviceId: parseSpot.service?.serviceId,
        args: { documentId: doc.id },
        timeout: PARSE_SILENCE_MS,
        copy: {
          successTitle: 'Parsed',
          successMessage: 'The parser finished.',
          errorTitle: 'Parse failed',
          errorMessage: 'The parse did not run.',
          stoppedTitle: 'Parse',
          // This parser's write phase is one critical block with no checkpoint
          // in it, so a run it reports as stopped stopped before writing.
          stoppedMessage: 'Nothing was written.',
          // The service authors the words and picks the severity. A run that
          // skipped every sentence warns rather than congratulates (C8).
          notice: parseNotice,
        },
      }),
    [runService, parseSpot, parseRun, doc],
  );

  // The built-in runs here in the browser and reloads on its own, so it takes
  // the lock but writes no record: it dies with the page that started it.
  const runBuiltinTokenize = useCallback(
    async (textContent) => {
      const lock = acquireWriteLock('Tokenize');
      if (!lock) return;
      tokenizeRun.start(['Tokenize']);
      try {
        const ok = await doc.tokenize(textContent);
        if (ok) notifySuccess('The document is tokenized.', 'Tokenized');
      } finally {
        tokenizeRun.finish();
        lock.release();
      }
    },
    [acquireWriteLock, doc, tokenizeRun],
  );

  const runTokenize = useCallback(
    (textContent) => {
      if (!tokenizeSpot.service) return runBuiltinTokenize(textContent);
      const layers = doc.layerInfo;
      return runService({
        spot: tokenizeSpot,
        run: tokenizeRun,
        label: 'Tokenize',
        serviceId: tokenizeSpot.service.serviceId,
        args: {
          documentId: doc.id,
          textLayerId: layers.textLayer?.id,
          sentenceLayerId: layers.sentenceTokenLayer?.id,
          primaryTokenLayerId: layers.wordTokenLayer?.id,
        },
        copy: {
          successTitle: 'Tokenized',
          successMessage: 'The document is tokenized.',
          errorTitle: 'Tokenize failed',
          errorMessage: 'The tokenizer did not run.',
          stoppedTitle: 'Tokenize',
        },
      });
    },
    [runBuiltinTokenize, runService, tokenizeSpot, tokenizeRun, doc],
  );

  return {
    isDiscovering,
    isProcessing,
    cancelRequest,
    discoverServices: useCallback(() => discoverServices(projectId), [discoverServices, projectId]),
    parse: { spot: parseSpot, run: parseRun, start: runParse, cancel: cancelRequest },
    tokenize: { spot: tokenizeSpot, run: tokenizeRun, start: runTokenize, cancel: cancelRequest },
  };
};
