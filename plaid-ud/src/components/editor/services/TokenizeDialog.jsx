import { useState } from 'react';
import { Scissors } from 'lucide-react';
import { ServiceRunDialog } from '@ui/components/services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '@ui/components/services/ServiceMethodRow.jsx';
import { ServiceRunButton } from '@ui/components/services/ServiceRunButton.jsx';

// Tokenizing: the button in the Text Editor toolbar and the dialog behind it.
//
// The browser's own segmenter sits in the method list beside any tokenize
// service the project has, so bringing your own tokenizer changes nothing else
// about the gesture. Results are the tokens in the panel underneath, so the
// dialog carries nothing but the method and what would block a run.
export function TokenizeDialog({ tokenize, text, writeLockHeld, blockedHint = null }) {
  const [open, setOpen] = useState(false);
  const { spot, run, start } = tokenize;
  const running = run.running;
  const busyElsewhere = !!writeLockHeld && !running;

  const notice = running
    ? null
    : blockedHint
      ? blockedHint
      : busyElsewhere
        ? `${writeLockHeld.label} is running. One run at a time on a document.`
        : null;

  return (
    <>
      <ServiceRunButton
        label="Tokenize"
        icon={Scissors}
        onClick={() => setOpen(true)}
        progress={run}
      />

      <ServiceRunDialog
        open={open}
        onOpenChange={setOpen}
        title="Tokenize"
        icon={Scissors}
        description="Splits the saved text into sentences, tokens and words."
        progress={run}
        notice={notice}
        runLabel="Tokenize"
        onRun={() => {
          setOpen(false);
          start(text);
        }}
        // Only a service run can be stopped. The browser's segmenter is local
        // and finishes in one pass.
        onCancel={spot.service ? tokenize.cancel : undefined}
        runDisabled={
          !!notice || running || spot.empty || Object.keys(spot.params.errors).length > 0
        }
      >
        <ServiceMethodRow spot={spot} disabled={running} />
      </ServiceRunDialog>
    </>
  );
}
