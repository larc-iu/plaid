import { useEffect, useState } from 'react';
import { TASKS, filterServicesByTask } from '@larc-iu/plaid-client';
import { serviceCache } from './jobs.js';

// Whether any assistant is online for a project, for the screens that offer to
// open one.
//
// A control that opens an empty panel is worse than no control, so the button
// beside a document waits on this. It shares `serviceCache` with the panel
// itself, so opening one costs no second round trip, and it answers from the
// cache first: a page that already knows the answer must not flicker the
// control away and back on every navigation.
//
// `null` means "not known yet", which callers should treat as "do not offer
// it": showing the control and then withdrawing it is the flicker this avoids.
export const assistantsAmong = (services) =>
  filterServicesByTask(services || [], TASKS.ASSIST).filter((s) => s.online !== false);

export const useAssistantAvailable = (client, projectId) => {
  const cached = serviceCache.get(projectId);
  const [available, setAvailable] = useState(cached ? assistantsAmong(cached).length > 0 : null);

  useEffect(() => {
    if (!client || !projectId) return undefined;
    let alive = true;
    const known = serviceCache.get(projectId);
    if (known) setAvailable(assistantsAmong(known).length > 0);
    client.messages
      .discoverServices(projectId)
      .then((found) => {
        if (!alive) return;
        serviceCache.set(projectId, found || []);
        setAvailable(assistantsAmong(found).length > 0);
      })
      .catch(() => {
        // Discovery failed rather than came back empty. Keep whatever the
        // cache said; a network blip should not hide a working assistant.
        if (alive && !serviceCache.has(projectId)) setAvailable(false);
      });
    return () => {
      alive = false;
    };
  }, [client, projectId]);

  return available;
};
