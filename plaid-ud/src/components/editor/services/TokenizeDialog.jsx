import { Scissors } from 'lucide-react';
import { ServiceSpotDialog } from '@ui/components/services/ServiceSpotDialog.jsx';

// Tokenizing: the button in the Text Editor toolbar and the dialog behind it.
//
// The browser's own segmenter sits in the method list beside any tokenize
// service the project has, so bringing your own tokenizer changes nothing else
// about the gesture. Results are the tokens in the panel underneath, so the
// dialog carries nothing but the method and what would block a run.
// `onOpen` looks for services again each time the dialog opens.
export function TokenizeDialog({
  tokenize,
  text,
  writeLockHeld,
  blockedHint = null,
  onOpen = null,
}) {
  const { spot } = tokenize;
  return (
    <ServiceSpotDialog
      label="Tokenize"
      icon={Scissors}
      description="Splits the saved text into sentences, tokens and words."
      run={tokenize.run}
      spot={spot}
      onRun={() => tokenize.start(text)}
      // Only a service run can be stopped. The browser's segmenter is local
      // and finishes in one pass.
      onCancel={spot.service ? tokenize.cancel : undefined}
      writeLock={writeLockHeld}
      blockedHint={blockedHint}
      onOpen={onOpen}
    />
  );
}
