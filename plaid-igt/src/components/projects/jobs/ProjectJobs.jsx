import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataTable } from '@ui/components/shared/data-table';
import { LoadError } from '@ui/components/shared/LoadError.jsx';
import { SectionHeader } from '@ui/components/shared/SectionHeader.jsx';
import { fullTimestamp, timeAgo } from '@ui/lib/formatTime.js';
import { JOB_POLL_MS, isJobActive, jobStateText } from '@ui/domain/jobs.js';
import { t } from '@ui/lib/i18n.js';
import { jobPath } from './jobText.js';

/**
 * The project's Jobs tab: every job of the project, newest first, each row a
 * link to the job's page. Read again every JOB_POLL_MS while one of them is
 * active, so a job's row moves as its worker does. `actions` are the
 * Assistant button and the "⋯" menu with Start without the assistant, for a
 * writer, who is also told how a job is set up where an assistant can be
 * asked (`assistant`, `useAssistantAvailable`'s answer), and that none is
 * online where none is.
 */
const setUpLine = (assistant) =>
  assistant === true
    ? t('A job is set up by asking the assistant.')
    : assistant === false
      ? t('No assistant is online.')
      : null;

export const ProjectJobs = ({ projectId, client, actions = null, assistant = null }) => {
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
      label: t('State'),
      // A job that stands undone says so beside its state, muted.
      render: (j) =>
        cell(
          j,
          <>
            {jobStateText(j.state) ?? j.state}
            {j.undone && ' '}
            {j.undone && (
              <span data-undone className="text-muted-foreground">
                {t('Undone')}
              </span>
            )}
          </>,
        ),
      sort: (j) => jobStateText(j.state) ?? j.state,
    },
    {
      key: 'instructions',
      label: t('Instructions'),
      render: (j) => cell(j, <span className="line-clamp-1">{j.instructions}</span>),
      sort: (j) => j.instructions || '',
    },
    {
      key: 'documents',
      label: t('Documents'),
      align: 'right',
      render: (j) => cell(j, j.documentCount.toLocaleString()),
      sort: (j) => j.documentCount,
    },
    {
      key: 'startedBy',
      label: t('Started by'),
      render: (j) => cell(j, j.startedByName),
      sort: (j) => j.startedByName,
    },
    // When the job joined the queue: a waiting job has not started (RPF-P5).
    {
      key: 'createdAt',
      label: t('Queued'),
      render: (j) => when(j, j.createdAt),
      sort: (j) => j.createdAt,
    },
    {
      key: 'finishedAt',
      label: t('Ended'),
      render: (j) => when(j, j.finishedAt),
      sort: (j) => j.finishedAt,
    },
  ];

  return (
    <div>
      <SectionHeader
        title={t('Jobs')}
        description={actions ? setUpLine(assistant) : null}
        actions={actions}
      />
      {error ? (
        <LoadError onRetry={() => setAttempt((n) => n + 1)}>
          {t('Failed to list the jobs')}
        </LoadError>
      ) : (
        <DataTable
          id="project-jobs"
          scope={projectId}
          rows={jobs || []}
          loading={jobs === null}
          rowKey={(j) => j.id}
          columns={columns}
          defaultSort={{ key: 'createdAt', dir: 'desc' }}
          countLabel={(v) => t('{total} {n, plural, one {job} other {jobs}}', v)}
          empty={t('No jobs.')}
        />
      )}
    </div>
  );
};
