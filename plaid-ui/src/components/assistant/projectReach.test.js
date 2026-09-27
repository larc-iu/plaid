import { describe, it, expect } from 'vitest';
import {
  atProjectCap,
  couldNotOpen,
  lastProjects,
  projectCandidates,
  projectsToSend,
  reachChanged,
  servedThere,
  withProjects,
} from './projectReach.js';
import { rewindForRetry } from './resume.js';
import { linkifyCitations } from './citations.js';
import { conversationToMarkdown } from './exportMarkdown.js';

// A conversation reads its home project and whichever others the reader added.
// The set rides on each user message, and the service reads it off the last one.

const B = { id: 'pB', name: 'Lamkang B' };
const C = { id: 'pC', name: 'Lamkang C' };
const user = (projects, text = 'q') => ({ kind: 'user', text, ...(projects ? { projects } : {}) });
const reply = { kind: 'assistant', text: 'a' };

describe('projectCandidates', () => {
  it('offers every project but the home one and those already added', () => {
    const all = [{ id: 'pA', name: 'Lamkang A' }, B, C, { id: 'pD', name: 'Other' }];
    expect(projectCandidates(all, 'pA', [B]).map((p) => p.id)).toEqual(['pC', 'pD']);
  });

  it('offers nothing before the projects are read', () => {
    expect(projectCandidates(null, 'pA', [])).toEqual([]);
  });
});

describe('atProjectCap', () => {
  // The number the assistant advertises counts the home project.
  it('is full at four others when the assistant reads five', () => {
    expect(atProjectCap([B, C, { id: 'd' }], 5)).toBe(false);
    expect(atProjectCap([B, C, { id: 'd' }, { id: 'e' }], 5)).toBe(true);
  });

  it('never caps an assistant that names no number', () => {
    expect(atProjectCap([B, C], null)).toBe(false);
  });
});

describe('servedThere', () => {
  const same = { serviceId: 'igt:assist:one', online: true };
  it('joins where the same assistant is online', () => {
    expect(servedThere([same], 'igt:assist:one')).toBe(true);
  });

  it('refuses where that assistant is offline', () => {
    expect(servedThere([{ ...same, online: false }], 'igt:assist:one')).toBe(false);
  });

  it('refuses where only a different assistant runs', () => {
    expect(servedThere([{ serviceId: 'igt:assist:two', online: true }], 'igt:assist:one')).toBe(
      false,
    );
  });

  it('refuses where discovery found nothing', () => {
    expect(servedThere([], 'igt:assist:one')).toBe(false);
    expect(servedThere(null, 'igt:assist:one')).toBe(false);
  });
});

describe('projectsToSend', () => {
  it('writes the others once each and never the home project', () => {
    expect(projectsToSend([B, { id: 'pA', name: 'Home' }, B, C], 'pA')).toEqual([B, C]);
  });

  it('keeps only the id and the name', () => {
    expect(projectsToSend([{ ...B, extra: 1 }], 'pA')).toEqual([B]);
  });
});

describe('lastProjects', () => {
  it('reads the set off the last user message', () => {
    expect(lastProjects([user([B]), reply, user([B, C]), reply])).toEqual([B, C]);
  });

  it('is empty when the last message carried none, whatever came before', () => {
    expect(lastProjects([user([B]), reply, user(null), reply])).toEqual([]);
  });

  it('is empty for a new conversation', () => {
    expect(lastProjects([])).toEqual([]);
    expect(lastProjects(undefined)).toEqual([]);
  });
});

describe('reachChanged', () => {
  it('marks the first message that reads another project', () => {
    expect(reachChanged([user([B])], 0)).toBe(true);
  });

  it('does not mark a message that reads the same set, in any order', () => {
    const display = [user([B, C]), reply, user([C, B])];
    expect(reachChanged(display, 2)).toBe(false);
  });

  it('marks a message whose set grew', () => {
    const display = [user([B]), reply, user([B, C])];
    expect(reachChanged(display, 2)).toBe(true);
  });

  it('marks a set that comes back after a message without one', () => {
    const display = [user([B]), reply, user(null), reply, user([B])];
    expect(reachChanged(display, 4)).toBe(true);
  });

  it('marks nothing on a message that reads its home project only', () => {
    expect(reachChanged([user([B]), reply, user(null)], 2)).toBe(false);
    expect(reachChanged([user(null)], 0)).toBe(false);
  });

  it('marks nothing on a reply', () => {
    expect(reachChanged([user([B]), reply], 1)).toBe(false);
  });
});

