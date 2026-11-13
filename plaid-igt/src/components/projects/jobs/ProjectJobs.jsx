import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataTable } from '@ui/components/shared/data-table';
import { LoadError } from '@ui/components/shared/LoadError.jsx';
import { SectionHeader } from '@ui/components/shared/SectionHeader.jsx';
import { fullTimestamp, timeAgo } from '@ui/lib/formatTime.js';
import { JOB_POLL_MS, isJobActive, jobStateText } from '@ui/domain/jobs.js';
import { jobPath } from './jobText.js';

/**
 * The project's Jobs tab: every job of the project, newest first, each row a
 * link to the job's page. Read again every JOB_POLL_MS while one of them is
 * active, so a job's row moves as its worker does. `startJob` is the Start job
 * control, for a writer.
 */
export const ProjectJobs = ({ projectId, client, startJob = null }) => {
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    let timer = null;
    let loaded = false;
    const read = async () => {
      try {
        const next = await client.jobs.list(projectId);
        if (!live) return;
        loaded = true;
        setJobs(next);
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
  }, [client, projectId, attempt]);

  // Each cell is the link, since an anchor cannot wrap a table row.
  const cell = (job, children) => (
    <Link to={jobPath(projectId, job.id)} className="block">
      {children}
    </Link>
  );
  const when = (job, at) =>
    cell(job, at ? <span title={fullTimestamp(at)}>{timeAgo(at)}</span> : '');

  const columns = [
    {
      key: 'state',
      label: 'State',
      render: (j) => cell(j, jobStateText(j.state) ?? j.state),
      sort: (j) => jobStateText(j.state) ?? j.state,
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
      key: 'createdAt',
      label: 'Started',
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

  return (
    <div>
      <SectionHeader title="Jobs" actions={startJob} />
      {error ? (
        <LoadError onRetry={() => setAttempt((n) => n + 1)}>Failed to list the jobs</LoadError>
      ) : (
        <DataTable
          id="project-jobs"
          scope={projectId}
          rows={jobs || []}
          loading={jobs === null}
          rowKey={(j) => j.id}
          columns={columns}
          defaultSort={{ key: 'createdAt', dir: 'desc' }}
          noun="job"
          empty="No jobs."
        />
      )}
    </div>
  );
};
