"""A ud request that mixes a question and a change in one message: the
project must end as `ud_tree` expects AND the assistant's replies must answer
the question.

args:
  tree:    the ud_tree args (document, base, expect, ...)
  match:   a regex the replies must match (case-insensitive), or a list of
           them (all must match). Every assistant reply of the conversation
           is read, so an answer given before or beside the plan counts.
  reject:  optional regex or list no reply may match

Measures: ud_tree's measures, plus matched (n/m), rejected_hits and the
last reply's first 300 characters.
"""
import re
from types import SimpleNamespace

import ud_tree


def _list(x):
    return [] if x is None else x if isinstance(x, list) else [x]


def check(ctx):
    a = ctx.args
    tree = ud_tree.check(SimpleNamespace(**{**vars(ctx), 'args': a['tree']}))
    replies = [d for d in ctx.conversation.get('display') or [] if d.get('kind') == 'assistant']
    text = '\n'.join(re.sub(r'<cite\b[^>]*/>', ' ', d.get('text') or '') for d in replies)
    hits = [bool(re.search(p, text, re.I | re.S)) for p in _list(a.get('match'))]
    bad = [p for p in _list(a.get('reject')) if re.search(p, text, re.I | re.S)]
    answered = bool(replies) and all(hits) and not bad
    m = dict(tree.get('measures') or {})
    m.update({'tree_pass': bool(tree.get('pass')), 'matched': f'{sum(hits)}/{len(hits)}',
              'rejected_hits': bad, 'reply': (replies[-1].get('text') or '')[:300] if replies else ''})
    return {'pass': bool(tree.get('pass')) and answered, 'measures': m, 'detail': tree.get('detail')}