describe('the words', () => {
  it('names the projects a message reads', () => {
    expect(withProjects([B, C])).toBe('With Lamkang B, Lamkang C');
  });

  it('names each project that could not be read', () => {
    expect(couldNotOpen([C])).toBe('Lamkang C could not be opened.');
  });
});

describe('rewindForRetry', () => {
  // The service reads the set off the last user message only, so a retry that
  // dropped it would read the home project alone, and say nothing.
  it('carries the message’s own projects', () => {
    const out = rewindForRetry({
      id: 'c1',
      messages: [],
      display: [user([B], 'compare'), { kind: 'error', text: 'boom' }],
    });
    expect(out.projects).toEqual([B]);
  });

  it('carries none for a message that had none', () => {
    const out = rewindForRetry({ id: 'c1', messages: [], display: [user(null)] });
    expect(out.projects).toEqual([]);
  });
});

// The smallest adapter a citation link reads.
const adapter = {
  CITE_RE: /\{\{[^}]+\}\}/g,
  citationTitle: (c) => c.title,
  citationHref: (origin, projectId, c) => `${origin}/p/${projectId}/${c.documentId}`,
  citationToMarkdown: (c, { origin, projectId }) => `CARD ${origin}/p/${projectId}/${c.documentId}`,
};

describe('a citation into another project', () => {
  const home = { key: '{{here}}', title: 'Here', documentId: 'd1' };
  const there = { key: '{{there}}', title: 'There', documentId: 'd9', projectId: 'pB' };
  const byKey = new Map([
    [home.key, home],
    [there.key, there],
  ]);

  it('links into the project it names, and a home one into home', () => {
    const md = linkifyCitations(adapter, '{{here}} and {{there}}', byKey, {
      origin: 'o',
      projectId: 'pA',
    });
    expect(md).toContain('(o/p/pA/d1)');
    expect(md).toContain('(o/p/pB/d9)');
  });

  it('exports its card linked into that project', () => {
    const conv = {
      display: [
        user([B]),
        { kind: 'assistant', text: 'Compare\n{{there}}\nand {{here}}', citations: [home, there] },
      ],
    };
    const md = conversationToMarkdown(conv, null, { origin: 'o', projectId: 'pA', adapter });
    expect(md).toContain('CARD o/p/pB/d9');
    expect(md).toContain('CARD o/p/pA/d1');
  });
});

describe('the export', () => {
  const ctx = { origin: '', projectId: 'pA', adapter };

  it('names the projects where the set changed, and only there', () => {
    const conv = { display: [user([B], 'one'), reply, user([B], 'two'), reply, user([B, C])] };
    const md = conversationToMarkdown(conv, null, ctx);
    expect(md.match(/\*With Lamkang B\*/g)).toHaveLength(1);
    expect(md).toContain('*With Lamkang B, Lamkang C*');
  });

  it('says which projects a reply could not read', () => {
    const conv = { display: [user([B, C]), { ...reply, unavailableProjects: [C] }] };
    expect(conversationToMarkdown(conv, null, ctx)).toContain('*Lamkang C could not be opened.*');
  });

  // A project is named by whoever made it, so a name can end a link's label,
  // start a link of its own, or break the line into a heading.
  it('writes a project name as one line of literal text', () => {
    const odd = { id: 'x', name: 'B](javascript:alert(1))\n# Heading' };
    const conv = {
      display: [user([odd]), { ...reply, unavailableProjects: [odd] }],
    };
    const md = conversationToMarkdown(conv, null, ctx);
    const escaped = 'B\\]\\(javascript:alert\\(1)) \\# Heading';
    expect(md).toContain(`*With ${escaped}*`);
    expect(md).toContain(`*${escaped} could not be opened.*`);
    expect(md).not.toMatch(/^# Heading/m);
    expect(md).not.toContain('](javascript');
  });

  it('escapes a project name', () => {
    const conv = { display: [user([{ id: 'x', name: 'a*b [c]' }])] };
    expect(conversationToMarkdown(conv, null, ctx)).toContain('*With a\\*b \\[c\\]*');
  });
});
