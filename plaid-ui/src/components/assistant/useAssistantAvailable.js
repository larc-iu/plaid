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
//
// `app` is this app's own tag, and it is not optional. UD and IGT share
// projects, so both apps' assistants register on the same one, and a
// conversation's record is namespaced by the app it was started in: an app
// that offered the OTHER app's assistant sent every turn to a service that
// then could not find the conversation. The service advertises its app in
// `extras.app`, which is the same value that keys the records.
export const assistantsAmong = (services, app) =>
  filterServicesByTask(services || [], TASKS.ASSIST).filter(
    (s) => s.online !== false && s.extras?.app === app,
  );

export const useAssistantAvailable = (client, projectId, app) => {
  const cached = serviceCache.get(projectId);
  const [available, setAvailable] = useState(
    cached ? assistantsAmong(cached, app).length > 0 : null,
  );

  useEffect(() => {
    if (!client || !projectId) return undefined;
    let alive = true;
    const known = serviceCache.get(projectId);
    if (known) setAvailable(assistantsAmong(known, app).length > 0);
    client.messages
      .discoverServices(projectId)
      .then((found) => {
        if (!alive) return;
        serviceCache.set(projectId, found || []);
        setAvailable(assistantsAmong(found, app).length > 0);
      })
      .catch(() => {
        // Discovery failed rather than came back empty. Keep whatever the
        // cache said; a network blip should not hide a working assistant.
        if (alive && !serviceCache.has(projectId)) setAvailable(false);
      });
    return () => {
      alive = false;
    };
  }, [client, projectId, app]);

  return available;
};
