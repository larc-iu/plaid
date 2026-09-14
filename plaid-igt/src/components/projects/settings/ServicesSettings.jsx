import { useState } from 'react';
import { TASKS } from '@larc-iu/plaid-client';
import { ServiceDefaultsSettings } from '@ui/components/shared/ServiceDefaultsSettings.jsx';
import { IGT_NAMESPACE, resolveAutoAnalysis } from '@/domain/igtConfig';
import {
  BUILTIN_TOKENIZE_RULE_BASED,
  BUILTIN_LINK_PRECEDENT,
  BUILTIN_DETECT_SPEECH_SILERO,
} from '@/domain/serviceDefaults';

// The app's service integration spots: each is a place in the UI where an
// external service can be plugged in, keyed by the task vocabulary services
// declare in their extras. Built-ins are always-available local
// implementations a default may also point at.
const SPOTS = [
  {
    key: TASKS.TOKENIZE,
    label: 'Tokenization',
    description: 'Splits the baseline text into sentences and words (the Tokenize tab).',
    builtins: [{ name: BUILTIN_TOKENIZE_RULE_BASED, label: 'Rule-based punctuation' }],
  },
  {
    key: TASKS.TRANSCRIBE,
    label: 'Transcription (ASR)',
    description: 'Transcribes and time-aligns audio on the Media tab.',
    builtins: [],
  },
  {
    key: TASKS.DETECT_SPEECH,
    label: 'Speech detection',
    description: 'Proposes segments from the speech in a recording (the Media tab).',
    builtins: [{ name: BUILTIN_DETECT_SPEECH_SILERO, label: 'Silero, in the browser' }],
  },
  {
    key: TASKS.TRANSLATE,
    label: 'Translation',
    description: 'Proposes a free translation for each sentence (Auto-analyze, step 1).',
    builtins: [],
  },
  {
    key: TASKS.ANALYZE,
    label: 'Analysis (segmentation + glosses)',
    description: 'Proposes morpheme segmentation and glosses for words (Auto-analyze, step 3).',
    builtins: [],
  },
  {
    key: TASKS.LINK_VOCAB,
    label: 'Auto-link vocabulary',
    description: 'Proposes vocabulary links for unlinked words/morphemes (Auto-analyze, step 4).',
    builtins: [{ name: BUILTIN_LINK_PRECEDENT, label: 'Follow precedent & unique matches' }],
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

// The built-in link rule's own options, shown inline when it's the selected
// default in the Auto-link spot — the built-in is just another method in that
// list, so its options live with it rather than in a card of their own. These
// seed the Auto-analyze dialog's "copy previous analyses" step
// (config.igt.autoAnalysis); the built-in never runs on its own, and everything
// a copy writes is marked unverified (violet) until a person confirms or edits it.
function BuiltinLinkOptions({ draft, onChange }) {
  const set = (key) => (v) => onChange({ ...draft, [key]: v });
  const copyOn = draft.copyAnalyses;
  return (
    <div className="space-y-2.5">
      <CheckRow
        id="auto-analysis-copy"
        label="Also copy analyses by default"
        hint="Pre-checks the Auto-analyze dialog's step that copies a word's prior full analysis (uncontested project-wide majority) onto identical unanalyzed words. Only words with no analysis at all are touched."
        checked={draft.copyAnalyses}
        onChange={set('copyAnalyses')}
      />
      <div className="ml-6 space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">What a copy includes:</p>
        <CheckRow
          id="auto-analysis-copy-seg"
          indent
          label="Morpheme segmentation (forms and types)"
          checked={draft.copySegmentation}
          disabled={!copyOn}
          onChange={set('copySegmentation')}
        />
        <CheckRow
          id="auto-analysis-copy-links"
          indent
          label="Lexicon links"
          checked={draft.copyLinks}
          disabled={!copyOn}
          onChange={set('copyLinks')}
        />
        <CheckRow
          id="auto-analysis-copy-fields"
          indent
          label="Annotation values (glosses, POS, …)"
          checked={draft.copyFields}
          disabled={!copyOn}
          onChange={set('copyFields')}
        />
      </div>
    </div>
  );
}

// Project-level Services settings. The registry, the spot cards and the saving
// are shared with plaid-ud; what is this app's is the list of spots, and the
// built-in link rule's own options, which ride along in the same Save under a
// second config key.
export const ServicesSettings = ({ projectId, client }) => {
  const [autoDraft, setAutoDraft] = useState(resolveAutoAnalysis(null));
  const [autoDirty, setAutoDirty] = useState(false);

  const setAutoAnalysis = (next) => {
    setAutoDraft(next);
    setAutoDirty(true);
  };

  return (
    <ServiceDefaultsSettings
      projectId={projectId}
      client={client}
      spots={SPOTS}
      onProjectLoaded={(project) => {
        setAutoDraft(resolveAutoAnalysis(project?.config));
        setAutoDirty(false);
      }}
      extraDirty={autoDirty}
      saveExtra={async () => {
        await client.projects.setConfig(projectId, IGT_NAMESPACE, 'autoAnalysis', autoDraft);
        setAutoDirty(false);
      }}
      builtinOptions={(spotKey, name) =>
        spotKey === TASKS.LINK_VOCAB && name === BUILTIN_LINK_PRECEDENT ? (
          <BuiltinLinkOptions draft={autoDraft} onChange={setAutoAnalysis} />
        ) : null
      }
    />
  );
};
