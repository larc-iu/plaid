import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// What is under test is ORDER. A run writes its record, sends its request,
// reloads the document, clears the record and frees the lock, and every one of
// the bugs in this feature's history was one of those happening at the wrong
// moment: the record cleared while the service was still writing, the lock
// still held after a failure, a stop announced as a finished run. The end state
// after any of them is indistinguishable from the end state after a correct
// run, so each test asserts the committed SEQUENCE.
//
// The four `@ui` hooks are the real ones. `useServiceRequest(client)` and
// `useServiceSpot` take what they need as arguments precisely so they can be
// driven this way, and mocking them would leave nothing under test but the
// argument lists. What is faked is the client's own request surface, the same
// shape `plaid-ui/src/hooks/useServiceRequest.test.jsx` fakes (it declares it
// locally rather than exporting it, so this is a second copy of four stubs).

// Every toast, in the same order as everything else. Both notify modules (the
// package's and this app's) are one `toast` call thick, so mocking sonner
// catches what either of them says without mocking either of them.
const seq = vi.hoisted(() => []);
const toasts = vi.hoisted(() => []);
vi.mock('sonner', () => {
  const record = (kind) => (title, options) => {
    seq.push(`toast:${kind}`);
    toasts.push({ kind, title, message: options?.description });
  };
  const toast = record('info');
  toast.success = record('success');
  toast.error = record('error');
  toast.warning = record('warning');
  return { toast };
});

const { useEditorServices } = await import('./useEditorServices.js');

const PROJECT_ID = 'p1';
const DOC_ID = 'doc-1';
const RUN_KEY = `plaid_ud_run_${DOC_ID}`;
const TOKENIZE_KEY = 'plaid_ud_tokenize_service';

const parseService = (parameters = []) => ({
  serviceId: 'parse:stanza',
  serviceName: 'Stanza',
  online: true,
  extras: { tasks: ['parse'], parameters },
});

const TOKENIZE_SERVICE = {
  serviceId: 'tok:punkt',
  serviceName: 'Punkt',
  online: true,
  extras: { tasks: ['tokenize'], parameters: [] },
};

const PROJECT = { id: PROJECT_ID, config: { ud: { language: 'de' } } };

// A promise this test resolves or rejects by hand, so a request can be left in
// flight while something else happens.
const deferred = () => {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
};

// Everything the hook asks of a client, and nothing else. `answer` is called
// when the request goes out and may return a value, an Error to throw, or a
// promise to settle later.
const sent = [];
const fakeClient = ({ services = [], answer = () => ({}) } = {}) => ({
  messages: {
    discoverServices: vi.fn(async () => services),
    requestService: vi.fn(
      async (projectId, serviceId, params, timeout, _onProgress, _unused, options) => {
        sent.push({ projectId, serviceId, params, timeout, requestId: options?.requestId });
        // Read at the moment the request leaves, not afterwards: the point of
        // minting the id first is that a page reloaded in THIS window can still
        // find the run.
        seq.push('request:send');
        recordAtSend = readRecord();
        const result = await answer();
        if (result instanceof Error) throw result;
        return result;
      },
    ),
    cancelServiceRequest: vi.fn(async (projectId, requestId) => {
      seq.push(
        `cancel:${requestId === sent.at(-1)?.requestId ? 'the request in flight' : requestId}`,
      );
    }),
    attachServiceRequest: vi.fn(async () => ({})),
  },
});

const readRecord = () => {
  const raw = localStorage.getItem(RUN_KEY);
  return raw ? JSON.parse(raw) : null;
};

let recordAtSend = null;
let statusAtReload = null;
let statuses = [];
let onCancel = null;
let lockHeld = false;

const acquireWriteLock = vi.fn((label, { onCancel: cancel = null } = {}) => {
  if (lockHeld) return null;
  lockHeld = true;
  onCancel = cancel;
  seq.push(`lock:acquire(${label})`);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      lockHeld = false;
      seq.push('lock:release');
    },
    setStatus: (status) => {
      if (!released) statuses.push(status);
    },
  };
});

