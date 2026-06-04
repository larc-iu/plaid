import { Toaster as Sonner } from 'sonner';

// shadcn sonner wrapper. We don't use next-themes; the app is light-only for now.
// The toaster portals to <body>; tag it `.tw` so our scoped preflight + Tailwind
// utilities apply to the toast chrome.
const Toaster = (props) => (
  <Sonner
    className="toaster group"
    toastOptions={{
      classNames: {
        toast: 'tw group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
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
