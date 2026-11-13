import { Link, useInRouterContext } from 'react-router-dom';
import { workerSeen } from '@ui/domain/jobs.js';
import { jobPath, noteLength } from './jobText.js';

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

// Said when core refused a start for the project's job already under way.
export const JobActiveLine = ({ projectId, jobId, onOpen }) => (
  <p role="alert" className="text-sm text-destructive">
    This project already has a job.{' '}
    <AppLink className="underline" to={jobPath(projectId, jobId)} onClick={onOpen}>
      Open it
    </AppLink>
  </p>
);

// The instructions' count against core's cap, once the cap is read.
export const NoteCount = ({ note, max }) =>
  max === null || max === undefined ? null : (
    <p
      data-testid="job-note-count"
      className={`text-right text-xs ${noteLength(note) > max ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {noteLength(note).toLocaleString()} / {max.toLocaleString()}
    </p>
  );
