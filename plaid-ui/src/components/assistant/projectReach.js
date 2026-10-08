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

// What "Add project" offers: every project the reader can open that the
// assistant can read too, less the home one and those already added, as
// {id, name}. `opens(project)` is the app adapter's `opensProject`, which
// says whether a project is set up for that app. A project that is not was
// offered, and then reported as "could not be opened" with no reason.
export const projectCandidates = (projects, homeId, joined = [], opens = null) => {
  const taken = new Set([homeId, ...joined.map((p) => p.id)]);
  return (projects || [])
    .filter((p) => p?.id && !taken.has(p.id) && (!opens || opens(p)))
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
// throughout says so once. A set that emptied is marked too, since that message
// read its home project only, and the assistant is told as much. A thread that
// never added a project marks nothing.
export const reachChanged = (display, i) => {
  const item = display?.[i];
  if (item?.kind !== 'user') return false;
  const here = setKey(item.projects);
  for (let k = i - 1; k >= 0; k--) {
    if (display[k].kind === 'user') return setKey(display[k].projects) !== here;
  }
  return here !== '';
};

// The line on a message, and in the export: the other projects it reads, or,
// where the reader removed them all, its home project alone.
export const withProjects = (projects) => `With ${projects.map((p) => p.name || p.id).join(', ')}`;
export const homeOnly = (homeName) => `${homeName || 'This project'} only`;

// Why a project was refused: the assistant answering does not run there.
export const notServedThere = (serviceName, name) =>
  `${serviceName || 'The assistant'} is not running in ${name}.`;

// The line under a reply for projects the assistant could not read.
export const couldNotOpen = (projects) =>
  projects.map((p) => `${p.name || p.id} could not be opened.`).join(' ');

// The name each other project had as of the message at `i`: the latest one a
// message up to there carried. A later rename leaves an earlier turn alone.
export const projectNamesAt = (display, i) => {
  const names = new Map();
  const end = Math.min(i, (display?.length ?? 0) - 1);
  for (let k = 0; k <= end; k++) {
    if (display[k].kind !== 'user') continue;
    for (const p of display[k].projects || []) if (p?.id) names.set(p.id, p.name || p.id);
  }
  return names;
};

// Unicode isolates around a name, so a right-to-left project name and the
// document name after it are not read as one run.
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);

// A citation into another project, named with that project where the
// document is ("Lamkang B: Text 1, sentence 3"): two projects may each hold a
// "Text 1". Every app titles a citation from `documentName`, so the card, the
// link and the export all say it. A citation into the home project, or into
// one no message named, is left exactly as it was.
export const namedCitations = (citations, homeId, names) => {
  if (!citations?.length || !names?.size) return citations;
  return citations.map((c) => {
    const name = c?.projectId && c.projectId !== homeId ? names.get(c.projectId) : null;
    return name ? { ...c, documentName: `${FSI}${name}${PDI}: ${c.documentName ?? ''}` } : c;
  });
};

// The accessible name of each chip's remove button. Two projects may share a
// name, and two buttons both called "Remove Lamkang" cannot be told apart, so
// only where names collide each is numbered in the order the chips show.
export const chipRemoveLabels = (projects) => {
  const count = new Map();
  for (const p of projects || []) count.set(p.name, (count.get(p.name) ?? 0) + 1);
  const seen = new Map();
  return (projects || []).map((p) => {
    if (count.get(p.name) < 2) return `Remove ${p.name}`;
    const n = (seen.get(p.name) ?? 0) + 1;
    seen.set(p.name, n);
    return `Remove ${p.name} (${n})`;
  });
};

// The project a plan on the reply at `i` writes in, named only where the
// conversation reads other projects: the plan record says so (`project`, set
// by a turn that read others).
export const planProjectAt = (display, i) => display?.[i]?.plan?.project?.name || null;
