import { useContext, useEffect, useRef, useState } from 'react';
import { Play, X } from 'lucide-react';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { Textarea } from '@ui/components/ui/textarea';
import { AuthContext } from '@ui/contexts/useAuth.js';
import { jobTaskText } from '@ui/domain/jobs.js';
import { canStartJob } from '@ui/domain/permissions.js';
import { humanizeError, statusOf } from '@ui/lib/errors.js';
import { notifyError } from '@/utils/feedback';
import { cn } from '@ui/lib/utils';
import { APP_ROUTES } from '../../../appRoutes.js';
import { activeJobOf, jobPath, noteLength, startJob } from '../jobs/jobText.js';
import { AppLink, JobActiveLine, NoWorkerLine, NoteCount } from '../jobs/jobLines.jsx';

// The job card: an unattended job the assistant drafted with the user
// (plaid-agent's propose_job), on the reply that drafted it. The page starts
// the job, as the signed-in user and under the card's id, with the call the
// Start job dialog makes, then tells the assistant how the card ended
// (`onSettle`), which records it in the conversation. Only the brief can be
// changed here: the documents and the tasks are what the conversation settled.

// Document names the card lists before "and N more".
const JOB_CARD_NAMES = 5;

// Core's refusals that end a start for good: what was asked cannot start as
// it is. Anything else (no answer, a server error) leaves the card to try again.
const REFUSED = new Set([400, 403, 404, 409]);

const BADGES = {
  started: ['secondary', 'Started'],
  discarded: ['outline', 'Discarded'],
  failed: ['outline', 'Not started'],
  replaced: ['outline', 'Replaced'],
};

const Documents = ({ card, projectId }) => {
  if (card.all) return <>All documents ({card.count.toLocaleString()})</>;
  const docs = card.documents || [];
  const shown = docs.slice(0, JOB_CARD_NAMES);
  const more = docs.length - shown.length;
  return (
    <>
      {shown.map((d, i) => (
        <span key={d.id}>
          {i > 0 && ', '}
          <AppLink className="underline" to={APP_ROUTES.document(projectId, d.id)}>
            <bdi>{d.name || d.id}</bdi>
          </AppLink>
        </span>
      ))}
      {more > 0 && ` and ${more.toLocaleString()} more`}
    </>
  );
};

export const JobCard = ({ card, projectId, client, readOnly = false, onSettle }) => {
  const user = useContext(AuthContext)?.user ?? null;
  const undecided = card.status == null;
  const [project, setProject] = useState(null);
  const [worker, setWorker] = useState(null);
  const [brief, setBrief] = useState(card.brief || '');
  const [starting, setStarting] = useState(false);
  // The job is made under the card's own id, so a press again after an answer
  // that never came (or after a reload) finds the job the first one made.
  const mint = useRef(card.id);

  useEffect(() => {
    if (!undecided || readOnly) return undefined;
    let live = true;
    client.projects
      .get(projectId)
      .then((p) => live && setProject(p))
      .catch(() => {});
    client.jobs
      .worker()
      .then((w) => live && setWorker(w))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, projectId, undecided, readOnly]);

  const noteMax = worker?.noteMaxChars ?? null;
  const noteOver = noteMax !== null && noteLength(brief) > noteMax;
  const mayStart = canStartJob(project, user);
  const badge = BADGES[card.status];

  const start = async () => {
    setStarting(true);
    try {
      await startJob(client, projectId, mint, {
        tasks: card.tasks || [],
        documents: card.all ? null : (card.documents || []).map((d) => d.id),
        note: brief,
      });
      await onSettle({ outcome: 'started', brief: brief.trim() });
    } catch (err) {
      const active = activeJobOf(err);
      if (active || REFUSED.has(statusOf(err))) {
        await onSettle({
          outcome: 'failed',
          reason: active
            ? 'This project already has a job.'
            : err.responseData?.error || humanizeError(err),
          activeJob: active,
        });
      } else {
        notifyError(err, 'Failed to start the job');
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      data-testid="job-card"
      className={cn(
        'flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm',
        undecided && 'border-primary/40 bg-primary/5',
        card.status === 'started' && 'border-success/40 bg-success/5',
        (card.status === 'discarded' || card.status === 'replaced') && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="font-medium">Proposed job</span>
        {badge && (
          <Badge variant={badge[0]} className="ml-auto shrink-0">
            {badge[1]}
          </Badge>
        )}
        {undecided && readOnly && (
          <Badge variant="outline" className="ml-auto shrink-0">
            Waiting to start
          </Badge>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Documents</dt>
        <dd className="min-w-0">
          <Documents card={card} projectId={projectId} />
        </dd>
        <dt className="text-muted-foreground">Tasks</dt>
        <dd>{(card.tasks || []).map(jobTaskText).join(', ')}</dd>
      </dl>
      {undecided && !readOnly && mayStart ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`job-brief-${card.id}`}>Instructions</Label>
          <Textarea
            id={`job-brief-${card.id}`}
            compose
            rows={4}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            aria-invalid={noteOver ? true : undefined}
          />
          <NoteCount note={brief} max={noteMax} />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Instructions</span>
          <p dir="auto" className="whitespace-pre-wrap" data-testid="job-card-brief">
            {card.status === 'started' ? card.sentBrief : card.brief}
          </p>
        </div>
      )}
      {card.status === 'started' && card.jobId && (
        <AppLink className="underline" to={jobPath(projectId, card.jobId)}>
          Open job
        </AppLink>
      )}
      {card.status === 'failed' &&
        (card.activeJob ? (
          <JobActiveLine projectId={projectId} jobId={card.activeJob} />
        ) : (
          <p role="alert" className="text-destructive">
            {card.reason || 'The job did not start.'}
          </p>
        ))}
      {undecided && !readOnly && (
        <>
          {mayStart && <NoWorkerLine worker={worker} />}
          <div className="flex flex-wrap items-center gap-2">
            {mayStart ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={start}
                disabled={starting || noteOver}
              >
                <Play className="h-4 w-4" /> {starting ? 'Starting…' : 'Start job'}
              </Button>
            ) : (
              project && (
                <span className="text-muted-foreground">Starting a job needs write access.</span>
              )
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onSettle({ outcome: 'discarded' })}
              disabled={starting}
            >
              <X className="h-4 w-4" /> Discard
            </Button>
          </div>
        </>
      )}
    </div>
  );
};
