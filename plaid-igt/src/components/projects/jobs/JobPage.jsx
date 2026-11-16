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
import { JobFindings, JobReport } from './JobReport.jsx';
import { JobHistoryLinks } from './JobHistoryLinks.jsx';
import { JobActivity } from './JobActivity.jsx';
import { FillsNames } from './jobLines.jsx';
import {
  aheadText,
  durationText,
  jobEditedText,
  jobName,
  jobsTabPath,
  changesGroup,
  leftText,
  planText,
  readableSetup,
  whoText,
  stoppedPartway,
  wroteNothing,
  allSkipped,
  documentSentencesText,
} from './jobText.js';

/**
 * A job's own page, `/projects/:projectId/jobs/:jobId`: its state, each of its
 * documents, what each piece of its work did as it finishes (Work so far, kept
 * above the report once the job has ended), Stop for whoever may, and once it
 * has ended its report. Read
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
  // Where the job's undo is in History, while the job stands undone (core's
  // `undone`): its entry in the first of the job's documents whose History
  // has it, or null until found or where none does.
  const [undoneHref, setUndoneHref] = useState(null);
  // The plan as its row in the work list gives it, while the report has none
  // (JobActivity): the job's plan from the moment planning ends (RP-9).
  const [livePlan, setLivePlan] = useState(null);
  useEffect(() => setLivePlan(null), [jobId]);
  const undoneOp = job?.undone?.operation ?? null;
  const documentIds = (job?.documents || []).map((d) => d.documentId).join(',');
  useEffect(() => {
    setUndoneHref(null);
    if (!undoneOp) return undefined;
    let live = true;
    (async () => {
      for (const documentId of documentIds ? documentIds.split(',') : []) {
        try {
          const page = await client.documents.auditPage(documentId, {
            entryId: undoneOp,
            opsLimit: 1,
          });
          const entry = page?.entries?.[0];
          if (!entry) continue;
          if (live) {
            setUndoneHref(
              historyHref(
                `/projects/${projectId}/documents/${documentId}`,
                entry.partOf ?? entry.id,
              ),
            );
          }
          return;
        } catch {
          // Not in this document's History: the next one.
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [client, projectId, undoneOp, documentIds]);

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
  // Not while it stands undone: a redo, from History, offers it again. Not
  // for a job that wrote nothing (RP-4).
  const undoable =
    !isJobActive(job) && canManageProject(project, user) && !job.undone && !wroteNothing(job);
  const findings = typeof job.report?.findings === 'string' ? job.report.findings : '';

  // After an undo: the job read again, which says it stands undone.
  const afterUndo = async (res) => {
    dropPrecedent();
    if (!res?.operation) return;
    try {
      setJob(await client.jobs.get(jobId));
      setReadAt(Date.now());
    } catch (err) {
      notifyError(err, 'Failed to read the job again');
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
      <JobStatus job={job} user={user} />
      <JobSetup job={job} projectId={projectId} user={user} />
      {job.undone && (
        <p className="-mt-4 mb-6 text-sm" data-testid="job-undone">
          Job undone {fullTimestamp(job.undone.time)}.
          {undoneHref && (
            <>
              {' '}
              <Link to={undoneHref} className="text-primary hover:underline">
                Show in History
              </Link>
            </>
          )}
        </p>
      )}
      {/* The one report of a job that fills nothing, first (RP-4). */}
      {findings && (
        <JobFindings
          findings={findings}
          pieces={job.report.findingsPieces}
          cut={job.report.findingsCut}
        />
      )}
      {undoable && (
        <UndoDialog
          open={undoOpen}
          onOpenChange={setUndoOpen}
          client={client}
          entry={{ id: jobId, label: jobName(job) }}
          noun="job"
          send={({ dryRun }) => client.jobs.undo(jobId, { dryRun })}
          tokens={job.report ? (jobEditedText(job) ? 'with-text' : 'morphemes') : undefined}
          errorText={jobUndoError}
          place={jobPlacer({
            projectId,
            documents: job.documents || [],
            vocabs: project?.vocabs || [],
          })}
          onUndone={afterUndo}
        />
      )}
      <JobFacts job={job} readAt={readAt} plan={job.report?.plan ?? livePlan} />
      <h3 className={`${TYPE.card} mb-2 mt-8`}>Documents</h3>
      <JobDocuments job={job} projectId={projectId} />
      <JobActivity
        client={client}
        job={job}
        projectId={projectId}
        readAt={readAt}
        onPlan={setLivePlan}
      />
      {job.report && (
        <JobReport
          report={job.report}
          projectId={projectId}
          vocabs={project.vocabs || []}
          undone={job.undone ?? null}
          undoneBy={job.undone ? whoText(job.undone.user, job, user) : null}
        />
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
    <Button variant="outline" className="gap-1.5" onClick={() => discuss()}>
      <AssistantMark className="h-4 w-4" />
      Discuss with the assistant
    </Button>
  );
};

