import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../ui/tooltip.jsx';
import { formatElapsed } from '../../hooks/useRunProgress.js';

// The button that opens a run dialog, and the run's progress indicator once it
// is closed. A run outlives its dialog, so this is where a linguist who shut
// the box still sees the work moving.
//
// `iconOnly` is for a dense icon row (the Recording header), where the tooltip
// carries the label; everywhere else the verb is on the button. It brings its
// own TooltipProvider so a header does not have to supply one.
export function ServiceRunButton({
  label,
  icon: Icon,
  onClick,
  progress,
  disabled = false,
  iconOnly = false,
  variant = 'outline',
  size,
}) {
  const running = progress?.running;
  const percent = progress?.percent;

  const button = (
    <Button
      variant={variant}
      size={size ?? (iconOnly ? 'icon' : undefined)}
      className={iconOnly ? 'h-9 w-9' : undefined}
      onClick={onClick}
      disabled={disabled}
      aria-label={iconOnly ? label : undefined}
    >
      {running ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        Icon && <Icon className="h-4 w-4" />
      )}
      {!iconOnly && label}
    </Button>
  );

  // A tooltip that only repeats a visible label is noise. It earns its place
  // when the button is an icon, or when a run is on and it can say how far.
  if (!iconOnly && !running) return button;

  const status = running
    ? `${label}, ${formatElapsed(progress.elapsedMs)}${
        Number.isFinite(percent) ? `, ${Math.round(percent)}%` : ''
      }`
    : label;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{status}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
