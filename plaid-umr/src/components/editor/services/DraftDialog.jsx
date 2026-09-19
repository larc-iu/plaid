import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { ServiceRunDialog } from '@ui/components/services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '@ui/components/services/ServiceMethodRow.jsx';
import { ServiceRunButton } from '@ui/components/services/ServiceRunButton.jsx';

// Drafting: the button on the annotation toolbar and the dialog behind it.
//
// The run belongs to the shell, so closing the dialog never cancels it and the
// button carries the clock until it ends.
export function DraftDialog({ draft, isDiscovering, writeLockHeld, disabled = false }) {
  const [open, setOpen] = useState(false);
  const { spot, run, start } = draft;
  const running = run.running;
  // Another run holds the document. Say so rather than letting the button do
  // nothing, which is all acquireWriteLock could manage.
  const busyElsewhere = !!writeLockHeld && !running;

  const notice = running
    ? null
    : busyElsewhere
      ? `${writeLockHeld.label} is running. One run at a time on a document.`
      : spot.empty
        ? isDiscovering
          ? 'Looking for a drafting service.'
          : 'No drafting service is online for this project.'
        : null;

  return (
    <>
      <ServiceRunButton
        label="Draft"
        icon={Sparkles}
        onClick={() => setOpen(true)}
        progress={run}
        disabled={disabled}
      />

      <ServiceRunDialog
        open={open}
        onOpenChange={setOpen}
        title="Draft"
        icon={Sparkles}
        description="A first graph for each sentence, written into this document for correction on the canvas."
        progress={run}
        notice={notice}
        runLabel="Draft"
        onRun={() => {
          setOpen(false);
          start();
        }}
        onCancel={draft.cancel}
        runDisabled={
          !!notice || running || spot.empty || Object.keys(spot.params.errors).length > 0
        }
      >
        <ServiceMethodRow
          spot={spot}
          disabled={running}
          emptyHint={
            isDiscovering
              ? 'Looking for a drafting service.'
              : 'No drafting service is online for this project.'
          }
        />
      </ServiceRunDialog>
    </>
  );
}
