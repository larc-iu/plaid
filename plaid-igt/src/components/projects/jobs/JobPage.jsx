import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { notifyError } from '@/utils/feedback';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { IsolatedLabel } from '@ui/components/shared/IsolatedLabel.jsx';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { DataTable } from '@ui/components/shared/data-table';
import { SegmentedControl } from '@ui/components/shared/SegmentedControl.jsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/components/ui/tabs';
import { LoadError } from '@ui/components/shared/LoadError.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { SectionHeader } from '@ui/components/shared/SectionHeader.jsx';
import { fullTimestamp, timeAgo } from '@ui/lib/formatTime.js';
import { projectNotFound } from '@ui/lib/errors.js';
import { canEditProject, canManageProject, canStopJob } from '@ui/domain/permissions.js';
import { historyHref } from '@ui/hooks/useHistoryParam.js';
import { useTabParam } from '@ui/hooks/useTabParam.js';
import { TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList.js';
import { compareNames, textIncludes } from '@ui/domain/collation.js';
import { t, tx } from '@ui/lib/i18n.js';
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
import { JobHistoryLinks } from './JobHistoryLinks.jsx';
import { assistantTabPath } from '../assistant/adapter.js';
import { JobActivity } from './JobActivity.jsx';
import { PIECES_MAX, pageOfParam, useJobPieces } from './jobPieces.js';
import { ReportOverview, ReportSection } from './JobSections.jsx';
import { CHECK_KINDS, documentChecks, jobSections } from './jobOverview.js';
import { FillsNames } from './jobLines.jsx';
import {
  aheadText,
  durationText,
  jobEditedText,
  jobName,
  jobPath,
  jobsTabPath,
  changesGroup,
  leftText,
  planParts,
  readableSetup,
  whoText,
  stoppedPartway,
  wroteNothing,
  allSkipped,
  documentSentencesText,
  nothingFound,
} from './jobText.js';

/**
 * A job's own page, `/projects/:projectId/jobs/:jobId`: its actions (Undo
 * job, Discuss with the assistant, Stop for whoever may), a line of its state,
 * and its sections, in the address (`?view=`, `jobSections`).
 *
 * While the job waits or runs: Overview (its instructions, its plan and its
 * work so far, filling in), Documents (each document's progress) and Setup.
 * Once it has ended: Overview (what it changed in one sentence, what needs a
 * person, the totals and the assistant's summary), Documents, Notes (each
 * piece of its work as it finished), a section for each list its report holds
 * (Left blank, Skipped, Proposed and the rest), and Setup. A section with
 * nothing in it is not drawn, and an address naming one the job does not
 * have opens Overview. Read again every JOB_POLL_MS while the job is active,
 * and once otherwise.
 *
 * It is a place the assistant reads, as a document is: the panel's turns are
 * asked from the job, and the service gives the model the job's summary. An
 * ended job with a report offers a new conversation about it.
 */
export const JobPage = ({ project, projectId, jobId, client }) => {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
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
  // Whether the job ended while this page was open (the transition below).
  const [endedHere, setEndedHere] = useState(false);
  useEffect(() => setEndedHere(false), [jobId]);
  const undoneOp = job?.undone?.operation ?? null;
  // The names of who stopped or undid the job, where the directory is open
  // to the reader (REV-RPF3-6).
  const names = usePeopleNames(client, [job?.cancelledBy, job?.undone?.user], job, user);
  const documentIds = (job?.documents || []).map((d) => d.documentId).join(',');
  const active = !!job && isJobActive(job);
  // The work list's rows: while the job is active as many as the page in the
  // address reaches, once it has ended all of them (JobActivity). The plan as
  // its row gives it, while the report has none, from the moment planning
  // ends (RP-9).
  const pieces = useJobPieces(
    client,
    jobId,
    readAt,
    active
      ? Math.min(PIECES_MAX, (pageOfParam(params.get('page')) + 1) * TALL_LIST_PAGE_SIZE)
      : PIECES_MAX,
    !!job,
  );
  // An ended job's rows are all read at the cap: until that read lands, the
  // rows shown are the running read's, which no count of Notes is (REV-RP-7).
  const allRead = !!pieces.page && (active || pieces.limit === PIECES_MAX);
  // Except for a job that ended with its page open, whose reader is taken to
  // Notes at once: until every row is read, it counts the rows already read
  // (REV-RP-R2-1).
  const counted = allRead || (endedHere && !!pieces.page);
  const sections = useMemo(
    () => (job ? jobSections(job, counted ? pieces.rows.length : null, project?.vocabs) : []),
    [job, counted, pieces.rows.length, project?.vocabs],
  );
  const keys = useMemo(() => sections.map((s) => s.key), [sections]);
  // The sections can still grow until the job has ended and its work list
  // has been read: an address naming one is kept until then.
  const [view, setView, viewHref] = useTabParam(keys, 'overview', {
    param: 'view',
    ready: !!job && !active && allRead,
    clears: SECTION_PARAMS,
  });
  // The moment the job ends with its page open, the reader keeps their place
  // (REV-RP-7): a page of Work so far past the first is the same page of
  // Notes, and the Overview stays the Overview, a section the address kept
  // while the job ran dropped.
  const wasActive = useRef(false);
  useEffect(() => {
    if (!job) return;
    if (wasActive.current && !active) {
      setEndedHere(true);
      setParams(
        (prev) => {
          const view = prev.get('view');
          if (view === 'documents' || view === 'setup') return prev;
          const out = new URLSearchParams();
          if (pageOfParam(prev.get('page')) > 0) out.set('view', 'notes');
          for (const [key, value] of prev) {
            if (!['view', 'filter', 'order'].includes(key)) out.set(key, value);
          }
          return out;
        },
        { replace: true },
      );
    }
    wasActive.current = active;
  }, [job, active, setParams]);
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
      title: t('Stop the job?'),
      description: t('What it wrote stays.'),
      confirmLabel: t('Stop'),
    });
    if (!ok) return;
    setStopping(true);
    try {
      setJob(await client.jobs.cancel(jobId));
      setReadAt(Date.now());
    } catch (err) {
      notifyError(err, t('Failed to stop the job'));
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
      <ArrowLeft className="h-4 w-4" /> {t('All jobs')}
    </Link>
  );

  if (error) {
    return (
      <div>
        {back}
        {projectNotFound(error) ? (
          <LoadError>{t('Job not found.')}</LoadError>
        ) : (
          <LoadError onRetry={() => setAttempt((n) => n + 1)}>
            {t('Failed to load the job')}
          </LoadError>
        )}
      </div>
    );
  }
  if (!job) return <Loading />;

  const stoppable = jobStoppable(job) && canStopJob(job, project, user);
  const discussable = !active && !!job.report;
  // A maintainer undoes an ended job whole, documents and lexicon together.
  // Not while it stands undone, even once its work is brought back from
  // History (a job stays undone, H2-5-1). Not for a job that wrote nothing
  // (RP-4): offered whenever History holds its writes, whatever its report
  // counts (`wrote`, core's, S3-1).
  const undoable =
    !active && canManageProject(project, user) && !job.undone && (job.wrote || !wroteNothing(job));
  const plan = job.report?.plan ?? pieces.plan;
  const at = jobPath(projectId, jobId);
  // A section of the page, with a filter of its list where one is given.
  const sectionHref = (key, filter) => {
    const href = viewHref(at, key);
    if (!filter) return href;
    return `${href}${href.includes('?') ? '&' : '?'}filter=${encodeURIComponent(filter)}`;
  };

  // After an undo: the job read again, which says it stands undone, also when
  // the call undid nothing because another page undid it first (S6-3).
  const afterUndo = async () => {
    dropPrecedent();
    try {
      setJob(await client.jobs.get(jobId));
      setReadAt(Date.now());
    } catch (err) {
      notifyError(err, t('Failed to read the job again'));
    }
  };

  // An undo that undid nothing because the job already stands undone (another
  // page undid it since this one was read) says that, not every row "not
  // undone" (S6-3).
  const sendUndo = async ({ dryRun }) => {
    const res = await client.jobs.undo(jobId, { dryRun });
    if (dryRun || res?.operation) return res;
    const now = await client.jobs.get(jobId).catch(() => null);
    return now?.undone ? { ...res, already: t('This job was already undone.') } : res;
  };

  return (
    <div>
      {back}
      <SectionHeader
        title={t('Job')}
        className="mb-3"
        actions={
          (stoppable || discussable || undoable) && (
            <div className="flex gap-2">
              {discussable && <Discuss client={client} projectId={projectId} />}
              {undoable && (
                <Button variant="outline" onClick={() => setUndoOpen(true)}>
                  {t('Undo job')}
                </Button>
              )}
              {stoppable && (
                <Button variant="outline" onClick={stop} disabled={stopping}>
                  {t('Stop')}
                </Button>
              )}
            </div>
          )
        }
      />
      <JobStatus job={job} user={user} names={names} readAt={readAt} undoneHref={undoneHref} />
      {undoable && (
        <UndoDialog
          open={undoOpen}
          onOpenChange={setUndoOpen}
          client={client}
          entry={{ id: jobId, label: jobName(job) }}
          title={t('Undo this job?')}
          send={sendUndo}
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
      <Tabs value={view} onValueChange={setView}>
        <div className="mb-6 border-b">
          <TabsList className="border-b-0" aria-label={t('Sections')}>
            {sections.map((s) => (
              <TabsTrigger key={s.key} value={s.key} to={viewHref(at, s.key)}>
                {s.label}
                {s.count !== undefined && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {s.count.toLocaleString()}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {/* The section shown, its tab's panel. */}
        <TabsContent value={view} className="mt-0" data-view={view}>
          {view === 'overview' && (
            <>
              <Instructions text={job.instructions} />
              <JobSetup job={job} projectId={projectId} user={user} />
              {active ? (
                <>
                  <JobProgress job={job} readAt={readAt} />
                  {plan && (
                    <p className="mt-3 max-w-3xl text-sm" data-testid="job-plan">
                      <span className="text-muted-foreground">{t('Plan')} </span>
                      <IsolatedLabel parts={planParts(plan)} />
                    </p>
                  )}
                  <JobActivity job={job} projectId={projectId} pieces={pieces} />
                </>
              ) : (
                <ReportOverview job={job} sectionHref={sectionHref} sections={keys} />
              )}
            </>
          )}
          {view === 'documents' && <JobDocuments job={job} projectId={projectId} plan={plan} />}
          {view === 'notes' && <JobActivity job={job} projectId={projectId} pieces={pieces} />}
          {!PAGE_SECTIONS.includes(view) && job.report && (
            <ReportSection
              view={view}
              report={job.report}
              projectId={projectId}
              vocabs={project?.vocabs || []}
            />
          )}
          {view === 'setup' && <JobFacts job={job} readAt={readAt} plan={plan} />}
        </TabsContent>
      </Tabs>
    </div>
  );
};

// The sections the page draws itself: every other is one of the report's
// lists (ReportSection).
const PAGE_SECTIONS = ['overview', 'documents', 'notes', 'setup'];

// What belongs to one section's list (its page, its filter, its order), which
// a move to another section drops.
const SECTION_PARAMS = ['page', 'filter', 'order'];

// The job's instructions, two lines of them where they are long, with a
// control to show them all.
const INSTRUCTIONS_SHOWN_CHARS = 160;
const Instructions = ({ text = '' }) => {
  const [open, setOpen] = useState(false);
  const long = [...text].length > INSTRUCTIONS_SHOWN_CHARS || text.includes('\n');
  return (
    <div className="max-w-3xl text-sm" data-testid="job-instructions">
      <p className={`whitespace-pre-wrap ${long && !open ? 'line-clamp-2' : ''}`}>
        <span className="text-muted-foreground">{t('Instructions')} </span>
        <bdi>{text}</bdi>
      </p>
      {long && (
        <button
          type="button"
          className="text-sm text-primary hover:underline"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t('Show less') : t('Show all')}
        </button>
      )}
    </div>
  );
};

// The display names of `ids` (who stopped or undid a job) neither the reader
// nor the job's starter, read once from the user directory, which only some
// readers may read: none where it is refused (REV-RPF3-6).
const usePeopleNames = (client, ids, job, user) => {
  const [names, setNames] = useState({});
  const wanted = ids
    .filter((id) => id && id !== user?.id && id !== job?.startedBy)
    .sort()
    .join(',');
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    Promise.resolve()
      .then(() => client.users.list())
      .then((all) => {
        if (!live) return;
        setNames(
          Object.fromEntries(
            (all || []).filter((u) => u.displayName).map((u) => [u.id, u.displayName]),
          ),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, wanted]);
  return names;
};

// A new conversation about the job, in the assistant panel, where an
// assistant is online and the window has room for the panel (it opens beside
// the page). On a narrower window, the link every narrow place draws: the
// project's Assistant tab, which is not told about the job.
const Discuss = ({ client, projectId }) => {
  const available = useAssistantAvailable(client, projectId, IGT_ASSISTANT.app);
  const wide = useWideEnoughToDock();
  const discuss = useStartConversation();
  if (available !== true) return null;
  return wide ? (
    <Button variant="outline" className="gap-1.5" onClick={() => discuss()}>
      <AssistantMark className="h-4 w-4" />
      {t('Discuss with the assistant')}
    </Button>
  ) : (
    <Button variant="outline" className="gap-1.5" asChild>
      <Link to={assistantTabPath(projectId)}>
        <AssistantMark className="h-4 w-4" />
        {t('Assistant')}
      </Link>
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
    <p className="mt-1 max-w-3xl text-sm text-muted-foreground" data-testid="job-setup">
      {setupFillsText(setup, gone)}{' '}
      {setup.text === true ? t('Text may be edited.') : t('Text unchanged.')}
      {conversation && (
        <>
          {' '}
          <Link
            to={IGT_ASSISTANT.convHref(projectId, conversation)}
            className="text-primary hover:underline"
          >
            {t('Open conversation')}
          </Link>
        </>
      )}
    </p>
  );
};

// What a setup fills, as the setup line's first sentence.
const setupFillsText = (setup, gone) => {
  const only = setup.onlynew === true;
  if (!setup.fills?.length) {
    return only
      ? t('Set up to fill nothing, only on the words it adds.')
      : t('Set up to fill nothing.');
  }
  const fills = <FillsNames fills={setup.fills} gone={gone} />;
  return only
    ? tx('Set up to fill {fills}, only on the words it adds.', { fills })
    : tx('Set up to fill {fills}.', { fills });
};

// The state, what the worker is doing, its last line, and for a waiting job
// how many are ahead of it (core's `ahead`, every one another project's). An
// ended job says when it ended, how long it took and who started it, who
// stopped or undid it and when, and a failed one why.
const JobStatus = ({ job, user, names, undoneHref }) => {
  const failed = job.state === 'failed';
  const running = job.state === 'running';
  const active = isJobActive(job);
  const took =
    job.startedAt && job.finishedAt
      ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
      : null;
  return (
    <div className="mb-6 flex flex-col gap-1 text-sm" role="status">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* Once undone, what the chat card says (RP4-4 finding 6). */}
        <Badge variant={failed ? 'destructive' : 'secondary'}>
          {job.undone ? t('Undone') : jobStateText(job.state)}
        </Badge>
        {running && job.phase && <span>{jobPhaseText(job.phase)}</span>}
        {job.state === 'waiting' && job.ahead > 0 && (
          <span className="text-muted-foreground">{aheadText(job.ahead)}</span>
        )}
        {!active && (
          <span className="text-muted-foreground" data-testid="job-ended">
            {job.finishedAt && (
              <>
                {tx('Ended {when}', { when: <When at={job.finishedAt} /> })}
                {' · '}
              </>
            )}
            {took !== null &&
              `${
                took < 60000
                  ? t('took under a minute')
                  : t('took {duration}', { duration: durationText(took) })
              } · `}
            {t('started by {who}', { who: whoText(job.startedBy, job, user, names) })}
          </span>
        )}
      </div>
      {jobSilentText(job) && <p>{jobSilentText(job)}</p>}
      {/* Who stopped it and when, as core records the stop (RPF3-D2). */}
      {job.state === 'cancelled' && job.cancelledBy && (
        <p data-testid="job-stopped-by">
          {job.finishedAt
            ? t('Stopped by {who}, {time}.', {
                who: whoText(job.cancelledBy, job, user, names),
                time: fullTimestamp(job.finishedAt),
              })
            : t('Stopped by {who}.', { who: whoText(job.cancelledBy, job, user, names) })}
        </p>
      )}
      {job.undone && (
        <p data-testid="job-undone">
          {t('Undone by {who}, {time}.', {
            who: whoText(job.undone.user, job, user, names),
            time: fullTimestamp(job.undone.time),
          })}
          {undoneHref && (
            <>
              {' '}
              <Link to={undoneHref} className="text-primary hover:underline">
                {t('Show in History')}
              </Link>
            </>
          )}
        </p>
      )}
      {failed ? (
        <p>{jobReasonText(job)}</p>
      ) : (
        active && job.message && <p className="text-muted-foreground">{job.message}</p>
      )}
    </div>
  );
};

const Fact = ({ label, children }) => (
  <div className="contents">
    <dt className="text-muted-foreground">{label}</dt>
    {/* A long unbroken value (a search's pattern) wraps (REV-SF-6). */}
    <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
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
      <summary className="cursor-pointer text-muted-foreground">
        {open ? t('Hide') : t('Show')}
      </summary>
      {body}
    </details>
  );
};

// Instructions the planning gave past their cap, kept up to a whole sentence
// (`instructionsCut`, the length given): "Cut to 3,990 of 5,210 characters."
const cutText = (text, given) =>
  t('Cut to {n, number} of {given, number} characters.', { n: [...text].length, given });

// How far a job still waiting or running has got, on its Overview (REV-RP-5):
// its documents done of how many, from its own rows, when it started (or
// since when it waits) and how long it has run, in the Setup's words.
const JobProgress = ({ job, readAt }) => {
  const docs = job.documents || [];
  const done = docs.filter((d) => d.state === 'done').length;
  return (
    <dl
      className="mt-3 grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm"
      data-testid="job-progress"
    >
      <Fact label={t('Documents done')}>
        {t('{done, number} of {n, number}', { done, n: docs.length })}
      </Fact>
      {job.startedAt ? (
        <>
          <Fact label={t('Started')}>
            <When at={job.startedAt} />
          </Fact>
          <Fact label={t('Elapsed')}>
            {durationText(readAt - new Date(job.startedAt).getTime())}
          </Fact>
        </>
      ) : (
        <Fact label={t('Waiting since')}>
          <When at={job.createdAt} />
        </Fact>
      )}
    </dl>
  );
};

// The job's Setup: how it was planned and run (its instructions are on its
// Overview). `plan`: the report's, or while there is none the plan row's.
const JobFacts = ({ job, readAt, plan }) => {
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : readAt;
  const waited = waitedMs(job);
  return (
    <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
      {plan && (
        <Fact label={t('Plan')}>
          <IsolatedLabel parts={planParts(plan)} />
        </Fact>
      )}
      {job.report?.plan?.pieceInstructions && (
        <Fact label={t('Assistant’s instructions')}>
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
      <Fact label={t('Documents')}>{(job.documents || []).length.toLocaleString()}</Fact>
      <Fact label={t('Started by')}>{job.startedByName}</Fact>
      {/* A job waits from its start until a worker takes it: never
          "Started" before then (RPF-P5). */}
      {job.startedAt ? (
        <Fact label={t('Started')}>
          <When at={job.startedAt} />
        </Fact>
      ) : (
        job.state === 'waiting' && (
          <Fact label={t('Waiting since')}>
            <When at={job.createdAt} />
          </Fact>
        )
      )}
      {waited !== null && <Fact label={t('Waited')}>{durationText(waited)}</Fact>}
      {job.finishedAt && (
        <Fact label={t('Ended')}>
          <When at={job.finishedAt} />
        </Fact>
      )}
      {job.startedAt && (
        <Fact label={t('Elapsed')}>{durationText(end - new Date(job.startedAt).getTime())}</Fact>
      )}
      {job.model && <Fact label={t('Model')}>{job.model}</Fact>}
    </dl>
  );
};

const count = (row, key) => (row.counts?.[key] ?? 0).toLocaleString();

// A row per document of the job, searchable by name and sortable. Once the job
// has a report, how many places each document's Left blank lists stands
// beside its sentences, so "8 of 8" never reads as nothing left
// (REV-DAY-P-4), why it needs a person (To check), and a filter to those
// that do, in the address: `?filter=check` for every reason, or one reason
// (`CHECK_KINDS`), which a To check row of the Overview opens.
// `plan`: the report's, or while there is none the plan row's.
const JobDocuments = ({ job, projectId, plan }) => {
  const [params, setParams] = useSearchParams();
  const ended = !isJobActive(job);
  const leftOut = new Set((job.report?.plan?.leftOut || []).map((d) => d.documentId));
  const reported = new Map((job.report?.documents || []).map((d) => [d.documentId, d]));
  const checks = new Map(
    (job.documents || []).map((d) => [
      d.documentId,
      ended ? documentChecks(d, reported.get(d.documentId), leftOut, job) : [],
    ]),
  );
  const toCheck = (job.documents || []).filter((d) => checks.get(d.documentId).length > 0);
  const asked = params.get('filter');
  const ofKind = (kind) =>
    toCheck.filter((d) => checks.get(d.documentId).some((c) => c.kind === kind));
  // A reason no document has shows them all.
  const filter = !ended
    ? 'all'
    : asked === 'check'
      ? 'check'
      : CHECK_KINDS[asked] && ofKind(asked).length
        ? asked
        : 'all';
  const shown =
    filter === 'all' ? job.documents || [] : filter === 'check' ? toCheck : ofKind(filter);
  // A filter the table does not show (unknown, or a reason no document has)
  // leaves the address, as an unknown section does (REV-RP-R2-2).
  const dropped = asked !== null && filter === 'all';
  useEffect(() => {
    if (!dropped) return;
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.delete('filter');
        return out;
      },
      { replace: true },
    );
  }, [dropped, setParams]);
  const stateOf = (d) =>
    leftOut.has(d.documentId)
      ? t('Left out by the plan')
      : stoppedPartway(d)
        ? t('Stopped partway')
        : nothingFound(d)
          ? t('Nothing found')
          : allSkipped(d)
            ? t('Skipped')
            : (jobDocumentStateText(d.state) ?? d.state);
  const order = new Map((job.documents || []).map((d, i) => [d.documentId, i + 1]));
  const columns = [
    // The job's order, the order it works them in: the table's first order,
    // whatever the job's state (REV-RP-5).
    {
      key: 'order',
      label: '#',
      align: 'right',
      sort: (d) => order.get(d.documentId),
      render: (d) => order.get(d.documentId).toLocaleString(),
    },
    {
      key: 'name',
      label: t('Document'),
      sort: (d) => d.name ?? '',
      compare: compareNames,
      render: (d) =>
        d.name === null || d.name === undefined ? (
          <span className="text-muted-foreground">{t('Deleted document')}</span>
        ) : (
          <Link className="hover:underline" to={`/projects/${projectId}/documents/${d.documentId}`}>
            {d.name}
          </Link>
        ),
    },
    { key: 'state', label: t('State'), sort: stateOf, render: stateOf },
    {
      key: 'done',
      label: t('Sentences'),
      align: 'right',
      sort: (d) => d.done ?? -1,
      render: (d) => documentSentencesText(d, plan),
    },
  ];
  if ([...reported.values()].some((d) => leftText(d) !== null)) {
    columns.push({
      key: 'left',
      label: t('Left blank'),
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
      label: t('Translations'),
      align: 'right',
      sort: (d) => (d.counts?.translations ?? 0) + (d.counts?.refreshed ?? 0),
      render: (d) => ((d.counts?.translations ?? 0) + (d.counts?.refreshed ?? 0)).toLocaleString(),
    });
  }
  // Each pass's History entry in the document: what the job changed there.
  if (rows.some((d) => changesGroup(d) || d.harmonizeGroup)) {
    columns.push({
      key: 'history',
      // Its links are named "Changes": the column is too, and the count
      // beside it "Changes written", as the report's totals say (RPF3-E).
      label: t('Changes'),
      render: (d) => (
        <JobHistoryLinks projectId={projectId} document={d} running={isJobActive(job)} />
      ),
    });
  }
  for (const [key, label] of [
    ['words', t('Words')],
    ['links', t('Links')],
    ['entries', t('Entries')],
    ['changes', t('Changes written')],
    ['deletions', t('Deletions')],
    ['peoplesValuesChanged', t('People’s values, morphemes and links changed or removed')],
    ['textChanges', t('Changes to the text')],
    ['proposed', t('Proposed')],
  ]) {
    if (some(key)) {
      columns.push({
        key,
        label,
        align: 'right',
        sort: (d) => d.counts?.[key] ?? 0,
        render: (d) => count(d, key),
      });
    }
  }
  if (toCheck.length) {
    columns.push({
      key: 'check',
      label: t('To check'),
      // Wide enough that a row stays a line or two where the table scrolls.
      className: 'min-w-[18rem]',
      render: (d) =>
        checks
          .get(d.documentId)
          .map((c) => c.text)
          .join('; '),
    });
  }
  const setFilter = (value) =>
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (value === 'all') out.delete('filter');
      else out.set('filter', value);
      out.delete('page');
      return out;
    });
  return (
    <DataTable
      id="job-documents"
      // A sort is this job's: the next job opens in its own order.
      scope={job.id}
      rows={shown}
      rowKey={(d) => d.documentId}
      columns={columns}
      defaultSort={{ key: 'order', dir: 'asc' }}
      pageParam="page"
      search={{
        placeholder: t('Search documents…'),
        match: (d, q) => textIncludes(d.name ?? '', q),
      }}
      countLabel={(v) => t('{total} {n, plural, one {document} other {documents}}', v)}
      noMatch={t('No documents match.')}
      // The filter says how many it shows once the job has ended.
      showCount={!ended}
      empty={t('Nothing.')}
      actions={
        ended && (
          <SegmentedControl
            label={t('Show')}
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('All'), count: rows.length.toLocaleString() },
              { value: 'check', label: t('To check'), count: toCheck.length.toLocaleString() },
              ...(CHECK_KINDS[filter]
                ? [
                    {
                      value: filter,
                      label: t(CHECK_KINDS[filter]),
                      count: ofKind(filter).length.toLocaleString(),
                    },
                  ]
                : []),
            ]}
          />
        )
      }
    />
  );
};