// What a job set up in a conversation was set up to do, from its start on
// (its `setup`, which the job card gave it): what it fills and whether it may
// edit the text. The conversation is its starter's own, so only they get the
// link. A job started from the form has no setup, and no line, and neither
// has one whose setup is not the card's shape (`readableSetup`).
const JobSetup = ({ job, projectId, user }) => {
  const setup = job.setup;
  if (!readableSetup(setup)) return null;
  const conversation =
    setup.conversation && user?.id && user.id === job.startedBy ? setup.conversation : null;
  // The fields its plan found gone, by id (REV-SU-B-3).
  const planGone = job.report?.plan?.gone;
  const gone = Array.isArray(planGone) ? planGone.map((g) => g?.id) : [];
  return (
    <p className="-mt-4 mb-6 text-sm" data-testid="job-setup">
      Set up to fill <FillsNames fills={setup.fills} none="nothing" gone={gone} />
      {setup.onlynew === true && ', only on the words it adds'}.{' '}
      {setup.text === true ? 'Text may be edited.' : 'Text unchanged.'}
      {conversation && (
        <>
          {' '}
          <Link
            to={IGT_ASSISTANT.convHref(projectId, conversation)}
            className="text-primary hover:underline"
          >
            Open conversation
          </Link>
        </>
      )}
    </p>
  );
};

