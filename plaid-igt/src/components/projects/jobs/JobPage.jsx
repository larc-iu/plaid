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
import { canEditProject, canManageProject, canStopJob } from '@ui/domain/permissions.js';
import { historyHref } from '@ui/hooks/useHistoryParam.js';
import { UndoDialog } from '../../documents/history/UndoDialog.jsx';
import { jobPlacer } from '@/domain/undoPlaces.js';
import { jobUndoError } from '@/domain/undoSummary.js';
import { dropPrecedent } from '@/domain/precedentCache';
import { isReviewed } from '@larc-iu/plaid-client';
import { AssistantMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { useAssistantSubject, useStartConversation } from '@ui/components/assistant/subject.js';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { useWideEnoughToDock } from '@ui/components/assistant/useDock.js';
import { IGT_ASSISTANT } from '../assistant/adapter.js';
import {
  JOB_POLL_MS,
  isJobActive,
  jobDocumentStateText,
  jobPhaseText,
  jobReasonText,
  jobSilentText,
  jobStateText,
  jobStoppable,
} from '@ui/domain/jobs.js';
import { JobReport } from './JobReport.jsx';
import { JobHistoryLinks } from './JobHistoryLinks.jsx';
import { durationText, jobName, jobsTabPath, planText } from './jobText.js';

/**
 * A job's own page, `/projects/:projectId/jobs/:jobId`: its state, each of its
 * documents, Stop for whoever may, and once it has ended its report. Read
 * again every JOB_POLL_MS while the job is active, and once otherwise.
 *
 * It is a place the assistant reads, as a document is: the panel's turns are
 * asked from the job, and the service gives the model the job's summary. An
 * ended job with a report offers a new conversation about it.
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
  const [undoOpen, setUndoOpen] = useState(false);
  // The job undone from this page: when, and its History entry in the first
  // of its documents the undo wrote in. Only until the page is left: nothing
  // core keeps says which job an undo was of ("Undo job: <label>" names the
  // job by its label, which another job may share).
  const [undone, setUndone] = useState(null);

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

  // The assistant panel is about this job while its page is open, and a new
  // conversation about it opens from here once it has ended.
  useAssistantSubject({
    projectId,
    projectName: project?.name,
    kind: 'job',
    id: jobId,
    name: job ? jobName(job) : null,
    canWrite: canEditProject(project, user),
    contributor: !!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin }),
  });

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

  const stoppable = jobStoppable(job) && canStopJob(job, project, user);
  const discussable = !isJobActive(job) && !!job.report;
  // A maintainer undoes an ended job whole, documents and lexicon together.
  const undoable = !isJobActive(job) && canManageProject(project, user) && !undone;

  // After an undo: say so, with a link to the undo in the History of the
  // first of the job's documents it wrote in.
  const afterUndo = async (res) => {
    dropPrecedent();
    if (!res?.operation) return;
    const at = new Date().toISOString();
    setUndone({ at, href: null });
    for (const d of job.documents || []) {
      try {
        const page = await client.documents.auditPage(d.documentId, {
          entryId: res.operation,
          opsLimit: 1,
        });
        const entry = page?.entries?.[0];
        if (!entry) continue;
        const href = historyHref(
          `/projects/${projectId}/documents/${d.documentId}`,
          entry.partOf ?? entry.id,
        );
        setUndone({ at, href });
        return;
      } catch {
        // Not in this document's History: the next one.
      }
    }
  };

  return (
    <div>
      {back}
      <SectionHeader
        title="Job"
        actions={
          (stoppable || discussable || undoable) && (
            <div className="flex gap-2">
              {discussable && <Discuss client={client} projectId={projectId} />}
              {undoable && (
                <Button variant="outline" onClick={() => setUndoOpen(true)}>
                  Undo job
                </Button>
              )}
              {stoppable && (
                <Button variant="outline" onClick={stop} disabled={stopping}>
                  Stop
                </Button>
              )}
            </div>
          )
        }
      />
      <JobStatus job={job} />
      {undone && (
        <p className="-mt-4 mb-6 text-sm" data-testid="job-undone">
          Job undone {fullTimestamp(undone.at)}.
          {undone.href && (
            <>
              {' '}
              <Link to={undone.href} className="text-primary hover:underline">
                Show in History
              </Link>
            </>
          )}
        </p>
      )}
      {undoable && (
        <UndoDialog
          open={undoOpen}
          onOpenChange={setUndoOpen}
          client={client}
          entry={{ id: jobId, label: jobName(job) }}
          noun="job"
          send={({ dryRun }) => client.jobs.undo(jobId, { dryRun })}
          errorText={jobUndoError}
          place={jobPlacer({
            projectId,
            documents: job.documents || [],
            vocabs: project?.vocabs || [],
          })}
          onUndone={afterUndo}
        />
      )}
      <JobFacts job={job} readAt={readAt} />
      <h3 className={`${TYPE.card} mb-2 mt-8`}>Documents</h3>
      <JobDocuments job={job} projectId={projectId} />
      {job.report && (
        <JobReport report={job.report} projectId={projectId} vocabs={project.vocabs || []} />
      )}
    </div>
  );
};

// A new conversation about the job, in the assistant panel, where an assistant
// is online and the window has room for the panel (it opens beside the page).
const Discuss = ({ client, projectId }) => {
  const available = useAssistantAvailable(client, projectId, IGT_ASSISTANT.app);
  const wide = useWideEnoughToDock();
  const discuss = useStartConversation();
  if (available !== true || !wide) return null;
  return (
    <Button variant="outline" className="gap-1.5" onClick={discuss}>
      <AssistantMark className="h-4 w-4" />
      Discuss with the assistant
    </Button>
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
      {jobSilentText(job) && <p>{jobSilentText(job)}</p>}
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

// What the assistant told every piece when it planned the job, folded when
// long.
const PLANNED_SHOWN_CHARS = 200;
const PlannedInstructions = ({ text }) => {
  const body = (
    <span className="whitespace-pre-wrap" dir="auto">
      {text}
    </span>
  );
  if (text.length <= PLANNED_SHOWN_CHARS) return body;
  return (
    <details>
      <summary className="cursor-pointer text-muted-foreground">Show</summary>
      {body}
    </details>
  );
};

const JobFacts = ({ job, readAt }) => {
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : readAt;
  return (
    <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
      <Fact label="Instructions">
        <span className="whitespace-pre-wrap">{job.instructions}</span>
      </Fact>
      {job.report?.plan && <Fact label="Plan">{planText(job.report.plan)}</Fact>}
      {job.report?.plan?.pieceInstructions && (
        <Fact label="Assistant’s instructions">
          <PlannedInstructions text={job.report.plan.pieceInstructions} />
        </Fact>
      )}
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
    </dl>
  );
};

const count = (row, key) => (row.counts?.[key] ?? 0).toLocaleString();

// A row per document of the job, in the job's order.
const JobDocuments = ({ job, projectId }) => {
  const leftOut = new Set((job.report?.plan?.leftOut || []).map((d) => d.documentId));
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
      render: (d) =>
        leftOut.has(d.documentId)
          ? 'Left out by the plan'
          : (jobDocumentStateText(d.state) ?? d.state),
    },
    {
      key: 'done',
      label: 'Sentences',
      align: 'right',
      render: (d) =>
        d.targets === null || d.targets === undefined ? '' : `${d.done ?? 0} of ${d.targets}`,
    },
  ];
  // A job has no task types: a column shows only once a document holds a
  // count of its kind.
  const rows = job.documents || [];
  const some = (...keys) => rows.some((d) => keys.some((k) => (d.counts?.[k] ?? 0) > 0));
  if (some('translations', 'refreshed')) {
    columns.push({
      key: 'translations',
      label: 'Translations',
      align: 'right',
      render: (d) => ((d.counts?.translations ?? 0) + (d.counts?.refreshed ?? 0)).toLocaleString(),
    });
  }
  // Each pass's History entry in the document: what the job changed there.
  if (rows.some((d) => d.glossGroup || d.harmonizeGroup)) {
    columns.push({
      key: 'history',
      label: 'History',
      render: (d) => <JobHistoryLinks projectId={projectId} document={d} />,
    });
  }
  for (const [key, label] of [
    ['words', 'Words'],
    ['links', 'Links'],
    ['entries', 'Entries'],
    ['changes', 'Changes'],
    ['deletions', 'Deletions'],
    ['proposed', 'Proposed'],
  ]) {
    if (some(key)) columns.push({ key, label, align: 'right', render: (d) => count(d, key) });
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
