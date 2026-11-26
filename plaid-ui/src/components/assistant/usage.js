// How full a conversation is, and what it has cost.
//
// The service records what each turn sent and got back, against the model's
// own limit (plaid_agent/core/agent.py). Two different questions come out of
// those numbers and only one of them predicts a failure:
//
//   fullness  what the LAST turn sent, against the window. A turn's prompt is
//             the whole thread plus its tool results, so this is the number
//             that says whether another turn still fits.
//   spend     the sum over turns of everything sent and received. Each turn
//             re-sends the thread, so the same message is paid for again every
//             turn, and that is why this is much larger than the transcript.
//
// A provider that reports no counts, or a model whose window nobody knows,
// leaves these undefined. Nothing here fills that in: a guessed denominator
// shown where a measurement goes reads as a measurement.

import { t } from '../../lib/i18n.js';

// A conversation nearly at its limit is worth saying out loud, because the
// failure it is heading for is a turn that will not run at all.
export const NEARLY_FULL = 0.85;

const usageOf = (item) => (item && item.kind === 'assistant' ? item.usage : null);

// The newest reply's usage, which is the current state of the thread.
export const latestUsage = (display) => {
  for (let i = (display || []).length - 1; i >= 0; i--) {
    const u = usageOf(display[i]);
    if (u && typeof u.sent === 'number') return u;
  }
  return null;
};

// Everything this conversation has sent and been sent, added up over its
// turns. A turn's `total` is every model call it made, where `sent` and
// `received` beside it are only the last call's.
export const totalSpend = (display) =>
  (display || []).reduce((sum, item) => {
    const total = usageOf(item)?.total;
    return total ? sum + (total.sent || 0) + (total.received || 0) : sum;
  }, 0);

// What fraction of the window the last turn used, or null when the window is
// unknown. Clamped: a provider's count and litellm's idea of the window can
// disagree slightly, and a meter past 100% would be reporting that rather than
// the thread.
export const fullness = (usage) => {
  if (!usage || !usage.window || typeof usage.sent !== 'number') return null;
  return Math.min(1, Math.max(0, usage.sent / usage.window));
};

const spent = (spend) => t('{n, number} tokens over the whole conversation.', { n: spend || 0 });

// The tooltip: what the percentage is a percentage OF, the counts it came
// from, and what the thread has cost. The bar alone read as a share of a
// quota spent, where it is how much of what the model reads at once this
// conversation now takes.
export const usageTitle = (usage, spend) => {
  if (!usage) return null;
  const f = fullness(usage);
  // Past the window the percentage is clamped, so the sentence says so.
  const counts = { sent: usage.sent || 0, window: usage.window || 0 };
  const lines =
    f !== null
      ? [
          usage.sent > usage.window
            ? t(
                "In this conversation, you have used more than all of this model's available context length ({sent, number}/{window, number} tokens).",
                counts,
              )
            : t(
                "In this conversation, you have used {pct}% of this model's available context length ({sent, number}/{window, number} tokens).",
                { ...counts, pct: Math.round(f * 100) },
              ),
        ]
      : [
          t("{n, number} tokens on the last turn. This model's limit is not known.", {
            n: usage.sent || 0,
          }),
        ];
  if (spend) lines.push(spent(spend));
  return lines.join('\n');
};

// What the header shows. A percentage when the window is known, and the raw
// count when it is not, because the count is still worth seeing.
export const usageLabel = (usage) => {
  const f = fullness(usage);
  if (f !== null) return t('{pct}%', { pct: Math.round(f * 100) });
  if (!usage || typeof usage.sent !== 'number') return null;
  const k = usage.sent / 1000;
  return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
};

// The stored record is the second limit. The server refuses a value past its
// cap (`userDataValueBytes` in /info), and a conversation can reach it with
// the model's window nearly empty: plan cards and citations weigh on the
// record and not on the next prompt. So the meter shows whichever of the two
// is fuller.

// The room a message needs in the record: its text twice (the transcript and
// the display) and the item around it. A record with less than this left
// cannot take the next message, so it is full.
export const MESSAGE_ROOM = 16 * 1024;

// What share of the cap the record takes, unclamped, or null when either
// number is unknown.
export const recordShare = (record) => {
  if (!record || !Number.isFinite(record.bytes) || !(record.cap > 0)) return null;
  return Math.max(0, record.bytes / record.cap);
};

// Both limits, and which one the meter shows: the fuller one. `share` is
// clamped for drawing, and `full` is a record that cannot take a message.
export const gauge = (usage, record) => {
  const context = fullness(usage);
  const storage = recordShare(record);
  const which =
    storage !== null && (context === null || storage > context)
      ? 'storage'
      : context !== null
        ? 'context'
        : null;
  const share = which === 'storage' ? Math.min(1, storage) : context;
  return {
    usage,
    record: storage === null ? null : record,
    context,
    storage,
    which,
    share,
    nearlyFull: share !== null && share >= NEARLY_FULL,
    full: storage !== null && record.bytes + MESSAGE_ROOM >= record.cap,
  };
};

// A size in the unit that reads: KB below a megabyte, so a small record is
// never "0 MB".
const size = (n) => {
  if (n < 1048576) return t('{n} KB', { n: n > 0 ? Math.max(1, Math.round(n / 1024)) : 0 });
  const mb = n / 1048576;
  return t('{n} MB', { n: mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10 });
};

// The storage line of the tooltip, in the context line's words.
const storageLine = (record) => {
  const s = recordShare(record);
  if (s === null) return null;
  const sizes = { used: size(record.bytes), cap: size(record.cap) };
  return s > 1
    ? t(
        'In this conversation, you have used more than all of the available storage ({used}/{cap}).',
        sizes,
      )
    : t('In this conversation, you have used {pct}% of the available storage ({used}/{cap}).', {
        ...sizes,
        pct: Math.round(Math.min(1, s) * 100),
      });
};

// The meter's tooltip with both limits, the one the bar shows first.
export const gaugeTitle = (g, spend) => {
  if (!g) return null;
  const context = usageTitle(g.usage, spend);
  const storage = g.record ? storageLine(g.record) : null;
  if (!storage) return context;
  const lines = [...(g.which === 'storage' || !context ? [storage, context] : [context, storage])];
  if (!context && spend) lines.push(spent(spend));
  return lines.filter(Boolean).join('\n');
};

// The header label: the shown limit's percentage, or the token count when
// neither limit is known.
export const gaugeLabel = (g) => {
  if (!g) return null;
  if (g.share !== null) return t('{pct}%', { pct: Math.round(g.share * 100) });
  return usageLabel(g.usage);
};
