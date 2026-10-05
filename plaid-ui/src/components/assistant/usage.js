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
    const t = usageOf(item)?.total;
    return t ? sum + (t.sent || 0) + (t.received || 0) : sum;
  }, 0);

// What fraction of the window the last turn used, or null when the window is
// unknown. Clamped: a provider's count and litellm's idea of the window can
// disagree slightly, and a meter past 100% would be reporting that rather than
// the thread.
export const fullness = (usage) => {
  if (!usage || !usage.window || typeof usage.sent !== 'number') return null;
  return Math.min(1, Math.max(0, usage.sent / usage.window));
};

const thousands = (n) => (n || 0).toLocaleString('en-US');

// The tooltip: what the percentage is a percentage OF, the counts it came
// from, and what the thread has cost. The bar alone read as a share of a
// quota spent, where it is how much of what the model reads at once this
// conversation now takes.
export const usageTitle = (usage, spend) => {
  if (!usage) return null;
  const f = fullness(usage);
  const lines =
    f !== null
      ? [
          `This conversation takes up ${Math.round(f * 100)}% of what the model can read at once: ` +
            `${thousands(usage.sent)} of ${thousands(usage.window)} tokens on the last turn.`,
        ]
      : [`${thousands(usage.sent)} tokens on the last turn. This model's limit is not known.`];
  lines.push('A token is a word or a piece of one.');
  if (spend) lines.push(`${thousands(spend)} tokens over the whole conversation.`);
  return lines.join('\n');
};

// What the header shows. A percentage when the window is known, and the raw
// count when it is not, because the count is still worth seeing.
export const usageLabel = (usage) => {
  const f = fullness(usage);
  if (f !== null) return `${Math.round(f * 100)}%`;
  if (!usage || typeof usage.sent !== 'number') return null;
  const k = usage.sent / 1000;
  return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
};
