import { describe, it, expect } from 'vitest';
import { hidesStopped, retryNote, rewindForRetry, stoppedIn } from './resume.js';

const conv = (messages, display) => ({ id: 'c1', messages, display });

describe('rewindForRetry', () => {
  it('drops the user message of a lost turn from the transcript, so sending it again does not duplicate it', () => {
    const c = conv(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
      [
        { kind: 'user', text: 'first' },
        { kind: 'assistant', text: 'ok' },
        { kind: 'user', text: 'second' },
      ],
    );
    const out = rewindForRetry(c);
    expect(out.text).toBe('second');
    expect(out.conv.messages).toHaveLength(2);
    // The question stays, with the line the screen showed under it, so the
    // record keeps the turn that got no answer above the one sent again.
    expect(out.conv.display).toHaveLength(4);
    expect(out.conv.display.slice(0, 3)).toEqual(c.display);
    expect(out.conv.display[3]).toMatchObject({
      kind: 'error',
      lost: true,
      text: 'No answer came back for this message.',
    });
    expect(out.conv.display[3].createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(out.conv.id).toBe('c1');
  });

  it('records a turn the reader stopped and got no record of as stopped', () => {
    const c = conv([{ role: 'user', content: 'count' }], [{ kind: 'user', text: 'count' }]);
    const out = rewindForRetry(c, { stopped: true });
    expect(out.conv.messages).toEqual([]);
    expect(out.conv.display[1]).toMatchObject({ kind: 'error', stopped: true, text: 'Stopped.' });
    expect(out.conv.display[1].lost).toBeUndefined();
  });

  it('leaves the transcript alone for a failed turn, whose user message was already dropped', () => {
    const c = conv(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
      ],
      [
        { kind: 'user', text: 'first' },
        { kind: 'assistant', text: 'ok' },
        { kind: 'user', text: 'second' },
        { kind: 'error', text: 'the assistant could not answer' },
      ],
    );
    const out = rewindForRetry(c);
    expect(out.text).toBe('second');
    expect(out.conv.messages).toHaveLength(2);
    // The failed question and its error stay, for the record.
    expect(out.conv.display).toEqual(c.display);
  });

  it('takes a saved turn whose save went unanswered out of the transcript, the stamped message included', () => {
    // conc-2026-09-29 H8-6: the service's save of the turn landed and its
    // answer was lost, so the record holds the question (stamped with where
    // it was asked) and the answer. A retry sent the question a second time.
    const c = conv(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '[Asked from the document "Doc1"]\n\nWhat is s4?' },
        { role: 'assistant', content: 'play-01' },
      ],
      [
        { kind: 'user', text: 'first' },
        { kind: 'assistant', text: 'ok' },
        { kind: 'user', text: 'What is s4?' },
        { kind: 'assistant', text: 'play-01' },
        { kind: 'error', text: 'The answer is ready but the conversation could not be saved' },
      ],
    );
    const out = rewindForRetry(c);
    expect(out.text).toBe('What is s4?');
    expect(out.conv.messages).toEqual(c.messages.slice(0, 2));
    expect(out.conv.display).toEqual(c.display);
  });

  it("takes a failed turn's question, kept stamped in the transcript, off before sending it again", () => {
    // Bench note 8: a failed turn keeps its question for the next turn to
    // read, so a retry must take it off or the model reads it twice.
    const c = conv(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '[Asked from the document "Doc1"]\n\nsecond' },
      ],
      [
        { kind: 'user', text: 'first' },
        { kind: 'assistant', text: 'ok' },
        { kind: 'user', text: 'second' },
        { kind: 'error', text: 'The model could not answer.' },
      ],
    );
    const out = rewindForRetry(c);
    expect(out.text).toBe('second');
    expect(out.conv.messages).toEqual(c.messages.slice(0, 2));
    expect(out.conv.display).toEqual(c.display);
  });

  it("takes a failed turn's question off and keeps a plan note written after it", () => {
    // The turn failed, then an older plan was discarded, which writes a note
    // after the question. A retry that left the question in place would send
    // it twice.
    const note = 'The user discarded the plan.';
    const c = conv(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'Planned.' },
        { role: 'user', content: '[Asked from the document "Doc1"]\n\nsecond' },
        { role: 'user', content: note },
      ],
      [
        { kind: 'user', text: 'first' },
        { kind: 'assistant', text: 'Planned.' },
        { kind: 'user', text: 'second' },
        { kind: 'error', text: 'The model could not answer.' },
      ],
    );
    const out = rewindForRetry(c);
    expect(out.conv.messages).toEqual([c.messages[0], c.messages[1], c.messages[3]]);
    expect(out.conv.display).toEqual(c.display);
  });

  it('keeps an earlier answered copy of the same question when the failed turn was dropped', () => {
    const c = conv(
      [
        { role: 'user', content: 'again?' },
        { role: 'assistant', content: 'ok' },
      ],
      [
        { kind: 'user', text: 'again?' },
        { kind: 'assistant', text: 'ok' },
        { kind: 'user', text: 'again?' },
        { kind: 'error', text: 'the assistant could not answer' },
      ],
    );
    expect(rewindForRetry(c).conv.messages).toEqual(c.messages);
  });

  it('handles a first turn that failed, leaving an empty transcript', () => {
    const c = conv(
      [],
      [
        { kind: 'user', text: 'hi' },
        { kind: 'error', text: 'boom' },
      ],
    );
    const out = rewindForRetry(c);
    expect(out.text).toBe('hi');
    expect(out.conv.messages).toEqual([]);
    expect(out.conv.display).toEqual(c.display);
  });

  it('returns null when there is nothing the user said to retry', () => {
    expect(rewindForRetry(conv([], []))).toBe(null);
    expect(rewindForRetry(null)).toBe(null);
  });
});

