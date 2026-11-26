import { useCallback, useEffect, useMemo } from 'react';
import { msg, t } from '@ui/lib/i18n.js';
import { TASKS } from '@larc-iu/plaid-client';
import { useServiceRequest } from '@ui/hooks/useServiceRequest.js';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { lossPhrase } from '@ui/domain/annotationLoss.js';
import { useServiceRun } from '@ui/hooks/useServiceRun.js';
import { notifySuccess } from '../../../utils/feedback.jsx';
import { BUILTIN_TOKENIZE_SEGMENTER, languageParamSeed } from '../../../utils/serviceDefaults.js';
import { readProjectLanguage } from '../../../domain/udConfig.js';
import { parseNotice } from '../../../domain/parseNotice.js';
import { tokenizeNotice } from '../../../domain/tokenizeNotice.js';

// How long a service may say NOTHING, not a cap on the run: the client
// restarts this clock on every progress event. A model load plus a neural
// pipeline is one long quiet stretch, so it is generous.
const PARSE_SILENCE_MS = 5 * 60 * 1000;

// The browser's own segmenter, always available. It reads the project's
// tokenizer locale and declares no options of its own. Its label and
// description are messages, put in the page's language where the hook reads
// them.
const TOKENIZE_BUILTINS = [
  {
    name: BUILTIN_TOKENIZE_SEGMENTER,
    label: msg('Unicode segmentation (this browser)'),
    description: msg("Sentences by line, tokens and words by the project's tokenizer locale"),
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
  const confirm = useConfirm();
  const { isDiscovering, discoverServices } = request;

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
    label: t('Parse'),
    timeout: PARSE_SILENCE_MS,
    copy: {
      successTitle: t('Parsed'),
      successMessage: t('The parser finished.'),
      errorTitle: t('Failed to parse'),
      errorMessage: t('The parse did not run.'),
      stoppedTitle: t('Parse'),
      // The words for the counts the service reports. A run that skipped
      // every sentence warns rather than congratulates (C8).
      notice: parseNotice,
    },
  });

  const tokenizeBuiltins = useMemo(
    () =>
      TOKENIZE_BUILTINS.map((b) => ({ ...b, label: t(b.label), description: t(b.description) })),
    [],
  );

  const tokenize = useServiceRun({
    request,
    task: TASKS.TOKENIZE,
    storageId: 'tokenize',
    builtins: tokenizeBuiltins,
    project,
    projectId,
    doc,
    acquireWriteLock,
    label: t('Tokenize'),
    copy: {
      successTitle: t('Tokenized'),
      successMessage: t('The tokenizer finished.'),
      errorTitle: t('Failed to tokenize'),
      errorMessage: t('The tokenizer did not run.'),
      stoppedTitle: t('Tokenize'),
      notice: tokenizeNotice,
    },
  });

  // The built-in runs here in the browser and reloads on its own, so it takes
  // the lock, which the banner shows, but writes no record: it dies with the
  // page that started it.
  const runBuiltinTokenize = useCallback(
    async (textContent) => {
      const lock = acquireWriteLock(t('Tokenize'));
      if (!lock) return;
      try {
        const ok = await doc.tokenize(textContent);
        if (ok) notifySuccess(t('Tokenized'));
      } finally {
        lock.release();
      }
    },
    [acquireWriteLock, doc],
  );

  // `overwrite` is the service's leave to delete a person's work, given when
  // the person was asked about it and said yes.
  const runTokenize = useCallback(
    (textContent, { overwrite = false, version = null } = {}) => {
      if (!tokenize.spot.service) return runBuiltinTokenize(textContent);
      const layers = doc.layerInfo;
      return tokenize.start({
        ...(overwrite ? { overwrite: true } : {}),
        ...(overwrite && version != null ? { expectVersion: version } : {}),
        textLayerId: layers.textLayer?.id,
        sentenceLayerId: layers.sentenceTokenLayer?.id,
        primaryTokenLayerId: layers.wordTokenLayer?.id,
      });
    },
    [runBuiltinTokenize, tokenize, doc],
  );

  // A parse that makes the sentences asks first when they can take relations
  // another layer keeps inside one sentence, as Tokenize does (REV-N5-CORE
  // F3). Both toolbars start the run here, so both ask.
  const startParse = useCallback(
    async (...args) => {
      const loss = lossPhrase(doc?.parseLoss() ?? {});
      if (loss) {
        const ok = await confirm({
          title: t('Parse?'),
          description: t('Deletes up to {loss}.', { loss }),
          confirmLabel: t('Parse'),
          destructive: true,
        });
        if (!ok) return;
      }
      return parse.start(...args);
    },
    [doc, confirm, parse],
  );

  return {
    isDiscovering,
    discoverServices: useCallback(() => discoverServices(projectId), [discoverServices, projectId]),
    parse: { ...parse, start: startParse },
    tokenize: { ...tokenize, start: runTokenize },
  };
};
