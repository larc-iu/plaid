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

// Assistants that are online and say nothing about which app they serve: a
// process started before `extras.app` existed. Filtering them out silently left
// every surface either claiming no assistant was online, which was false, or
// rendering nothing at all, and the remedy an operator would reach for (start
// another) collides on the service id and 409s. They are listed, and disabled.
export const strandedAssistants = (services) =>
  filterServicesByTask(services || [], TASKS.ASSIST).filter(
    (s) => s.online !== false && !s.extras?.app,
  );

export const useAssistantAvailable = (client, projectId, app) => {
  const cached = serviceCache.get(projectId);
  const [available, setAvailable] = useState(
    cached ? assistantsAmong(cached, app).length > 0 : null,
  );

  useEffect(() => {
    if (!client || !projectId) return undefined;
    let alive = true;
    let timer = null;
    const known = serviceCache.get(projectId);
    if (known) setAvailable(assistantsAmong(known, app).length > 0);

    // Ask again, a few times, while the answer is "none". This hook is what
    // gates the header button, the edge rail and the Assistant tab, so a single
    // probe decided the whole assistant was absent. On a project created a
    // moment ago it always is: the probe is answered inside half a second, and
    // the service registers afterwards. Nothing on screen then said an
    // assistant existed, and the only way to find out was to navigate off the
    // project and back, which happens to remount this hook.
    //
    // The window is the service's, not a guess: a `--all` service registers on
    // new projects once per PROJECT_SYNC_INTERVAL_S, 30s
    // (plaid-client-py/src/plaid_client/service.py:250). These steps total 49s,
    // so a whole sync fits inside them. Then it stops. This is a cold start,
    // not a heartbeat.
    const backoff = [2000, 4000, 8000, 15000, 20000];
    let attempt = 0;
    const again = () => {
      if (alive && attempt < backoff.length) timer = setTimeout(probe, backoff[attempt++]);
    };
    const probe = () =>
      client.messages
        .discoverServices(projectId)
        .then((found) => {
          if (!alive) return;
          serviceCache.set(projectId, found || []);
          const ok = assistantsAmong(found, app).length > 0;
          setAvailable(ok);
          if (!ok) again();
        })
        .catch(() => {
          // Discovery failed rather than came back empty. Keep whatever the
          // cache said; a network blip should not hide a working assistant.
          if (!alive) return;
          if (!serviceCache.has(projectId)) setAvailable(false);
          again();
        });
    probe();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, projectId, app]);

  return available;
};
