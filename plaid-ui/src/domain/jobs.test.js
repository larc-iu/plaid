import { describe, it, expect } from 'vitest';
import {
  JOB_ACTIVE_POLL_MS,
  JOB_POLL_MS,
  JOB_WORKER_SEEN_S,
  bannerProps,
  isJobActive,
  jobDocumentStateText,
  jobPhaseText,
  jobReasonText,
  jobStateText,
  jobTaskText,
  workerSeen,
} from './jobs.js';

// An assistant job (unattended glossing, the jobs round of 2026-11-12) as the
// apps see it: the constants they poll by, the words for what core stores as
// codes, and the banner a document shows while the job works in it.

const row = (over = {}) => ({
  documentId: 'd1',
  name: 'Text 1',
  position: 0,
  state: 'working',
  sentences: 40,
  targets: 20,
  done: 5,
  ...over,
});

const job = (over = {}) => ({
  id: 'j1',
  state: 'running',
  currentDocument: 'd1',
  message: 'Sentences 11 to 15 of 40.',
  startedAt: '2026-11-12T10:00:00Z',
  documents: [row(), row({ documentId: 'd2', position: 1, state: 'waiting', done: 0 })],
  ...over,
});

describe('the constants', () => {
  it('are the contract’s', () => {
    expect(JOB_WORKER_SEEN_S).toBe(120);
    expect(JOB_POLL_MS).toBe(5000);
    expect(JOB_ACTIVE_POLL_MS).toBe(15000);
  });
});

describe('bannerProps', () => {
  it('is the run banner of the document the job is working in', () => {
    expect(bannerProps(job(), 'd1')).toEqual({
      label: 'Assistant job',
      startedAt: Date.parse('2026-11-12T10:00:00Z'),
      percent: 25,
      message: 'Sentences 11 to 15 of 40.',
      paused: false,
    });
  });

  it('is nothing on another document of the job, or with no job', () => {
    expect(bannerProps(job(), 'd2')).toBe(null);
    expect(bannerProps(job({ currentDocument: null }), 'd1')).toBe(null);
    expect(bannerProps(null, 'd1')).toBe(null);
  });

  it('shows while the job runs or stops, and not while it waits or once it ended', () => {
    expect(bannerProps(job({ state: 'stopping' }), 'd1')).not.toBe(null);
    for (const state of ['waiting', 'done', 'cancelled', 'failed']) {
      expect(bannerProps(job({ state }), 'd1')).toBe(null);
    }
  });

  it('leaves the percent unknown while the document’s targets are not counted, or none', () => {
    expect(bannerProps(job({ documents: [row({ targets: null })] }), 'd1').percent).toBe(null);
    expect(bannerProps(job({ documents: [row({ targets: 0, done: 0 })] }), 'd1').percent).toBe(
      null,
    );
    expect(bannerProps(job({ documents: [] }), 'd1').percent).toBe(null);
  });

  it('gives the percent as a whole number', () => {
    expect(bannerProps(job({ documents: [row({ targets: 3, done: 1 })] }), 'd1').percent).toBe(33);
    expect(bannerProps(job({ documents: [row({ targets: 3, done: 3 })] }), 'd1').percent).toBe(100);
  });

  it('leaves the line to the banner when the worker said nothing', () => {
    expect(bannerProps(job({ message: null }), 'd1').message).toBe(null);
  });
});

describe('the words', () => {
  it('names each state of a job', () => {
    expect(
      ['waiting', 'running', 'stopping', 'done', 'cancelled', 'failed'].map(jobStateText),
    ).toEqual(['Waiting', 'Running', 'Stopping', 'Done', 'Stopped', 'Failed']);
  });

  it('says which states are active', () => {
    expect(
      ['waiting', 'running', 'stopping', 'done', 'cancelled', 'failed'].map((state) =>
        isJobActive({ state }),
      ),
    ).toEqual([true, true, true, false, false, false]);
    expect(isJobActive(null)).toBe(false);
  });

  it('names each phase', () => {
    expect(['checking', 'glossing', 'harmonizing', 'reporting'].map(jobPhaseText)).toEqual([
      'Checking',
      'Analyzing',
      'Making analyses consistent',
      'Writing the report',
    ]);
    expect(jobPhaseText(null)).toBe(null);
  });

  it('names each state of a document in a job', () => {
    expect(
      ['waiting', 'working', 'deferred', 'done', 'in-use', 'gone', 'not-reached'].map(
        jobDocumentStateText,
      ),
    ).toEqual(['Waiting', 'Working', 'Deferred', 'Done', 'In use', 'Deleted', 'Not reached']);
  });

  it('names each task as the start dialog offers it', () => {
    expect(['translate', 'gloss', 'link'].map(jobTaskText)).toEqual([
      'Translate',
      'Segment and gloss',
      'Link to lexicon',
    ]);
  });

  it('says why a job ended by its message, else in words for its reason', () => {
    expect(
      jobReasonText({
        reason: 'guidelines-too-long',
        message: 'The project’s guidelines are 31,204 characters. A job reads at most 24,000.',
      }),
    ).toBe('The project’s guidelines are 31,204 characters. A job reads at most 24,000.');
    expect(
      [
        'starter-access',
        'missing-field',
        'no-lexicon',
        'no-status-field',
        'guidelines-too-long',
        'no-documents',
      ].map((reason) => jobReasonText({ reason, message: null })),
    ).toEqual([
      'The person who started it can no longer write in this project.',
      'The project has no field for this task.',
      'The project has no lexicon.',
      'A lexicon has no Status field.',
      'The guidelines are too long for a job.',
      'None of its documents are left.',
    ]);
    expect(jobReasonText({ reason: 'cancelled', message: null })).toBe(null);
    expect(jobReasonText(null)).toBe(null);
  });
});

describe('workerSeen', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  it('is true while the worker asked for work within the last two minutes', () => {
    expect(workerSeen({ seenAt: '2026-11-12T09:58:00Z' }, now)).toBe(true);
    expect(workerSeen({ seenAt: '2026-11-12T09:57:59Z' }, now)).toBe(false);
  });

  it('is false when no worker asked since the server started', () => {
    expect(workerSeen({ seenAt: null }, now)).toBe(false);
    expect(workerSeen(null, now)).toBe(false);
  });
});