const makeDoc = (over = {}) => ({
  id: DOC_ID,
  layerInfo: {
    textLayer: { id: 'text-1' },
    sentenceTokenLayer: { id: 'sent-1' },
    wordTokenLayer: { id: 'word-1' },
  },
  _reload: vi.fn(async () => {
    statusAtReload = statuses.at(-1) ?? null;
    seq.push('reload');
  }),
  tokenize: vi.fn(async () => {
    seq.push('doc:tokenize');
    return true;
  }),
  ...over,
});

const mount = async ({ client, doc = makeDoc(), project = PROJECT }) => {
  const api = { current: null };
  const Probe = () => {
    api.current = useEditorServices({
      client,
      projectId: PROJECT_ID,
      doc,
      project,
      acquireWriteLock,
    });
    return null;
  };
  const view = await renderComponent(<Probe />);
  return { ...view, doc, api: () => api.current };
};

// The run record is the one thing written outside React, so the writes
// themselves are events in the sequence. happy-dom's Storage intercepts sets on
// the instance, so the patch goes on the prototype.
let restoreStorage = null;

beforeEach(() => {
  localStorage.clear();
  seq.length = 0;
  toasts.length = 0;
  sent.length = 0;
  statuses = [];
  recordAtSend = null;
  statusAtReload = null;
  onCancel = null;
  lockHeld = false;
  acquireWriteLock.mockClear();

  const proto = Object.getPrototypeOf(localStorage);
  const { setItem, removeItem } = proto;
  proto.setItem = function (key, value) {
    if (key === RUN_KEY) seq.push('record:write');
    return setItem.call(this, key, value);
  };
  proto.removeItem = function (key) {
    if (key === RUN_KEY) seq.push('record:clear');
    return removeItem.call(this, key);
  };
  restoreStorage = () => Object.assign(proto, { setItem, removeItem });
});

afterEach(() => restoreStorage?.());

describe('a parse run that finishes', () => {
  it('writes its record before the request goes out and clears it after the reload', async () => {
    const view = await mount({
      client: fakeClient({ services: [parseService()], answer: () => ({ parsedSentences: 3 }) }),
    });

    await view.step(() => view.api().parse.start());

    expect(seq).toEqual([
      'lock:acquire(Parse)',
      'record:write',
      'request:send',
      'toast:success',
      'reload',
      'record:clear',
      'lock:release',
    ]);
    // Not just written first: written with the id of the very request that
    // then went out, which is what a reloaded page rejoins.
    expect(recordAtSend.requestId).toBe(sent[0].requestId);
    expect(recordAtSend).toMatchObject({ projectId: PROJECT_ID, label: 'Parse' });
    expect(readRecord()).toBe(null);
    await view.unmount();
  });

  it('names the reload rather than leaving it as dead air', async () => {
    const view = await mount({
      client: fakeClient({ services: [parseService()], answer: () => ({ parsedSentences: 1 }) }),
    });

    await view.step(() => view.api().parse.start());

    // The banner is the only surface once the dialog is shut, so it has to be
    // told before the wait, not after it.
    expect(statusAtReload).toBe('Loading results…');
    await view.unmount();
  });

  it('warns rather than congratulates when the parser changed nothing', async () => {
    const view = await mount({
      client: fakeClient({ services: [parseService()], answer: () => ({ parsedSentences: 0 }) }),
    });

    await view.step(() => view.api().parse.start());

    expect(seq).not.toContain('toast:success');
    expect(toasts).toEqual([
      {
        kind: 'warning',
        title: 'Nothing to parse',
        message: 'The parser reported no changes to this document.',
      },
    ]);
    await view.unmount();
  });

  it('sends the fixed arguments over a service parameter of the same name', async () => {
    const schema = [
      { key: 'documentId', type: 'string', label: 'Document', default: 'the wrong document' },
      { key: 'language', type: 'string', label: 'Language' },
    ];
    const view = await mount({
      client: fakeClient({ services: [parseService(schema)], answer: () => ({}) }),
    });

    await view.step(() => view.api().parse.start());

    expect(sent[0].serviceId).toBe('parse:stanza');
    expect(sent[0].params.documentId).toBe(DOC_ID);
    // And the project's language still seeds an argument the app can answer.
    expect(sent[0].params.language).toBe('de');
    await view.unmount();
  });
});

