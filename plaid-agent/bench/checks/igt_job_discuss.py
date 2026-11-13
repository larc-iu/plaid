"""IGT: talking with the assistant about a job that ran (BRIEF-JD): asked what
the job left undone, the reply names what the job's record lists, and asked
then to fix one of those things with a given value, the plan writes exactly
that. A job's record is read with read_job: nothing else in the project says
which word the job left blank or which form it left inconsistent.

args:
  named:      regexes (case-insensitive), each of which the reply to the
              user's message number ``named_turn`` (default 1) must match:
              the things the record lists, which the reply must name
  named_turn: which of the user's messages that reply answers
  everything else as checks/igt_changes.py (expect, optional, prov, plan, ...)
              over what was written by the end

Measures: igt_changes' measures, plus named (n/m) and the first 300
characters of that reply.
"""
import re

import common as c
import igt_changes


def _list(x):
    return [] if x is None else x if isinstance(x, list) else [x]


def check(ctx):
    a = ctx.args
    display = ctx.conversation.get('display') or []
    asked = [i for i, d in enumerate(display) if isinstance(d, dict) and d.get('kind') == 'user']
    turn = int(a.get('named_turn') or 1)
    start = asked[turn - 1] if len(asked) >= turn else len(display)
    end = asked[turn] if len(asked) > turn else len(display)
    replies = [d for d in display[start + 1:end] if isinstance(d, dict) and d.get('kind') == 'assistant']
    text = '\n'.join(c.shown_text(ctx.app, d) or '' for d in replies)
    hits = [bool(re.search(p, text, re.I | re.S)) for p in _list(a.get('named'))]
    changes = igt_changes.check(ctx)
    out = {'pass': bool(replies) and all(hits) and changes['pass'],
           'measures': {**changes['measures'], 'named': f'{sum(hits)}/{len(hits)}', 'reply': text[:300]}}
    if 'detail' in changes:
        out['detail'] = changes['detail']
    return out
