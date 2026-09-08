// The limits this server enforces, so a screen can say what will happen before
// it happens. The client fetches them once and caches, so calling this from
// several places costs one request.
//
// A server too old to have /api/v1/info leaves them null, and every caller has
// to behave sensibly without them: the server is the one that accepts or
// refuses, and this only decides what we can say in advance.

import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export function useServerLimits() {
  const { client } = useAuth();
  const [limits, setLimits] = useState(null);
  useEffect(() => {
    if (!client) return undefined;
    let alive = true;
    client.server
      .limits()
      .then((value) => {
        if (alive) setLimits(value ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client]);
  return limits;
}