describe('a parse run the client stopped waiting for', () => {
  it('keeps the run record, because the request did not stop with it', async () => {
    const pending = Object.assign(new Error('Nothing heard for five minutes'), { pending: true });
    const view = await mount({
      client: fakeClient({ services: [parseService()], answer: () => pending }),
    });

    await view.step(() => view.api().parse.start());

    expect(seq).toEqual([
      'lock:acquire(Parse)',
      'record:write',
      'request:send',
      'toast:warning',
      'lock:release',
    ]);
    // The service is still working and still writing. Forgetting the id here
    // is what once made a live run unrejoinable.
    expect(readRecord().requestId).toBe(sent[0].requestId);
    // And the document is not reloaded over work that has not landed.
    expect(seq).not.toContain('reload');
    await view.unmount();
  });
});

describe('a parse run that fails outright', () => {
  it('frees the lock and forgets the request', async () => {
    const view = await mount({
      client: fakeClient({
        services: [parseService()],
        answer: () => new Error('The parser broke'),
      }),
    });

    await view.step(() => view.api().parse.start());

    expect(seq).toEqual([
      'lock:acquire(Parse)',
      'record:write',
      'request:send',
      'toast:error',
      'record:clear',
      'lock:release',
    ]);
    expect(toasts).toEqual([{ kind: 'error', title: 'Parse failed', message: 'The parser broke' }]);
    expect(readRecord()).toBe(null);
    // Said once. The hook logs its own catch rather than toasting again.
    expect(toasts.filter((t) => t.kind === 'error')).toHaveLength(1);
    await view.unmount();
  });

  it('frees the lock when the reload after a success throws', async () => {
    const doc = makeDoc({
      _reload: vi.fn(async () => {
        seq.push('reload');
        throw new Error('The document could not be read back');
      }),
    });
    const view = await mount({
      client: fakeClient({ services: [parseService()], answer: () => ({ parsedSentences: 2 }) }),
      doc,
    });

    await view.step(() => view.api().parse.start());

    // The reload is inside the same try as the request, so a reload that throws
    // arrives in the run's catch. What this is about is only that the finally
    // still runs: the lock is freed and the record is forgotten, since the
    // request itself did finish. (What the user is TOLD about the failed reload
    // is a separate question, and today the answer is nothing.)
    expect(seq.at(-1)).toBe('lock:release');
    expect(seq).toContain('record:clear');
    expect(readRecord()).toBe(null);
    await view.unmount();
  });
});

describe('a run someone stopped', () => {
  it('is not announced as a finished parse', async () => {
    const view = await mount({
      client: fakeClient({ services: [parseService()], answer: () => ({ stopped: true }) }),
    });

    await view.step(() => view.api().parse.start());

    expect(seq).toEqual([
      'lock:acquire(Parse)',
      'record:write',
      'request:send',
      'toast:info',
      'reload',
      'record:clear',
      'lock:release',
    ]);
    // "Parsed. Stopped." is the contradiction this copy exists to prevent: the
    // title is the run's plain name, and the message says what is true of THIS
    // parser, whose write phase is one critical block.
    expect(toasts).toEqual([{ kind: 'info', title: 'Parse', message: 'Nothing was written.' }]);
    expect(toasts.some((t) => t.kind === 'success')).toBe(false);
    await view.unmount();
  });

  it('is not announced as a finished tokenization either', async () => {
    localStorage.setItem(TOKENIZE_KEY, 'service:tok:punkt');
    const view = await mount({
      client: fakeClient({ services: [TOKENIZE_SERVICE], answer: () => ({ stopped: true }) }),
    });

    await view.step(() => view.api().tokenize.start('some text'));

    expect(toasts).toEqual([
      {
        kind: 'info',
        title: 'Tokenize',
        message: 'Stopped. What it had already written stays.',
      },
    ]);
    await view.unmount();
  });

  it('stops the request that is actually in flight', async () => {
    const answer = deferred();
    const view = await mount({
      client: fakeClient({ services: [parseService()], answer: () => answer.promise }),
    });

    let running;
    await view.step(() => {
      running = view.api().parse.start();
    });
    expect(seq).toEqual(['lock:acquire(Parse)', 'record:write', 'request:send']);

    // The Stop the banner offers is the one the lock was handed, and a rejoined
    // run is reached the same way. It has to name the id the record names.
    await view.step(async () => {
      await onCancel();
    });
    await view.step(async () => {
      answer.resolve({ stopped: true });
      await running;
    });

    expect(seq).toEqual([
      'lock:acquire(Parse)',
      'record:write',
      'request:send',
      'cancel:the request in flight',
      'toast:info',
      'reload',
      'record:clear',
      'lock:release',
    ]);
    await view.unmount();
  });
});

