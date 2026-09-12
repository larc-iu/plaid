import { cn } from '../../lib/utils.js';

// One look for every destination in an app's header band: the nav on the left
// of igt's, and Admin on the right of both apps'. Shared because the two bands
// are meant to read as one product, and they drifted apart when each app
// styled its own: ghost buttons in one, pills in the other, at two sizes.
//
// A class builder rather than a component, because what goes in the band is a
// `Link` in one app and a plain anchor in the other (plaid-ud's Admin is a
// full page load into plaid-igt), and both must stay real links.
export const headerItem = (active = false) =>
  cn(
    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
    active
      ? 'bg-accent text-accent-foreground'
      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
  );
