import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { notifyError } from '@/utils/feedback';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { DataTable } from '@ui/components/shared/data-table';
import { LoadError } from '@ui/components/shared/LoadError.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { SectionHeader } from '@ui/components/shared/SectionHeader.jsx';
import { TYPE } from '@ui/lib/typeScale.js';
import { countOf } from '@ui/lib/plural.js';
import { fullTimestamp, timeAgo } from '@ui/lib/formatTime.js';
import { projectNotFound } from '@ui/lib/errors.js';
import { canStopJob } from '@ui/domain/permissions.js';
import {
  JOB_POLL_MS,
  isJobActive,
  jobDocumentStateText,
  jobPhaseText,
  jobReasonText,
  jobStateText,
} from '@ui/domain/jobs.js';
import { JobReport } from './JobReport.jsx';
import { durationText, jobsTabPath, tasksText } from './jobText.js';

/**
 * A job's own page, `/projects/:projectId/jobs/:jobId`: its state, each of its
 * documents, Stop for whoever may, and once it has ended its report. Read
 * again every JOB_POLL_MS while the job is active, and once otherwise.
 */
export const JobPage = ({ project, projectId, jobId, client }) => {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [job, setJob] = useState(null);
  // When the job shown was read, which is as far as its elapsed time runs.
  const [readAt, setReadAt] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let live = true;
    let timer = null;
    let loaded = false;
    const read = async () => {
      try {
        const next = await client.jobs.get(jobId);
        if (!live) return;
        loaded = true;
        setJob(next);
        setReadAt(Date.now());
        setError(null);
        if (isJobActive(next)) timer = setTimeout(read, JOB_POLL_MS);
      } catch (err) {
        if (!live) return;
        // A read that fails after the page has a job keeps what it shows and
        // asks again. A first read that fails says so.
        if (loaded) timer = setTimeout(read, JOB_POLL_MS);
        else setError(err);
      }
    };
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, jobId, attempt]);

  const stop = useCallback(async () => {
    const ok = await confirm({
      title: 'Stop the job?',
      description: 'What it wrote stays.',
      confirmLabel: 'Stop',
    });
    if (!ok) return;
    setStopping(true);
    try {
      setJob(await client.jobs.cancel(jobId));
      setReadAt(Date.now());
    } catch (err) {
      notifyError(err, 'Failed to stop the job');
    } finally {
      setStopping(false);
    }
  }, [client, confirm, jobId]);

  const back = (
    <Link
      to={jobsTabPath(projectId)}
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> All jobs
    </Link>
  );

  if (error) {
    return (
      <div>
        {back}
        {projectNotFound(error) ? (
          <LoadError>Job not found.</LoadError>
        ) : (
          <LoadError onRetry={() => setAttempt((n) => n + 1)}>Failed to load the job</LoadError>
        )}
      </div>
    );
  }
  if (!job) return <Loading />;

  const stoppable =
    (job.state === 'waiting' || job.state === 'running') && canStopJob(job, project, user);

  return (
    <div>
      {back}
      <SectionHeader
        title="Job"
        actions={
          stoppable && (
            <Button variant="outline" onClick={stop} disabled={stopping}>
              Stop
            </Button>
          )
        }
      />
      <JobStatus job={job} />
      <JobFacts job={job} readAt={readAt} />
      <h3 className={`${TYPE.card} mb-2 mt-8`}>Documents</h3>
      <JobDocuments job={job} projectId={projectId} />
      {job.report && (
        <JobReport report={job.report} projectId={projectId} vocabs={project.vocabs || []} />
      )}
    </div>
  );
};

// The state, what the worker is doing, its last line, and for a waiting job
// how many are ahead of it. A failed job says why.
const JobStatus = ({ job }) => {
  const failed = job.state === 'failed';
  const running = job.state === 'running';
  return (
    <div className="mb-6 flex flex-col gap-1 text-sm" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={failed ? 'destructive' : 'secondary'}>{jobStateText(job.state)}</Badge>
        {running && job.phase && <span>{jobPhaseText(job.phase)}</span>}
        {job.state === 'waiting' && job.ahead > 0 && (
          <span className="text-muted-foreground">{countOf(job.ahead, 'job')} ahead</span>
        )}
      </div>
      {failed ? (
        <p>{jobReasonText(job)}</p>
      ) : (
        isJobActive(job) && job.message && <p className="text-muted-foreground">{job.message}</p>
      )}
    </div>
  );
};

const Fact = ({ label, children }) => (
  <div className="contents">
    <dt className="text-muted-foreground">{label}</dt>
    <dd>{children}</dd>
  </div>
);

const When = ({ at }) => <span title={fullTimestamp(at)}>{timeAgo(at)}</span>;

const JobFacts = ({ job, readAt }) => {
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : readAt;
  return (
    <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
      <Fact label="Tasks">{tasksText(job.tasks)}</Fact>
      <Fact label="Documents">{(job.documents || []).length.toLocaleString()}</Fact>
      <Fact label="Started by">{job.startedByName}</Fact>
      <Fact label="Started">
        <When at={job.createdAt} />
      </Fact>
      {job.finishedAt && (
        <Fact label="Ended">
          <When at={job.finishedAt} />
        </Fact>
      )}
      {job.startedAt && (
        <Fact label="Elapsed">{durationText(end - new Date(job.startedAt).getTime())}</Fact>
      )}
      {job.model && <Fact label="Model">{job.model}</Fact>}
      {job.note && (
        <Fact label="Instructions">
          <span className="whitespace-pre-wrap">{job.note}</span>
        </Fact>
      )}
    </dl>
  );
};

const count = (row, key) => (row.counts?.[key] ?? 0).toLocaleString();

// A row per document of the job, in the job's order.
const JobDocuments = ({ job, projectId }) => {
  const tasks = job.tasks || [];
  const columns = [
    {
      key: 'name',
      label: 'Document',
      render: (d) =>
        d.name === null || d.name === undefined ? (
          <span className="text-muted-foreground">Deleted document</span>
        ) : (
          <Link className="hover:underline" to={`/projects/${projectId}/documents/${d.documentId}`}>
            {d.name}
          </Link>
        ),
    },
    {
      key: 'state',
      label: 'State',
      render: (d) => jobDocumentStateText(d.state) ?? d.state,
    },
    {
      key: 'done',
      label: 'Sentences',
      align: 'right',
      render: (d) =>
        d.targets === null || d.targets === undefined ? '' : `${d.done ?? 0} of ${d.targets}`,
    },
  ];
  if (tasks.includes('translate')) {
    columns.push({
      key: 'translations',
      label: 'Translations',
      align: 'right',
      render: (d) => ((d.counts?.translations ?? 0) + (d.counts?.refreshed ?? 0)).toLocaleString(),
    });
  }
  if (tasks.includes('gloss')) {
    columns.push({
      key: 'words',
      label: 'Words',
      align: 'right',
      render: (d) => count(d, 'words'),
    });
  }
  if (tasks.includes('link')) {
    columns.push({
      key: 'links',
      label: 'Links',
      align: 'right',
      render: (d) => count(d, 'links'),
    });
    columns.push({
      key: 'entries',
      label: 'Entries',
      align: 'right',
      render: (d) => count(d, 'entries'),
    });
  }
  return (
    <DataTable
      id="job-documents"
      rows={job.documents || []}
      rowKey={(d) => d.documentId}
      columns={columns}
      noun="document"
      showCount={false}
    />
  );
};
