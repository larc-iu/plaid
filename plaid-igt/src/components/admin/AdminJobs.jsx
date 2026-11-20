import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataTable } from '@ui/components/shared/data-table';
import { LoadError } from '@ui/components/shared/LoadError.jsx';
import { textIncludes } from '@ui/domain/collation.js';
import { fullTimestamp, timeAgo } from '@ui/lib/formatTime.js';
import {
  JOB_POLL_MS,
  isJobActive,
  jobSilentText,
  jobStateText,
  workerSeen,
} from '@ui/domain/jobs.js';
import { jobPath, jobsTabPath } from '../projects/jobs/jobText.js';

// Every project's assistant jobs in one list, newest first, and whether a
// job worker is running. A project shows only its own jobs, so which job the
// one worker holds and what waits behind it is invisible from inside any of
// them. A row leads to the job's own page, where it is read, stopped and
// undone. Read again every JOB_POLL_MS while a job is active.

// Whether a worker is asking for work (`worker` is `jobs.worker()`'s answer),
// and the model it runs. Core remembers the last one only since it started.
const workerLine = (worker) => {
  if (!worker) return null;
  if (workerSeen(worker)) return `A job worker is running (${worker.model}).`;
  if (!worker.seenAt) return 'No job worker has asked for work since the server started.';
  return `No job worker is running. The last one asked for work ${timeAgo(worker.seenAt)}.`;
};

const tokens = (n) => (typeof n === 'number' ? `${n.toLocaleString()} tokens` : null);

// What the running worker's last claim said it runs, each only when sent.
const SETTINGS = [
  ['Version', (s) => s.version],
  ['Model key', (s) => s.modelPool],
  ['Context window', (s) => tokens(s.contextWindow)],
  ['Output limit', (s) => tokens(s.maxOutputTokens)],
  ['Piece output limit', (s) => tokens(s.pieceOutputTokens)],
  ['Reasoning effort', (s) => s.reasoningEffort],
  ['Apps', (s) => (Array.isArray(s.apps) ? s.apps.join(', ') : null)],
];

const workerSettings = (worker) =>
  worker && workerSeen(worker) && worker.settings
    ? SETTINGS.map(([label, read]) => [label, read(worker.settings)]).filter(([, v]) => v)
    : [];

export const AdminJobs = ({ client }) => {
  const [jobs, setJobs] = useState(null);
  const [worker, setWorker] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    let timer = null;
    let loaded = false;
    const read = async () => {
      try {
        const [next, w] = await Promise.all([client.admin.jobs(), client.jobs.worker()]);
        if (!live) return;
        loaded = true;
        setJobs(next);
        setWorker(w);
        setError(null);
        if (next.some(isJobActive)) timer = setTimeout(read, JOB_POLL_MS);
      } catch (err) {
        if (!live) return;
        if (loaded) timer = setTimeout(read, JOB_POLL_MS);
        else setError(err);
      }
    };
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, attempt]);

  // Each cell is the link, since an anchor cannot wrap a table row.
  const cell = (job, children) => (
    <Link to={jobPath(job.project, job.id)} className="block">
      {children}
    </Link>
  );
  const when = (job, at) =>
    cell(job, at ? <span title={fullTimestamp(at)}>{timeAgo(at)}</span> : '');

  const columns = [
    {
      key: 'state',
      label: 'State',
      // A job whose worker has gone silent says so beside its state, and one
      // that stands undone says that, both muted.
      render: (j) =>
        cell(
          j,
          <>
            {jobStateText(j.state) ?? j.state}
            {(j.lapsed || j.undone) && ' '}
            {j.lapsed && (
              <span data-silent className="text-muted-foreground">
                {jobSilentText(j)}
              </span>
            )}
            {j.undone && (
              <span data-undone className="text-muted-foreground">
                Undone
              </span>
            )}
          </>,
        ),
      sort: (j) => jobStateText(j.state) ?? j.state,
    },
    {
      key: 'project',
      label: 'Project',
      render: (j) => (
        <Link to={jobsTabPath(j.project)} dir="auto" className="hover:underline">
          {j.projectName}
        </Link>
      ),
      sort: (j) => (j.projectName || '').toLowerCase(),
    },
    {
      key: 'instructions',
      label: 'Instructions',
      render: (j) => cell(j, <span className="line-clamp-1">{j.instructions}</span>),
      sort: (j) => j.instructions || '',
    },
    {
      key: 'documents',
      label: 'Documents',
      align: 'right',
      render: (j) => cell(j, j.documentCount.toLocaleString()),
      sort: (j) => j.documentCount,
    },
    {
      key: 'startedBy',
      label: 'Started by',
      render: (j) => cell(j, j.startedByName),
      sort: (j) => j.startedByName,
    },
    {
      key: 'model',
      label: 'Model',
      render: (j) => cell(j, j.model ?? ''),
      sort: (j) => j.model || '',
    },
    {
      key: 'createdAt',
      label: 'Queued',
      render: (j) => when(j, j.createdAt),
      sort: (j) => j.createdAt,
    },
    {
      key: 'finishedAt',
      label: 'Ended',
      render: (j) => when(j, j.finishedAt),
      sort: (j) => j.finishedAt,
    },
  ];

  if (error)
    return <LoadError onRetry={() => setAttempt((n) => n + 1)}>Failed to list the jobs</LoadError>;

  const line = workerLine(worker);
  const settings = workerSettings(worker);
  return (
    <div>
      {line && (
        <div className="pb-3 text-sm text-muted-foreground">
          <p data-worker>{line}</p>
          {settings.length > 0 && (
            <p data-worker-settings className="flex flex-wrap gap-x-3 text-xs">
              {settings.map(([label, value]) => (
                <span key={label} data-fact>
                  {label} {value}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
      <DataTable
        id="admin-jobs"
        rows={jobs || []}
        loading={jobs === null}
        rowKey={(j) => j.id}
        columns={columns}
        defaultSort={{ key: 'createdAt', dir: 'desc' }}
        search={{
          placeholder: 'Search jobs…',
          match: (j, q) =>
            textIncludes(j.projectName || '', q) ||
            textIncludes(j.instructions || '', q) ||
            textIncludes(j.startedByName || '', q),
        }}
        noun="job"
        empty="No jobs."
      />
    </div>
  );
};
