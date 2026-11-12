import { useCallback, useEffect, useRef, useState } from 'react';
import { JOB_ACTIVE_POLL_MS } from '../domain/jobs.js';

const idle = () => Promise.resolve();

/**
 * The project's active assistant job, or null when it has none: read on mount
 * and every JOB_ACTIVE_POLL_MS after each answer, until unmount. Polling, not
 * an event on the project's stream: one small read, and nothing to miss.
 *
 * A read that fails counts as no job until the next one, so a banner never
 * stands on an answer that could not be had. `refresh()` reads at once (after
 * a Stop), and the next read is timed from its answer.
 */
export const useActiveJob = (client, projectId) => {
  const [job, setJob] = useState(null);
  const readRef = useRef(idle);

  useEffect(() => {
    if (!client || !projectId) return undefined;
    let alive = true;
    let timer = null;
    // Only the newest read's answer lands, and only it times the next one.
    let latest = 0;
    const read = async () => {
      clearTimeout(timer);
      const mine = ++latest;
      let answer = null;
      try {
        answer = await client.jobs.active(projectId);
      } catch {
        answer = null;
      }
      if (!alive || mine !== latest) return;
      setJob(answer ?? null);
      timer = setTimeout(read, JOB_ACTIVE_POLL_MS);
    };
    readRef.current = read;
    read();
    return () => {
      alive = false;
      clearTimeout(timer);
      readRef.current = idle;
    };
  }, [client, projectId]);

  const refresh = useCallback(() => readRef.current(), []);
  return { job, refresh };
};
