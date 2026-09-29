// What a settled plan keeps. No imports, so plaid-agent's mirror test can run
// it under plain node against the service's own `compact_plan`
// (plaid_agent/core/conversation.py, test_plan_record_mirror.py). The two must
// write the same record: the service settles applied and out-of-date plans,
// this side settles discarded ones.

// A settled plan's card without what only approving it needed: the ops and
// the documents they were checked against. The card is drawn from `changes`
// and `labels`, and the audit log records what was written. What each change
// targeted and proposed stays, as `proposed` and `proposedCount`, which the
// service wrote when it staged the plan: a discarded plan writes nothing, so
// that is the only record of what it proposed. Each entry is `[kind, target,
// value]`, or `[kind, target, value, other]` for a kind that joins two things
// (a head, an edge's target, a link's entry), kept as the service wrote it.
export const compactPlan = (item) => {
  const plan = item?.plan;
  if (!plan || item.status === null || item.status === undefined || !('ops' in plan)) return item;
  const { ops, documents: _documents, ...kept } = plan;
  return { ...item, plan: { ...kept, opCount: (ops || []).length } };
};
