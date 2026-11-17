import { useContext, useEffect, useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { AuthContext } from '@ui/contexts/useAuth.js';
import { jobStateText, workerSeen } from '@ui/domain/jobs.js';
import { instructionsLength, jobPath } from './jobText.js';

// The lines Start job says wherever a job is started: the Start job dialog and
// the assistant's job card.

// A link into the app, also where no router is (a conversation's HTML export
// draws the job card outside the app), as the hash route it is.
export const AppLink = ({ to, ...rest }) =>
  useInRouterContext() ? <Link to={to} {...rest} /> : <a href={`#${to}`} {...rest} />;

// Said when no worker asked for work lately (`worker` is `jobs.worker()`'s
// answer, null while it is read).
export const NoWorkerLine = ({ worker }) =>
  worker && !workerSeen(worker) ? (
    <p className="text-sm text-muted-foreground">
      No job worker is running. The job waits until one starts.
    </p>
  ) : null;

// Said when core refused a start for the project's job already under way:
// whose it is and its state, read from the job where a `client` is given
// (RP2-3: a person could not tell whose job was in the way).
export const JobActiveLine = ({ projectId, jobId, onOpen, client = null }) => {
  const user = useContext(AuthContext)?.user ?? null;
  const [job, setJob] = useState(null);
  useEffect(() => {
    if (!client || !jobId) return undefined;
    let live = true;
    Promise.resolve()
      .then(() => client.jobs.get(jobId))
      .then((j) => live && setJob(j))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, jobId]);
  const who = job && (user?.id && job.startedBy === user.id ? 'you' : job.startedByName);
  // The state in the job page's own words, in brackets, so its ellipsis
  // ("Stopping…") is never followed by the sentence's full stop.
  const state = job && jobStateText(job.state);
  return (
    <p role="alert" className="text-sm text-destructive">
      This project already has a job
      {state ? ` (${state})` : ''}
      {who ? `, started by ${who}` : ''}.{' '}
      <AppLink className="underline" to={jobPath(projectId, jobId)} onClick={onOpen}>
        Open it
      </AppLink>
    </p>
  );
};

// The targets a setup names, each by the name the card showed and isolated
// from its neighbours' direction, or `none` when it names none. Each whose id
// is among `gone` (the job's plan found it gone) is marked so.
export const FillsNames = ({ fills, none, gone = [] }) =>
  fills?.length
    ? fills.map((f, i) => (
        <span key={`${f.id}:${i}`}>
          {i > 0 && ', '}
          <bdi>{f.name || f.id}</bdi>
          {gone.includes(f.id) && ' (deleted)'}
        </span>
      ))
    : none;

// The instructions' count against core's cap, once the cap is read.
export const InstructionsCount = ({ text, max }) =>
  max === null || max === undefined ? null : (
    <p
      data-testid="job-instructions-count"
      className={`text-right text-xs ${instructionsLength(text) > max ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {instructionsLength(text).toLocaleString()} / {max.toLocaleString()}
    </p>
  );
