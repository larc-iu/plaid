// When a conversation item was written, as the record keeps it on every item
// (`createdAt`): UTC to the millisecond with a Z, the string the service's
// `now_iso` writes (plaid_agent/core/conversation.py). No imports, so
// plaid-agent's mirror test runs it under plain node against `now_iso`.
export const itemTime = (at = new Date()) => at.toISOString();
