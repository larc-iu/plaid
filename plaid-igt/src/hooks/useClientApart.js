import { useMemo } from 'react';
import { authService } from '@ui/services/auth.js';

// A client of the screen's own, on the session's token, for a long run (an
// import, a Bulk Edit run), as a document editor has its own. What a run sets
// on its client (the document version strict mode stamps on every write, the
// operation its writes are filed under) is then never read by another write
// the tab makes while it runs (H17-IGT-DATA-1). Its retries show in the
// session's retrying pill.
export const useClientApart = (client) =>
  useMemo(() => (client ? authService.clientApart(client) : client), [client]);
