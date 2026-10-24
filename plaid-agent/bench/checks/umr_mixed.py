"""A umr request that asks a question and a change in one message: the writes
are judged as umr_graph judges them and the last reply as answer.py judges
it, and both must pass.

args: umr_graph's (document, expect, triples, allow_triples, draft, prov,
plan), plus
  expect_any: a list of {address: value} maps, any one of which may complete
            `expect` (a role the request leaves open, :poss or :possessor).
            Each is tried with `expect`, the first that passes is kept, else
            the first one's result is reported.
  match:    a regex the last reply must match (case-insensitive), or a list
            of them (all must match)
  reject:   optional regex or list the last reply must NOT match

Measures: umr_graph's, plus matched, rejected_hits and the reply's first 300
characters.
"""
import re
from types import SimpleNamespace

import umr_graph


def _list(x):
    return [] if x is None else x if isinstance(x, list) else [x]


def _graph(ctx):
    a = ctx.args
    alts = a.get('expect_any') or [{}]
    first = None
    for alt in alts:
        args = dict(a, expect={**(a.get('expect') or {}), **alt})
        got = umr_graph.check(SimpleNamespace(**{**vars(ctx), 'args': args}))
        if got['pass']:
            return got
        first = first or got
    return first


def check(ctx):
    a = ctx.args
    got = _graph(ctx)
    replies = [d for d in ctx.conversation.get('display') or [] if d.get('kind') in ('assistant', 'error')]
    text = (replies[-1].get('text') or '') if replies else ''
    plain = re.sub(r'<cite\b[^>]*/>', ' ', text)
    pats = _list(a.get('match'))
    hits = [bool(re.search(p, plain, re.I | re.S)) for p in pats]
    bad = [p for p in _list(a.get('reject')) if re.search(p, plain, re.I | re.S)]
    answer_ok = bool(replies) and all(hits) and not bad
    got['measures'].update({'answer_ok': answer_ok, 'matched': f'{sum(hits)}/{len(hits)}',
                            'rejected_hits': bad, 'reply': plain[:300]})
    got['pass'] = bool(got['pass'] and answer_ok)
    return got
