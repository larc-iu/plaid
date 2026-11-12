import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../ui/tooltip.jsx';

// The button that opens a run dialog. While its run is going it turns, and
// `disabled` is the caller's: the dialog closes when the run starts, and the
// banner over the document shows the run with its clock, its progress and
// Stop, so a writing run's opener is disabled until it ends.
//
// `iconOnly` is for a dense icon row (the Recording header), where the tooltip
// carries the label; everywhere else the verb is on the button. It brings its
// own TooltipProvider so a header does not have to supply one.
export function ServiceRunButton({
  label,
  icon: Icon,
  onClick,
  running = false,
  disabled = false,
  iconOnly = false,
  variant = 'outline',
  size,
}) {
  const button = (
    <Button
      variant={variant}
      size={size ?? (iconOnly ? 'icon' : undefined)}
      // A small one sits beside History, and spaces its icon the same.
      className={iconOnly ? 'h-9 w-9' : size === 'sm' ? 'gap-1.5' : undefined}
      onClick={onClick}
      disabled={disabled}
      aria-label={iconOnly ? label : undefined}
      aria-busy={running || undefined}
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
  // when the button is an icon. The tree is the same either way, so the button
  // keeps focus when a run starts and ends under it.
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        {iconOnly && <TooltipContent>{label}</TooltipContent>}
      </Tooltip>
    </TooltipProvider>
  );
}
