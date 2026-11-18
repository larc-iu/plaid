// Reading a job's rows of work (`jobs.piecesPage`), for its page's work list
// (JobActivity) and its plan.
import { useEffect, useMemo, useRef, useState } from 'react';

// The most rows one read of the route answers (core's page cap).
export const PIECES_MAX = 1000;

// The page of the address's `?page=`, 0-based, as usePagedList reads it.
export const pageOfParam = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n - 1 : 0;
};

// The job's rows of work, read with each read of the job: `{page, rows,
// plan, limit}`, `page` the route's answer (null until the first), `rows` its
// rows with the plan's taken out, `plan` the plan once found, `limit` the
// limit `page` was read at (a running job's read is short of every row).
export const useJobPieces = (client, jobId, readAt, limit, enabled = true) => {
  const [read, setRead] = useState({ page: null, limit: null });
  const page = read.page;
  const [plan, setPlan] = useState(null);
  // The job whose plan row was found, or looked for past the first page.
  const planFor = useRef(null);
  useEffect(() => {
    setRead({ page: null, limit: null });
    setPlan(null);
    planFor.current = null;
  }, [jobId]);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const planOf = (entries) => (entries || []).find((r) => r.piece?.plan)?.piece.plan ?? null;
    client.jobs
      .piecesPage(jobId, { limit })
      .then(async (next) => {
        if (!live) return;
        setRead({ page: next, limit });
        if (planFor.current === jobId) return;
        let found = planOf(next?.entries);
        if (!found && next?.nextCursor) {
          planFor.current = jobId;
          found = planOf((await client.jobs.piecesPage(jobId, { limit: PIECES_MAX }))?.entries);
        }
        if (found && live) {
          planFor.current = jobId;
          setPlan(found);
        }
      })
      // A read that fails keeps what the list shows: the next read of the job
      // asks again.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, jobId, limit, readAt, enabled]);
  const rows = useMemo(() => (page?.entries || []).filter((r) => !r.piece.plan), [page]);
  return { page, rows, plan, limit: read.limit };
};
