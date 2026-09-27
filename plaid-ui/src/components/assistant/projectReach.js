// The other projects a conversation reads, beside the one it lives in.
//
// A conversation has one home project, the one it is filed under. The reader
// may add a few more, and the assistant then reads those as well, with the
// reader's own rights in each. The set rides on each user message as
// `projects: [{id, name}]` (the OTHER projects only, and only when there are
// any), the way `files` does, and the service reads it off the last one. So the
// record is the whole story: opening a conversation picks the set up from its
// last message, and nothing about it is kept anywhere else.
//
// Pure, so it is tested as arithmetic. The chips and the picker are
// ProjectChips.jsx.

// The set the conversation's last message carried, which is the set the next
// one carries unless the reader changes it.
export const lastProjects = (display) => {
  for (let k = (display?.length ?? 0) - 1; k >= 0; k--) {
    if (display[k].kind === 'user') return display[k].projects || [];
  }
  return [];
};

// What "Add project" offers: every project the reader can open, less the home
// one and those already added, as {id, name}.
export const projectCandidates = (projects, homeId, joined = []) => {
  const taken = new Set([homeId, ...joined.map((p) => p.id)]);
  return (projects || [])
    .filter((p) => p?.id && !taken.has(p.id))
    .map((p) => ({ id: p.id, name: p.name || p.id }));
};

// Whether no more can be added. `max` is what the assistant advertises, and it
// counts the home project.
export const atProjectCap = (joined, max) => !!max && (joined?.length ?? 0) + 1 >= max;

// Whether a project's discovery answer lists the SAME assistant, online. A
// project joins only where the assistant answering this conversation also runs:
// the operator chose which projects' text that model may see.
export const servedThere = (found, serviceId) =>
  !!serviceId && (found || []).some((s) => s?.serviceId === serviceId && s.online !== false);

// The set as written on a message: the others, never the home project, each
// once, and nothing at all when there are none.
export const projectsToSend = (joined, homeId) => {
  const seen = new Set([homeId]);
  const out = [];
  for (const p of joined || []) {
    if (!p?.id || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, name: p.name || p.id });
  }
  return out;
};

const setKey = (projects) =>
  (projects || [])
    .map((p) => p.id)
    .sort()
    .join('\n');

// Whether the message at `i` reads a different set of other projects from the
// message before it. Marked only where it changed, the rule `movedHere` follows
// for the place a question was asked from: a thread that kept the same projects
// throughout says so once. A set that emptied is not marked: there is no
// project left to name.
export const reachChanged = (display, i) => {
  const item = display?.[i];
  if (item?.kind !== 'user' || !item.projects?.length) return false;
  const here = setKey(item.projects);
  for (let k = i - 1; k >= 0; k--) {
    if (display[k].kind === 'user') return setKey(display[k].projects) !== here;
  }
  return true;
};

// The line on a message, and in the export.
export const withProjects = (projects) => `With ${projects.map((p) => p.name || p.id).join(', ')}`;

// Why a pick was refused.
export const notServedThere = (name) => `The assistant is not available in ${name}.`;

// The line under a reply for projects the assistant could not read.
export const couldNotOpen = (projects) =>
  projects.map((p) => `${p.name || p.id} could not be opened.`).join(' ');
