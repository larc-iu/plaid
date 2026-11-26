import { useRef, useState } from 'react';
import { TASKS } from '@larc-iu/plaid-client';
import { ServiceDefaultsSettings } from '@ui/components/shared/ServiceDefaultsSettings.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ui/components/ui/card';
import { IGT_NAMESPACE, resolveAutoAnalysis } from '@/domain/igtConfig';
import { sameConfig, storedConfig } from '@ui/domain/configCells.js';
import { fieldIdsOf, fieldNamesOf, fieldRolesOf } from '@/domain/fieldInventory';
import {
  BUILTIN_TOKENIZE_RULE_BASED,
  BUILTIN_LINK_PRECEDENT,
  BUILTIN_DETECT_SPEECH_SILERO,
} from '@/domain/serviceDefaults';
import { t, msg } from '@ui/lib/i18n.js';

// The app's service integration spots: each is a place in the UI where an
// external service can be plugged in, keyed by the task vocabulary services
// declare in their extras. Built-ins are always-available local
// implementations a default may also point at.
const SPOTS = [
  {
    key: TASKS.TOKENIZE,
    label: msg('Tokenization'),
    description: msg('Splits the baseline text into sentences and words (the Tokenize tab).'),
    builtins: [{ name: BUILTIN_TOKENIZE_RULE_BASED, label: msg('Rule-based punctuation') }],
  },
  {
    key: TASKS.TRANSCRIBE,
    label: msg('Transcription (ASR)'),
    description: msg('Transcribes and time-aligns audio on the Media tab.'),
    builtins: [],
  },
  {
    key: TASKS.DETECT_SPEECH,
    label: msg('Speech detection'),
    description: msg('Proposes segments from the speech in a recording (the Media tab).'),
    builtins: [{ name: BUILTIN_DETECT_SPEECH_SILERO, label: msg('Silero, in the browser') }],
  },
  {
    key: TASKS.TRANSLATE,
    label: msg('Translation'),
    description: msg('Proposes a free translation for each sentence (Auto-analyze, step 1).'),
    builtins: [],
  },
  {
    key: TASKS.ANALYZE,
    label: msg('Analysis (segmentation + glosses)'),
    description: msg(
      'Proposes morpheme segmentation and glosses for words (Auto-analyze, step 3).',
    ),
    builtins: [],
  },
  {
    key: TASKS.LINK_VOCAB,
    label: msg('Auto-link vocabulary'),
    description: msg(
      'Proposes vocabulary links for unlinked words/morphemes (Auto-analyze, step 4).',
    ),
    builtins: [{ name: BUILTIN_LINK_PRECEDENT, label: msg('Follow precedent and unique matches') }],
  },
];

// A labeled checkbox in the automatic-analysis card.
function CheckRow({ id, label, hint, checked, disabled, onChange, indent = false }) {
  return (
    <div className={`flex items-start gap-2 ${indent ? 'ml-6' : ''}`}>
      <input
        type="checkbox"
        id={id}
        className="mt-0.5 h-4 w-4 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label
        htmlFor={id}
        className={`text-sm ${disabled ? 'text-muted-foreground' : 'cursor-pointer'}`}
      >
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </label>
    </div>
  );
}

// What Auto-analyze's copy step copies, and whether the dialog ticks it, in a
// card of its own: the step runs whichever method links to the lexicon, so its
// options are no one method's. These seed the dialog's "Copy previous
// analyses" step (config.igt.autoAnalysis), and everything a copy writes is
// marked unverified (violet) until a person confirms or edits it.
function CopyOptions({ draft, onChange }) {
  const set = (key) => (v) => onChange({ ...draft, [key]: v });
  const copyOn = draft.copyAnalyses;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{t('Copy previous analyses')}</CardTitle>
        <CardDescription>
          {t(
            'Copies the analysis a word is given most often onto identical words with none (Auto-analyze, step 2).',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        <CheckRow
          id="auto-analysis-copy"
          label={t('Copy analyses by default')}
          hint={t('Pre-checks the step in the Auto-analyze dialog.')}
          checked={draft.copyAnalyses}
          onChange={set('copyAnalyses')}
        />
        <div className="ml-6 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t('What a copy includes:')}</p>
          <CheckRow
            id="auto-analysis-copy-seg"
            indent
            label={t('Morpheme segmentation (forms and types)')}
            checked={draft.copySegmentation}
            disabled={!copyOn}
            onChange={set('copySegmentation')}
          />
          <CheckRow
            id="auto-analysis-copy-links"
            indent
            label={t('Lexicon links')}
            checked={draft.copyLinks}
            disabled={!copyOn}
            onChange={set('copyLinks')}
          />
          <CheckRow
            id="auto-analysis-copy-fields"
            indent
            label={t('Annotation values (glosses, POS, …)')}
            checked={draft.copyFields}
            disabled={!copyOn}
            onChange={set('copyFields')}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// Project-level Services settings. The registry, the spot cards and the saving
// are shared with plaid-ud; what is this app's is the list of spots, and the
// copy step's options, which ride along in the same Save under a second config
// key.
export const ServicesSettings = ({ projectId, client }) => {
  const [autoDraft, setAutoDraft] = useState(resolveAutoAnalysis(null));
  const [autoDirty, setAutoDirty] = useState(false);
  const [autoStored, setAutoStored] = useState(undefined);
  // The options as they are now, and as the Save on the wire sent them. A
  // change made while that Save is out stays unsaved when it lands.
  const autoNow = useRef(autoDraft);
  autoNow.current = autoDraft;
  const autoSent = useRef(null);

  const setAutoAnalysis = (next) => {
    setAutoDraft(next);
    setAutoDirty(true);
  };

  return (
    <ServiceDefaultsSettings
      showConfidence
      fieldsOf={fieldNamesOf}
      fieldRolesOf={fieldRolesOf}
      fieldIdsOf={fieldIdsOf}
      projectId={projectId}
      client={client}
      spots={SPOTS}
      onProjectLoaded={(project) => {
        setAutoDraft(resolveAutoAnalysis(project?.config));
        setAutoStored(storedConfig(project, IGT_NAMESPACE, 'autoAnalysis'));
        setAutoDirty(false);
      }}
      extraDirty={autoDirty}
      // Written only when changed, expecting what the page read, in the same
      // batch as the defaults.
      saveExtra={(b) => {
        autoSent.current = autoDraft;
        b.projects.setConfig(projectId, IGT_NAMESPACE, 'autoAnalysis', autoDraft, undefined, {
          expected: autoStored,
        });
      }}
      onExtraSaved={() => {
        setAutoStored(autoSent.current);
        setAutoDirty(!sameConfig(autoNow.current, autoSent.current));
      }}
    >
      <CopyOptions draft={autoDraft} onChange={setAutoAnalysis} />
    </ServiceDefaultsSettings>
  );
};
