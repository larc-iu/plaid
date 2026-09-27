import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

// The four tones a Notice comes in: the box's classes and the icon it shows
// unless the caller names another. Tint, border and icon take the tone's
// colour token (the preset's `warning` and `success` sit beside `destructive`),
// and the text is the tone's dark foreground, readable on the tint (for an
// error, `destructive-strong`, since shadcn's destructive foreground is the
// white of a solid button). Info takes the primary blue.
export const NOTICE_TONES = {
  info: {
    box: 'border-primary/30 bg-primary/5 text-foreground',
    icon: Info,
    iconClass: 'text-primary',
  },
  warning: {
    box: 'border-warning/40 bg-warning/10 text-warning-foreground',
    icon: AlertTriangle,
    iconClass: 'text-warning',
  },
  error: {
    box: 'border-destructive/40 bg-destructive/10 text-destructive-strong',
    icon: XCircle,
    iconClass: 'text-destructive',
  },
  success: {
    box: 'border-success/40 bg-success/10 text-success-foreground',
    icon: CheckCircle2,
    iconClass: 'text-success',
  },
};
