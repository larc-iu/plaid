"""The Plaid IGT user guide, for "how do I ..." questions (survey item 16,
ec2aac2c). Opt-in, as the tagsets tool's help is (feedback_rare_tools_opt_in):
one short schema, and the guide itself only when the model asks for a part of
it.

The guide is the app's own, ``plaid-igt/docs/igt-guide.adoc``, read as it
stands where the package runs from a checkout of the repository. A copy
travels in the package (``igt-guide.adoc`` beside this module) for an install
without the app's sources; ``bb sample-prompts`` refreshes it.
"""

import re
from pathlib import Path
from typing import List, Optional, Tuple

from ..core.tools import ToolError

#: The guide in the repository, from src/plaid_agent/igt/.
REPO_GUIDE = Path(__file__).resolve().parents[4] / 'plaid-igt' / 'docs' / 'igt-guide.adoc'
#: The copy in the package.
PACKAGED_GUIDE = Path(__file__).with_name('igt-guide.adoc')
#: The most characters one answer carries; a longer chapter lists its sections.
MAX_CHARS = 12000

_HEADING = re.compile(r'^(=+)\s+(.+?)\s*$')


class Section:
    def __init__(self, level: int, title: str, parent: Optional['Section']):
        self.level, self.title, self.parent = level, title, parent
        self.lines: List[str] = []
        self.children: List['Section'] = []

    @property
    def path(self) -> str:
        return (f'{self.parent.path} > ' if self.parent is not None and self.parent.level else '') + self.title

    def text(self) -> str:
        """Its own text and every section under it, as the guide has it."""
        out = [f'{"#" * self.level} {self.title}', *self.lines]
        for c in self.children:
            out += ['', c.text()]
        return '\n'.join(out).strip()


def guide_source() -> str:
    for path in (REPO_GUIDE, PACKAGED_GUIDE):
        if path.is_file():
            return path.read_text(encoding='utf-8')
    raise ToolError('The app guide is not installed with this assistant.')


def _clean(line: str) -> str:
    """A line of AsciiDoc as a reader sees it: links and cross references by
    their text, key names bare."""
    line = re.sub(r'kbd:\[([^\]]*)\]', r'\1', line)
    line = re.sub(r'<<[^,>]+,\s*([^>]+)>>', r'\1', line)
    line = re.sub(r'<<([^>]+)>>', r'\1', line)
    line = re.sub(r'(?:xref|link):\S*?\[([^\]]*)\]', r'\1', line)
    line = re.sub(r'https?://\S+?\[([^\]]+)\]', r'\1', line)
    return line


def parse(source: str) -> Section:
    """The guide as a tree of sections under a root. The document header
    (attributes, the style block) and comments are left out."""
    root = Section(0, 'Plaid IGT Guide', None)
    at = root
    skipping = False
    started = False
    for raw in source.splitlines():
        line = raw.rstrip()
        if line == '++++':
            skipping = not skipping
            continue
        if skipping or line.startswith('//') or re.match(r'^\[\[.*\]\]$', line) or re.match(r'^:\w[\w-]*:', line):
            continue
        m = _HEADING.match(line)
        if m:
            level = len(m.group(1))
            if not started:
                started = True  # the document title
                continue
            while at.level >= level and at.parent is not None:
                at = at.parent
            s = Section(level, _clean(m.group(2)), at)
            at.children.append(s)
            at = s
            continue
        if started and at is not root:
            at.lines.append(_clean(line))
    return root


def _walk(s: Section):
    for c in s.children:
        yield c
        yield from _walk(c)


def outline(root: Section) -> str:
    lines = ['The Plaid IGT user guide. Ask for a part with topic (a section\'s name). The steps are the user\'s '
             'to take in the app: say them as the guide does.']
    for ch in root.children:
        subs = ', '.join(c.title for c in ch.children)
        lines.append(f'  {ch.title}' + (f': {subs}' if subs else ''))
    return '\n'.join(lines)


def find(root: Section, topic: str) -> Tuple[List[Section], List[Section]]:
    """(sections whose title matches ``topic``, best first; sections whose
    text mentions every word of it)."""
    key = topic.casefold().strip()
    every = list(_walk(root))
    exact = [s for s in every if s.title.casefold() == key or s.path.casefold() == key]
    inside = [s for s in every if key in s.title.casefold() and s not in exact]
    words = [w for w in re.findall(r'\w+', key) if len(w) > 2]
    titled = [s for s in every if words and all(w in s.title.casefold() for w in words)
              and s not in exact and s not in inside]
    mentions = [s for s in every if words and all(w in (s.title + ' ' + ' '.join(s.lines)).casefold() for w in words)]
    return exact + inside + titled, mentions


def t_app_guide(ws, topic: Optional[str] = None) -> str:
    """The guide's outline, or one part of it by name."""
    root = parse(guide_source())
    topic = (topic or '').strip()
    if not topic:
        return outline(root)
    named, mentions = find(root, topic)
    if not named:
        if mentions:
            return (f'No part of the guide is called "{topic}". Parts that mention it: '
                    + '; '.join(f'"{s.path}"' for s in mentions[:12]) + '. Ask for one with topic.')
        return (f'No part of the guide is called "{topic}" or mentions it. Its parts:\n'
                + outline(root).split('\n', 1)[1])
    s = named[0]
    body = s.text()
    head = f'From the Plaid IGT user guide, "{s.path}":'
    others = '' if len(named) == 1 else ('\nAlso named like it: ' + '; '.join(f'"{o.path}"' for o in named[1:6]) + '.')
    if len(body) > MAX_CHARS:
        own = '\n'.join([f'{"#" * s.level} {s.title}', *s.lines]).strip()[:MAX_CHARS]
        body = own + '\n\nIts parts, each asked for by name: ' + ', '.join(f'"{c.title}"' for c in s.children) + '.'
    return f'{head}\n{body}{others}'
