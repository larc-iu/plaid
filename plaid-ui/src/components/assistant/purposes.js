// What a conversation was started FOR, when a screen started it for something
// (subject.js `useStartConversation({purpose})`). The purpose is a short code
// the page sends with the send that creates the conversation, the service
// keeps in the record's meta and gives the app's assistant on every turn. Here
// is only what the page says of it: the row's name until the conversation has
// a title, and the line a new one shows in place of the usual invitation.
const PURPOSES = {
  'job-setup': { title: 'Job setup', empty: 'Say what the job should do.' },
};

export const JOB_SETUP = 'job-setup';

const of = (purpose) =>
  typeof purpose === 'string' && Object.hasOwn(PURPOSES, purpose) ? PURPOSES[purpose] : null;

export const purposeTitle = (purpose) => of(purpose)?.title ?? null;
export const purposeEmpty = (purpose) => of(purpose)?.empty ?? null;