describe('a second run while the first holds the document', () => {
  it('does not start, and leaves the first record where it is', async () => {
    localStorage.setItem(TOKENIZE_KEY, 'service:tok:punkt');
    const answer = deferred();
    const view = await mount({
      client: fakeClient({
        services: [parseService(), TOKENIZE_SERVICE],
        answer: () => answer.promise,
      }),
    });

    let running;
    await view.step(() => {
      running = view.api().parse.start();
    });
    const firstRecord = readRecord();

    await view.step(() => view.api().tokenize.start('some text'));

    // Nothing at all happened: no second lock, no second request, and the first
    // run's record is untouched.
    expect(seq).toEqual(['lock:acquire(Parse)', 'record:write', 'request:send']);
    expect(sent).toHaveLength(1);
    expect(readRecord()).toEqual(firstRecord);

    await view.step(async () => {
      answer.resolve({ parsedSentences: 1 });
      await running;
    });
    await view.unmount();
  });
});

describe('the built-in tokenizer', () => {
  it('takes the lock and writes no record, because it dies with this page', async () => {
    const view = await mount({ client: fakeClient({ services: [] }) });

    await view.step(() => view.api().tokenize.start('some text'));

    expect(seq).toEqual([
      'lock:acquire(Tokenize)',
      'doc:tokenize',
      'toast:success',
      'lock:release',
    ]);
    expect(readRecord()).toBe(null);
    expect(sent).toHaveLength(0);
    await view.unmount();
  });

  it('says nothing when the document refused to tokenize', async () => {
    const doc = makeDoc({
      tokenize: vi.fn(async () => {
        seq.push('doc:tokenize');
        return false;
      }),
    });
    const view = await mount({ client: fakeClient({ services: [] }), doc });

    await view.step(() => view.api().tokenize.start('some text'));

    expect(seq).toEqual(['lock:acquire(Tokenize)', 'doc:tokenize', 'lock:release']);
    expect(toasts).toEqual([]);
    await view.unmount();
  });

  it('frees the lock when the document throws', async () => {
    const doc = makeDoc({
      tokenize: vi.fn(async () => {
        seq.push('doc:tokenize');
        throw new Error('The text is not saved');
      }),
    });
    const view = await mount({ client: fakeClient({ services: [] }), doc });

    await view.step(async () => {
      await view
        .api()
        .tokenize.start('some text')
        .catch(() => {});
    });

    expect(seq).toEqual(['lock:acquire(Tokenize)', 'doc:tokenize', 'lock:release']);
    await view.unmount();
  });
});

describe('a run that cannot be made', () => {
  it('says which option is missing before taking the lock', async () => {
    const schema = [{ key: 'model', type: 'string', label: 'Model', required: true }];
    const view = await mount({
      client: fakeClient({ services: [parseService(schema)] }),
    });

    await view.step(() => view.api().parse.start());

    // Nothing was locked, nothing was written down, nothing was sent.
    expect(seq).toEqual(['toast:error']);
    expect(toasts).toEqual([
      { kind: 'error', title: 'Missing required option', message: 'Model is required' },
    ]);
    expect(acquireWriteLock).not.toHaveBeenCalled();
    expect(readRecord()).toBe(null);
    await view.unmount();
  });
});

describe('the tokenize service', () => {
  it('is told which layers to write into', async () => {
    localStorage.setItem(TOKENIZE_KEY, 'service:tok:punkt');
    const view = await mount({
      client: fakeClient({ services: [TOKENIZE_SERVICE], answer: () => ({}) }),
    });

    await view.step(() => view.api().tokenize.start('some text'));

    expect(sent[0].serviceId).toBe('tok:punkt');
    expect(sent[0].params).toMatchObject({
      documentId: DOC_ID,
      textLayerId: 'text-1',
      sentenceLayerId: 'sent-1',
      primaryTokenLayerId: 'word-1',
    });
    await view.unmount();
  });
});
