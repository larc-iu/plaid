import { useCallback, useEffect, useMemo } from 'react';
import { TASKS } from '@larc-iu/plaid-client';
import { useServiceRequest } from '@ui/hooks/useServiceRequest.js';
import { useServiceRun } from '@ui/hooks/useServiceRun.js';
import { useRunProgress } from '@ui/hooks/useRunProgress.js';
import { notifySuccess } from '../../../utils/feedback.jsx';
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
  const request = useServiceRequest(client);
  const { isDiscovering, discoverServices, cancelRequest, isProcessing } = request;

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

  const parse = useServiceRun({
    request,
    task: TASKS.PARSE,
    storageId: 'parse',
    seedParams: seedLanguage,
    project,
    projectId,
    doc,
    acquireWriteLock,
    label: 'Parse',
    timeout: PARSE_SILENCE_MS,
    copy: {
      successTitle: 'Parsed',
      successMessage: 'The parser finished.',
      errorTitle: 'Parse failed',
      errorMessage: 'The parse did not run.',
      stoppedTitle: 'Parse',
      // This parser's write phase is one critical block with no checkpoint in
      // it, so a run it reports as stopped stopped before writing.
      stoppedMessage: 'Nothing was written.',
      // The service authors the words and picks the severity. A run that
      // skipped every sentence warns rather than congratulates (C8).
      notice: parseNotice,
    },
  });

  const tokenize = useServiceRun({
    request,
    task: TASKS.TOKENIZE,
    storageId: 'tokenize',
    builtins: TOKENIZE_BUILTINS,
    project,
    projectId,
    doc,
    acquireWriteLock,
    label: 'Tokenize',
    copy: {
      successTitle: 'Tokenized',
      successMessage: 'The document is tokenized.',
      errorTitle: 'Tokenize failed',
      errorMessage: 'The tokenizer did not run.',
      stoppedTitle: 'Tokenize',
    },
  });

  // The builtin runs in the browser, so it reports its own progress rather than
  // the request's; it still needs a run to show in the banner.
  const builtinRun = useRunProgress();

  // The built-in runs here in the browser and reloads on its own, so it takes
  // the lock but writes no record: it dies with the page that started it.
  const runBuiltinTokenize = useCallback(
    async (textContent) => {
      const lock = acquireWriteLock('Tokenize');
      if (!lock) return;
      builtinRun.start(['Tokenize']);
      try {
        const ok = await doc.tokenize(textContent);
        if (ok) notifySuccess('The document is tokenized.', 'Tokenized');
      } finally {
        builtinRun.finish();
        lock.release();
      }
    },
    [acquireWriteLock, doc, builtinRun],
  );

  const runTokenize = useCallback(
    (textContent) => {
      if (!tokenize.spot.service) return runBuiltinTokenize(textContent);
      const layers = doc.layerInfo;
      return tokenize.start({
        textLayerId: layers.textLayer?.id,
        sentenceLayerId: layers.sentenceTokenLayer?.id,
        primaryTokenLayerId: layers.wordTokenLayer?.id,
      });
    },
    [runBuiltinTokenize, tokenize, doc],
  );

  return {
    isDiscovering,
    isProcessing,
    cancelRequest,
    discoverServices: useCallback(() => discoverServices(projectId), [discoverServices, projectId]),
    parse,
    // The banner watches whichever run is out: the service's, or the builtin's.
    tokenize: {
      ...tokenize,
      run: tokenize.spot.service ? tokenize.run : builtinRun,
      start: runTokenize,
    },
  };
};
