import { Suspense } from 'react';

// The boundary around a lazily loaded screen or tab: the same spinner the
// lists show while a chunk downloads.
export const Suspended = ({ children }) => (
  <Suspense
    fallback={
      <div className="tw flex justify-center py-12 text-muted-foreground">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    }
  >
    {children}
  </Suspense>
);