describe('stoppedIn', () => {
  const stopped = { convId: 'c1', steps: ['Read Text 1', 'Counted 12 words'] };

  it('gives back what the stopped turn had done, in its own conversation', () => {
    expect(stoppedIn(stopped, 'c1')).toBe(stopped);
  });

  it('says nothing in another conversation', () => {
    // The panel keeps one thread per project, and the reader can switch
    // threads from its header: an unscoped list put a stopped turn's steps
    // under whatever was on screen next.
    expect(stoppedIn(stopped, 'c2')).toBeNull();
  });

  it('says nothing when nothing was stopped, or nothing is open', () => {
    expect(stoppedIn(null, 'c1')).toBeNull();
    expect(stoppedIn(stopped, null)).toBeNull();
    expect(stoppedIn({ convId: null, steps: [] }, null)).toBeNull();
  });
});

describe('rewindForRetry and attachments', () => {
  it('sends the files the message carried with it again, without storing them twice', () => {
    // The parts are already stored under this conversation; a retry that
    // dropped the references would send the question without its file.
    const files = [{ id: 'f1', name: 'wordlist.csv', bytes: 24, lines: 2, chunks: 1 }];
    const conv = {
      id: 'c1',
      messages: [],
      display: [
        { kind: 'user', text: 'count these', files },
        { kind: 'error', text: 'x' },
      ],
    };
    const r = rewindForRetry(conv);
    expect(r.text).toBe('count these');
    expect(r.files).toBe(files);
    expect(r.conv.display).toEqual(conv.display);
  });
});

// H8-ASSISTANT-4: a stop is recorded as an error item, and was then read as a
// turn that failed ("Stopped." over "That turn did not finish.").
describe('retryNote', () => {
  const user = { kind: 'user', text: 'count' };
  const stop = { kind: 'error', stopped: true, text: 'Stopped.' };

  it('says the reader stopped a stopped turn, after a reload too, and draws the stop once', () => {
    expect(retryNote([user, stop], null)).toBe('You stopped this turn.');
    expect(retryNote([user], { convId: 'c1', steps: [] })).toBe('You stopped this turn.');
    expect(hidesStopped([user, stop], 1)).toBe(true);
    expect(hidesStopped([user, stop], 0)).toBe(false);
  });

  it('says a turn that failed did not finish, and one with no answer had none', () => {
    expect(retryNote([user, { kind: 'error', text: 'x' }], null)).toBe('That turn did not finish.');
    expect(hidesStopped([user, { kind: 'error', text: 'x' }], 1)).toBe(false);
    expect(retryNote([user], null)).toBe('No answer came back for this message.');
  });
});