// The state, what the worker is doing, its last line, and for a waiting job
// how many are ahead of it (core's `ahead`, every one another project's). A failed job says why.
const JobStatus = ({ job, user }) => {
  const failed = job.state === 'failed';
  const running = job.state === 'running';
  return (
    <div className="mb-6 flex flex-col gap-1 text-sm" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={failed ? 'destructive' : 'secondary'}>{jobStateText(job.state)}</Badge>
        {running && job.phase && <span>{jobPhaseText(job.phase)}</span>}
        {job.state === 'waiting' && job.ahead > 0 && (
          <span className="text-muted-foreground">{aheadText(job.ahead)}</span>
        )}
      </div>
      {jobSilentText(job) && <p>{jobSilentText(job)}</p>}
      {/* Who stopped it and when, as core records the stop (RPF3-D2). */}
      {job.state === 'cancelled' && job.cancelledBy && (
        <p data-testid="job-stopped-by">
          Stopped by {whoText(job.cancelledBy, job, user)}
          {job.finishedAt ? `, ${fullTimestamp(job.finishedAt)}` : ''}.
        </p>
      )}
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

// How long a job that is no longer waiting waited for a worker: until one
// took it, or until it ended untaken. Null while it waits, and for a wait of
// under a minute.
const waitedMs = (job) => {
  if (job.state === 'waiting') return null;
  const until = job.startedAt ?? job.finishedAt;
  if (!until || !job.createdAt) return null;
  const ms = new Date(until).getTime() - new Date(job.createdAt).getTime();
  return ms >= 60000 ? ms : null;
};

const When = ({ at }) => <span title={fullTimestamp(at)}>{timeAgo(at)}</span>;

// What the assistant told every piece when it planned the job, folded when
// long, the fold's label saying what it does (RP-9).
const PLANNED_SHOWN_CHARS = 200;
const PlannedInstructions = ({ text }) => {
  const [open, setOpen] = useState(false);
  const body = (
    <span className="whitespace-pre-wrap" dir="auto">
      {text}
    </span>
  );
  if (text.length <= PLANNED_SHOWN_CHARS) return body;
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-muted-foreground">{open ? 'Hide' : 'Show'}</summary>
      {body}
    </details>
  );
};

// Instructions the planning gave past their cap, kept up to a whole sentence
// (`instructionsCut`, the length given): "Cut to 3,990 of 5,210 characters."
const cutText = (text, given) =>
  `Cut to ${[...text].length.toLocaleString()} of ${given.toLocaleString()} characters.`;

// `plan`: the report's, or while there is none the plan row's (`livePlan`).
const JobFacts = ({ job, readAt, plan }) => {
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : readAt;
  const waited = waitedMs(job);
  return (
    <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
      <Fact label="Instructions">
        <span className="whitespace-pre-wrap">{job.instructions}</span>
      </Fact>
      {plan && <Fact label="Plan">{planText(plan)}</Fact>}
      {job.report?.plan?.pieceInstructions && (
        <Fact label="Assistant’s instructions">
          {job.report.plan.instructionsCut > 0 && (
            <>
              <span className="block text-muted-foreground">
                {cutText(job.report.plan.pieceInstructions, job.report.plan.instructionsCut)}
              </span>{' '}
            </>
          )}
          <PlannedInstructions text={job.report.plan.pieceInstructions} />
        </Fact>
      )}
      <Fact label="Documents">{(job.documents || []).length.toLocaleString()}</Fact>
      <Fact label="Started by">{job.startedByName}</Fact>
      {/* A job waits from its start until a worker takes it: never
          "Started" before then (RPF-P5). */}
      {job.startedAt ? (
        <Fact label="Started">
          <When at={job.startedAt} />
        </Fact>
      ) : (
        job.state === 'waiting' && (
          <Fact label="Waiting since">
            <When at={job.createdAt} />
          </Fact>
        )
      )}
      {waited !== null && <Fact label="Waited">{durationText(waited)}</Fact>}
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

// A row per document of the job, in the job's order. Once the job has a
// report, how many places each document's Left blank lists stands beside its
// sentences, so "8 of 8" never reads as nothing left (REV-DAY-P-4).
const JobDocuments = ({ job, projectId }) => {
  const leftOut = new Set((job.report?.plan?.leftOut || []).map((d) => d.documentId));
  const reported = new Map((job.report?.documents || []).map((d) => [d.documentId, d]));
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
          : stoppedPartway(d)
            ? 'Stopped partway'
            : allSkipped(d)
              ? 'Skipped'
              : (jobDocumentStateText(d.state) ?? d.state),
    },
    {
      key: 'done',
      label: 'Sentences',
      align: 'right',
      render: (d) => documentSentencesText(d),
    },
  ];
  if ([...reported.values()].some((d) => leftText(d) !== null)) {
    columns.push({
      key: 'left',
      label: 'Left blank',
      align: 'right',
      render: (d) => leftText(reported.get(d.documentId)) ?? '',
    });
  }
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
  if (rows.some((d) => changesGroup(d) || d.harmonizeGroup)) {
    columns.push({
      key: 'history',
      // Its links are named "Changes": the column is too, and the count
      // beside it "Changes written", as the report's totals say (RPF3-E).
      label: 'Changes',
      render: (d) => (
        <JobHistoryLinks projectId={projectId} document={d} running={isJobActive(job)} />
      ),
    });
  }
  for (const [key, label] of [
    ['words', 'Words'],
    ['links', 'Links'],
    ['entries', 'Entries'],
    ['changes', 'Changes written'],
    ['deletions', 'Deletions'],
    ['peoplesValuesChanged', 'People’s values, morphemes and links changed or removed'],
    ['textChanges', 'Changes to the text'],
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
