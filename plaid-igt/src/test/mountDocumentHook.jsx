import { useEffect, useRef } from 'react';
import { vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../components/documents/contexts/DocumentContext.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// Mounting one of the document editor's hooks on its own.
//
// These hooks are not pure. They read the shared IgtDocument out of
// DocumentContext, ask for confirmation through ConfirmProvider, reach the
// server through a client, and hand their refs to nodes the tab renders.
// Reaching one of them by mounting the tab costs a router, a real document and
// five plaid-ui hooks, which is why two of them had no test at all.
//
// What this gives a test instead is the hook under the providers it needs,
// a fake for each thing it reaches out to, and the SEQUENCE of values it
// committed rather than the one it ended on. That last part is the point: an
// effect that heals itself after a stale write looks correct from the end
// state, and does not look correct from the list of what was on screen.

const NOTHING = Symbol('nothing');

// Two tracked values are the same when their own keys are. One level is
// enough: what a tracker returns is a handful of the hook's fields.
const same = (a, b) => {
  if (Object.is(a, b)) return true;
  if (a === NOTHING || b === NOTHING) return false;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.is(a[k], b[k]));
};

/**
 * A stand-in for the IgtDocument the media tab drives. Every mutation is a spy
 * that succeeds, so a test asserts what was ASKED for rather than what a real
 * document would have done with it (that is IgtDocument's own test).
 */
export const fakeDocument = (over = {}) => {
  const { document: doc, project, layerInfo, ...rest } = over;
  return {
    alignmentTokens: [],
    storedMetadata: {},
    body: '',
    isSaving: false,
    knownSpeakers: [],
    mergeMetadata: vi.fn(async () => true),
    uploadMedia: vi.fn(async () => true),
    deleteMedia: vi.fn(async () => true),
    saveBaselineText: vi.fn(async () => true),
    deleteAlignment: vi.fn(async () => true),
    updateAlignmentBounds: vi.fn(async () => true),
    _reload: vi.fn(async () => {}),
    subscribe: () => () => {},
    getSnapshot: () => 0,
    ...rest,
    document: { id: 'doc-1', name: 'Test Doc', mediaUrl: null, ...doc },
    project: { id: 'proj-1', name: 'Test Project', config: {}, ...project },
    layerInfo: {
      primaryTextLayer: { id: 'tl-1' },
      alignmentTokenLayer: { id: 'alignL' },
      sentenceTokenLayer: { id: 'sentL' },
      ...layerInfo,
    },
  };
};

/**
 * A stand-in for the plaid client. Only the service channel is reachable from
 * the media tab; everything a hook there calls goes through `messages`.
 */
export const fakeClient = (over = {}) => ({
  withOperation: async (_label, fn) => fn(),
  ...over,
  messages: {
    discoverServices: vi.fn(async () => []),
    requestService: vi.fn(async () => ({})),
    attachServiceRequest: vi.fn(async () => ({})),
    cancelServiceRequest: vi.fn(async () => true),
    ...(over.messages ?? {}),
  },
});

/**
 * A write lock that behaves like the document editor's: one holder at a time,
 * and a refusal is a null rather than a throw.
 */
export const fakeWriteLock = () => {
  const state = { held: null, granted: [] };
  const acquire = vi.fn((label, options = {}) => {
    if (state.held) return null;
    const lock = {
      label,
      options,
      status: null,
      setStatus: vi.fn((s) => {
        lock.status = s;
      }),
      release: vi.fn(() => {
        if (state.held === lock) state.held = null;
      }),
    };
    state.held = lock;
    state.granted.push(lock);
    return lock;
  });
  return { acquire, state };
};

/**
 * Mount `hook` under the document editor's providers.
 *
 * @param {Function} hook           the hook to run
 * @param {Object}   [opts.doc]     the document in context (fakeDocument() by default)
 * @param {Object}   [opts.ctx]     the rest of the DocumentContext value
 * @param {Array}    [opts.args]    arguments handed to the hook
 * @param {Function} [opts.track]   `(api) => value`, recorded on every commit
 *                                  whose value differs from the one before it
 * @param {Function} [opts.render]  `(api) => ReactNode`, for a hook that hands
 *                                  its refs to DOM nodes
 * @returns {Promise<Object>} `{ api, seq, container, step, setInputs, unmount }`
 */
export async function mountDocumentHook(hook, opts = {}) {
  const { track = null, render = null } = opts;
  const seq = [];
  let api = null;

  let inputs = {
    doc: opts.doc ?? fakeDocument(),
    ctx: opts.ctx ?? {},
    args: opts.args ?? [],
  };

  function Probe({ doc, ctx, args }) {
    void doc;
    void ctx;
    const value = hook(...args);
    api = value;
    const last = useRef(NOTHING);
    // Registered after the hook's own effects, so it sees the value React
    // committed for this render rather than what an effect went on to change.
    useEffect(() => {
      if (!track) return;
      const next = track(value);
      if (same(last.current, next)) return;
      last.current = next;
      seq.push(next);
    });
    return render ? render(value) : null;
  }

  const tree = (next) => (
    <ConfirmProvider>
      <DocumentProvider value={{ canWrite: true, readOnly: false, ...next.ctx, doc: next.doc }}>
        <Probe doc={next.doc} ctx={next.ctx} args={next.args} />
      </DocumentProvider>
    </ConfirmProvider>
  );

  const mounted = await renderComponent(tree(inputs));

  return {
    get api() {
      return api;
    },
    seq,
    container: mounted.container,
    step: mounted.step,
    /** Re-render with a new document, context or arguments. */
    async setInputs(next) {
      inputs = { ...inputs, ...next };
      await mounted.rerender(tree(inputs));
    },
    unmount: mounted.unmount,
  };
}
