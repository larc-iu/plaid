import { useCallback, useEffect, useMemo, useState } from 'react';
import { assistantsAmong, strandedAssistants } from './useAssistantAvailable.js';
import { serviceCache } from './jobs.js';

// Which assistant answers: discovery, the choice a reader may still make, and
// the one a conversation is already bound to.
//
// A conversation keeps the assistant it started with: its earlier answers were
// that model's, and swapping models halfway through a thread makes the whole
// thread hard to read. So the picker is offered while a conversation is still
// new, and again only if the assistant it started with has gone offline, where
// the alternative is not being able to go on at all.
//
// `meta` is the open conversation's sidebar entry, which is where the binding
// is recorded.
export const useAssistantChoice = ({ client, projectId, app, meta }) => {
  const [services, setServices] = useState([]);
  const [discovering, setDiscovering] = useState(true);
  const [choice, choose] = useState(null);

  const discover = useCallback(async () => {
    try {
      const found = (await client.messages.discoverServices(projectId)) || [];
      serviceCache.set(projectId, found);
      setServices(found);
    } catch (e) {
      console.error('[Assistant] discovery failed', e);
      if (!serviceCache.has(projectId)) setServices([]);
    } finally {
      setDiscovering(false);
    }
  }, [client, projectId]);

  const refresh = useCallback(() => {
    setDiscovering(true);
    discover();
  }, [discover]);

  // Show what we already know about this project while re-checking, so
  // switching tabs does not blank the assistant picker every time. The cold
  // start (a project whose service has not registered yet) is handled by
  // useAssistantAvailable, which gates the panel, the rail and the tab.
  useEffect(() => {
    const cached = serviceCache.get(projectId);
    setServices(cached || []);
    setDiscovering(!cached);
    discover();
  }, [discover, projectId]);

  // Only ONLINE assist services OF THIS APP can take a turn: a conversation's
  // record is namespaced by the app, the same value the service advertises, so
  // another app's assistant could not find one of ours.
  const assistants = useMemo(() => assistantsAmong(services, app), [services, app]);
  const stranded = useMemo(() => strandedAssistants(services), [services]);
  const pinned = meta?.serviceId
    ? (assistants.find((s) => s.serviceId === meta.serviceId) ?? null)
    : null;
  const service = pinned ?? assistants.find((s) => s.serviceId === choice) ?? assistants[0] ?? null;

  return {
    services,
    discovering,
    refresh,
    assistants,
    stranded,
    service,
    choose,
    canChoose: !pinned && assistants.length > 1,
    // The conversation's own assistant is offline, so a reply now would come
    // from a different one. Say so rather than switching quietly.
    wentOffline: !!meta?.serviceId && !pinned,
    model: service?.extras?.model,
  };
};
