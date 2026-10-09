// An assistant service for page tests: it answers the requests the page sends
// (plaid_agent/core/ops.py) against a map of stored records, as the real one
// writes them, in the page's camelCase. Only what the page tests exercise:
// send and retry (the model's answer is `answer`, or none), hold, rename,
// discard, attach, delete, approve (settled applied).
//
// `records` is the Map the fake client's `userData` reads. Each op is logged
// in `ops`, newest last, with what it was sent.

export const LEASE_MS = 5 * 60 * 1000;

const now = () => new Date().toISOString();

const answeredLast = (display) => {
  const i = display.map((d) => d.kind).lastIndexOf('user');
  return i >= 0 && display.slice(i + 1).some((d) => d.kind === 'assistant');
};

const isMessage = (m, text) =>
  m?.role === 'user' &&
  typeof m.content === 'string' &&
  (m.content === text || m.content.endsWith(`\n\n${text}`));

// As `rewind_for_retry`.
const rewound = (conv) => {
  const display = [...conv.display];
  const i = display.map((d) => d.kind).lastIndexOf('user');
  if (i < 0 || answeredLast(display)) return null;
  const asked = display[i];
  const messages = [...conv.messages];
  const last = messages.findLastIndex((m) => isMessage(m, asked.text));
  if (last >= 0 && messages.slice(last + 1).every((m) => m?.role === 'user')) {
    messages.splice(last, 1);
  }
  if (i === display.length - 1) {
    display.push({
      kind: 'error',
      lost: true,
      text: 'No answer came back for this message.',
      createdAt: now(),
    });
  }
  return { conv: { messages, display }, asked };
};

export const fakeAssistantService = (
  records,
  { app = 'igt', projectId = 'p1', answer = null, hang = false } = {},
) => {
  const keys = (pid, id) => ({
    meta: `${app}:assistant:${pid}:meta:${id}`,
    conv: `${app}:assistant:${pid}:conv:${id}`,
  });
  const ops = [];
  const fake = {
    ops,
    // Settable by a test.
    answer,
    hang,
    refuse: null,
    requestService: async (pid, sid, data, _timeout, onProgress) => {
      ops.push(data);
      const { conversationId: id, tab, op } = data;
      const k = keys(pid ?? projectId, id);
      const meta = records.get(k.meta);
      const conv = records.get(k.conv);
      const refused = (why, message) => ({ kind: 'refused', why, message, meta: meta ?? null });
      if (fake.refuse) return fake.refuse(data);
      const holdFree = () => {
        const h = meta?.holder;
        return (
          !h?.tab || h.tab === tab || Date.now() - Date.parse(h.at) > LEASE_MS || data.take === true
        );
      };
      const held = (m) => ({ ...m, holder: { tab, at: now() } });
      if (op === 'delete') {
        for (const key of [...records.keys()]) {
          if (key.startsWith(`${app}:assistant:${pid}:file:${id}:`)) records.delete(key);
        }
        records.delete(k.conv);
        records.delete(k.meta);
        return { kind: 'done', meta: null };
      }
      if (op === 'attach') {
        data.file.parts.forEach((part, n) =>
          records.set(`${app}:assistant:${pid}:file:${id}:${data.file.id}:part:${n}`, part),
        );
        return { kind: 'done', meta: meta ?? null };
      }
      if (!meta && !(op === 'send' && data.create)) {
        return refused('gone', 'This conversation was deleted.');
      }
      if (op === 'rename') {
        const m = { ...meta, title: data.title };
        records.set(k.meta, m);
        return { kind: 'done', meta: m };
      }
      if (meta && !holdFree()) return refused('held', 'This conversation is open in another tab.');
      if (op === 'hold') {
        const m = held(meta);
        records.set(k.meta, m);
        return { kind: 'done', meta: m };
      }
      if (meta?.pending?.requestId && ['send', 'retry', 'approve', 'discard'].includes(op)) {
        return meta.pending.kind === 'apply'
          ? refused('busy', 'The changes are being applied.')
          : refused('busy', 'A message is being answered.');
      }
      if (op === 'discard') {
        const i = conv.display.findIndex((d) => d.plan?.id === data.planId);
        const d = conv.display[i];
        if (d.status != null && d.status !== 'stale') {
          return refused('decided', 'This plan was already decided.');
        }
        const display = [...conv.display];
        display[i] =
          d.status === 'stale'
            ? { ...d, dismissed: true }
            : { ...d, status: 'discarded', settledAt: now() };
        const next = {
          messages:
            d.status === 'stale'
              ? conv.messages
              : [
                  ...conv.messages,
                  {
                    role: 'user',
                    content: '(note) The user discarded the plan; nothing was changed.',
                  },
                ],
          display,
        };
        records.set(k.conv, next);
        const m = held({ ...meta, updatedAt: now() });
        records.set(k.meta, m);
        return { kind: 'done', meta: m };
      }
      if (op === 'approve') {
        const display = conv.display.map((d) =>
          d.plan?.id === data.planId ? { ...d, status: 'applied', settledAt: now() } : d,
        );
        records.set(k.conv, { ...conv, display });
        records.set(k.meta, held({ ...meta, updatedAt: now(), pending: null }));
        return { kind: 'applied', applied: 1, counts: [], message: 'Applied.' };
      }
      // send, retry
      let base = conv ?? { messages: [], display: [] };
      let item;
      if (op === 'retry') {
        const r = rewound(base);
        if (!r) return refused('answered', 'That message has an answer.');
        base = r.conv;
        item = { ...r.asked, retry: true, createdAt: now() };
      } else {
        item = {
          kind: 'user',
          text: data.text,
          createdAt: now(),
          ...(data.where ? { where: data.where } : {}),
          ...(data.files?.length ? { files: data.files } : {}),
          ...(data.projects?.length ? { projects: data.projects } : {}),
        };
      }
      const asked = {
        messages: [...base.messages, { role: 'user', content: item.text }],
        display: [...base.display, item],
      };
      records.set(k.conv, asked);
      const marked = held({
        id,
        title: meta?.title || item.text,
        createdAt: meta?.createdAt || now(),
        ...(meta || {}),
        updatedAt: now(),
        turns: asked.display.filter((d) => d.kind === 'user').length,
        serviceId: meta?.serviceId || sid,
        pending: { kind: 'turn', requestId: `req-${ops.length}`, serviceId: sid, startedAt: now() },
      });
      records.set(k.meta, marked);
      onProgress?.({ percent: 2, message: 'Thinking…', recorded: true });
      if (fake.hang) return new Promise(() => {});
      const said = fake.answer;
      records.set(
        k.conv,
        said == null
          ? asked
          : {
              messages: [...asked.messages, { role: 'assistant', content: said }],
              display: [...asked.display, { kind: 'assistant', text: said, createdAt: now() }],
            },
      );
      records.set(k.meta, { ...records.get(k.meta), pending: null, updatedAt: now() });
      return { kind: 'turn', message: said ?? '' };
    },
  };
  return fake;
};
