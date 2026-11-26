import { Toaster as Sonner } from 'sonner';
import { t } from '../../lib/i18n.js';

// shadcn sonner wrapper. We don't use next-themes; the app is light-only for now.
const Toaster = (props) => (
  <Sonner
    className="toaster group"
    containerAriaLabel={t('Notifications')}
    toastOptions={{
      closeButtonAriaLabel: t('Close toast'),
      classNames: {
        toast:
          'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
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
