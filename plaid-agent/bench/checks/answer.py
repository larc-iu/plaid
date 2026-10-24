"""A question with a checkable answer, or a request that must be refused or
answered with a question: the last reply says the right thing and nothing
was written.

args:
  reader:   igt | ud | umr (for the nothing-written check over the project)
  match:    a regex the last reply must match (case-insensitive), or a list
            of them (all must match)
  reject:   optional regex or list the last reply must NOT match
  plan:     none (default: no plan was applied and nothing changed)
            | any (writes allowed, only the reply is judged)

Measures: matched (n/m), rejected_hits, writes (changed addresses), plan
statuses, and the reply's first 300 characters.
"""
import re

import common as c
from exact_changes import READERS, plan_items


def _list(x):
    return [] if x is None else x if isinstance(x, list) else [x]


def check(ctx):
    a = ctx.args
    replies = [d for d in ctx.conversation.get('display') or [] if d.get('kind') in ('assistant', 'error')]
    text = (replies[-1].get('text') or '') if replies else ''
    plain = re.sub(r'<cite\b[^>]*/>', ' ', text)
    pats = _list(a.get('match'))
    hits = [bool(re.search(p, plain, re.I | re.S)) for p in pats]
    bad = [p for p in _list(a.get('reject')) if re.search(p, plain, re.I | re.S)]
    writes = 0
    if a.get('plan', 'none') == 'none':
        changes = c.project_changes(ctx, READERS[a.get('reader', ctx.app)][0])
        writes = sum(len(ch) for ch in changes.values()) + len(c.guideline_changes(ctx))
    statuses = [p.get('status') for p in plan_items(ctx.conversation)]
    passed = bool(replies) and replies[-1].get('kind') == 'assistant' and all(hits) and not bad and \
        (a.get('plan', 'none') == 'any' or (writes == 0 and 'applied' not in statuses))
    return {'pass': passed, 'measures': {'matched': f'{sum(hits)}/{len(hits)}', 'rejected_hits': bad,
                                         'writes': writes, 'plan_status': statuses, 'reply': plain[:300]}}
