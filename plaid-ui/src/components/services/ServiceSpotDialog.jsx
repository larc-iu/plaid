import { useState } from 'react';
import { ServiceRunDialog } from './ServiceRunDialog.jsx';
import { ServiceMethodRow } from './ServiceMethodRow.jsx';
import { ServiceRunButton } from './ServiceRunButton.jsx';
import { runHeldNotice } from './runHeld.js';

// A run of one service spot: the button and the dialog behind it, with one
// method row. The run belongs to the caller, so closing the dialog never
// cancels it and the button carries the clock until it ends.
//
// What blocks a run is said in the dialog, beside the Run it disables:
// `blockedHint` (the app's own reason), else another run holding the document
// (`writeLock`). No service online is the method row's to say, once: with a
// `noun`, as "No parsing service is online for this project.", or "Looking
// for a parsing service." while `isDiscovering`. `blocked` disables Run with
// nothing said. `running` defaults to the run's own. `onOpen` runs each time
// the dialog opens. `closeFirst` closes the dialog before `onRun`, else after
// it settles.
export function ServiceSpotDialog({
  label,
  icon,
  description,
  run,
  spot,
  onRun,
  onCancel,
  writeLock = null,
  blockedHint = null,
  noun = null,
  isDiscovering = false,
  onOpen = null,
  disabled = false,
  blocked = false,
  running = run.running,
  closeFirst = true,
}) {
  const [open, setOpen] = useState(false);
  const notice = running ? null : (blockedHint ?? runHeldNotice(writeLock, running));
  const emptyHint = !noun
    ? undefined
    : isDiscovering
      ? `Looking for a ${noun} service.`
      : `No ${noun} service is online for this project.`;

  return (
    <>
      <ServiceRunButton
        label={label}
        icon={icon}
        onClick={() => {
          setOpen(true);
          onOpen?.();
        }}
        progress={run}
        disabled={disabled}
      />

      <ServiceRunDialog
        open={open}
        onOpenChange={setOpen}
        title={label}
        icon={icon}
        description={description}
        progress={run}
        notice={notice}
        runLabel={label}
        onRun={async () => {
          if (closeFirst) setOpen(false);
          await onRun();
          if (!closeFirst) setOpen(false);
        }}
        onCancel={onCancel}
        runDisabled={
          running ||
          blocked ||
          !!notice ||
          !!spot.empty ||
          Object.keys(spot.params.errors).length > 0
        }
      >
        <ServiceMethodRow spot={spot} disabled={running} emptyHint={emptyHint} />
      </ServiceRunDialog>
    </>
  );
}
