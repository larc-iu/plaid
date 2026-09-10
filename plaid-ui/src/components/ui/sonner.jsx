import { Toaster as Sonner } from 'sonner';
import { PREFLIGHT_SCOPE } from '../../lib/utils.js';

// shadcn sonner wrapper. We don't use next-themes; the app is light-only for now.
// The toaster portals to <body>, so each toast carries PREFLIGHT_SCOPE for the
// benefit of an app whose preflight is scoped rather than global.
const Toaster = (props) => (
  <Sonner
    className="toaster group"
    toastOptions={{
      classNames: {
        toast: `${PREFLIGHT_SCOPE} group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg`,
        description: 'group-[.toast]:text-muted-foreground',
        actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
        cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        error: 'group-[.toaster]:!text-destructive',
      },
    }}
    {...props}
  />
);

export { Toaster };
