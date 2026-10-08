// What a settled plan keeps. No imports, so plaid-agent's mirror test can run
// it under plain node against the service's own `compact_plan`
// (plaid_agent/core/conversation.py, test_plan_record_mirror.py). The two must
// write the same record: the service settles applied and out-of-date plans,
// this side settles discarded ones.

// How many of a settled plan's rows the record keeps. A plan of thousands of
// changes kept its whole card once settled, about half a kilobyte a row, and a
// conversation of a few such plans filled the record (5MB) with cards nobody
// can approve any more. The rest of the plan is in the audit log when it was
// applied, and in `proposed` either way.
export const SETTLED_ROWS_MAX = 200;

// A settled plan's card without what only approving it needed: the ops, the
// documents they were checked against, and what its corpus-wide changes found
// while an approval ran (`expansion`). The card is drawn from `changes`
// and `labels`, of which the first SETTLED_ROWS_MAX stay, and `omitted` says
// what the rest held: how many rows, and of those how many rewrote the text
// and how many replaced a person's work, the counts the card states. The
// audit log records what was written. What each change
// targeted and proposed stays, as `proposed` and `proposedCount`, which the
// service wrote when it staged the plan: a discarded plan writes nothing, so
// that is the only record of what it proposed. Each entry is `[kind, target,
// value]`, or `[kind, target, value, other]` for a kind that joins two things
// (a head, an edge's target, a link's entry), kept as the service wrote it.
//
// Both writers run this over every settled plan each time they write the
// record, and it answers the same item when there is nothing to drop, so a
// record written before the cap shrinks on its next write.
export const compactPlan = (item) => {
  const plan = item?.plan;
  if (!plan || item.status === null || item.status === undefined) return item;
  const changes = Array.isArray(plan.changes) ? plan.changes : [];
  const labels = Array.isArray(plan.labels) ? plan.labels : [];
  const rows = Math.max(changes.length, labels.length);
  if (!('ops' in plan) && !('expansion' in plan) && rows <= SETTLED_ROWS_MAX) return item;
  const { ops, documents: _documents, expansion: _expansion, ...kept } = plan;
  if ('ops' in plan) kept.opCount = (ops || []).length;
  if (rows > SETTLED_ROWS_MAX) {
    const dropped = changes.slice(SETTLED_ROWS_MAX);
    if ('changes' in plan) kept.changes = changes.slice(0, SETTLED_ROWS_MAX);
    if ('labels' in plan) kept.labels = labels.slice(0, SETTLED_ROWS_MAX);
    kept.omitted = {
      count: rows - SETTLED_ROWS_MAX,
      writesText: dropped.filter((c) => c?.writesText).length,
      replacesWork: dropped.reduce((n, c) => n + (Number(c?.replacesWork) || 0), 0),
    };
  }
  return { ...item, plan: kept };
};
