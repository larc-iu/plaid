import { notifySuccess, notifyWarning } from './notify.js';

// A finished run's notice, as the app's notice function for the run's task
// words it from the counts the service reports (the core manual, "Service
// results"): `{level, title, message, sticky?}`. Anything but a success is a
// warning, and a `sticky` one, which names what failed, stays until
// dismissed. Shared by the page that started the run (useServiceRequest) and
// the one that rejoined it after a reload (useResumedRun), so the two say the
// same thing.
export const showRunNotice = (notice) => {
  const sticky = notice?.sticky === true ? [{ duration: Infinity }] : [];
  const say = notice?.level === 'success' ? notifySuccess : notifyWarning;
  say(notice?.message || undefined, notice?.title || undefined, ...sticky);
};
