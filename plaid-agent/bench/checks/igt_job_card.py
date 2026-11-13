"""IGT: a job scoped in the chat and drafted as a job card (BRIEF-JB): the
assistant raised what the data shows matters before it drafted, the card it
left covers the right documents and tasks, and its brief carries the user's
answer. Nothing is written: a card writes nothing, and the user starts it.

args:
  form:      the form people analysed in two ways. A reply before the
             user's message that answers (``answer_turn``, the second by
             default) must raise it: name it, a word of its own,
             case-insensitive, in a reply that asks something (holds a "?"
             anywhere, a fixed rule that does not judge what is asked).
             Raised before any draft, or in the reply that drafts and asks.
             A card drafted before it was raised fails too.
  documents: the names the newest card must cover, exactly, or "all" for a
             card over every document of the project
  tasks:     the newest card's tasks, exactly, in core's order
  brief:     a regex, or a list of them, the newest card's brief must match
             (case-insensitive): the user's answer, stated

Measures: raised_at and card_at (display indexes), cards, the newest card's
documents, tasks and brief, writes (changed addresses and guidelines), plan
statuses.
"""
import re

import common as c
from exact_changes import READERS, plan_items


def _list(x):
    return [] if x is None else x if isinstance(x, list) else [x]


def check(ctx):
    a = ctx.args
    display = ctx.conversation.get('display') or []
    replies = [(i, d) for i, d in enumerate(display) if isinstance(d, dict) and d.get('kind') == 'assistant']
    cards = [(i, d['job']) for i, d in replies if isinstance(d.get('job'), dict)]
    form = re.compile(rf'(?<![^\W_]){re.escape(a["form"])}(?![^\W_])', re.I)
    raised = next((i for i, d in replies
                   if form.search(c.shown_text(ctx.app, d) or '') and '?' in (c.shown_text(ctx.app, d) or '')), None)
    first = cards[0][0] if cards else None
    asked = [i for i, d in enumerate(display) if isinstance(d, dict) and d.get('kind') == 'user']
    turn = int(a.get('answer_turn') or 2)
    answer_at = asked[turn - 1] if len(asked) >= turn else len(display)
    card = cards[-1][1] if cards else {}
    names = sorted(d.get('name') for d in card.get('documents') or [])
    want = a.get('documents')
    docs_ok = bool(card) and (bool(card.get('all')) if want == 'all'
                              else not card.get('all') and names == sorted(_list(want)))
    tasks_ok = card.get('tasks') == _list(a.get('tasks'))
    brief = str(card.get('brief') or '')
    hits = [bool(re.search(p, brief, re.I | re.S)) for p in _list(a.get('brief'))]
    changes = c.project_changes(ctx, READERS['igt'][0])
    writes = sum(len(ch) for ch in changes.values()) + len(c.guideline_changes(ctx))
    statuses = [p.get('status') for p in plan_items(ctx.conversation)]
    raised_ok = raised is not None and raised < answer_at and first is not None and raised <= first
    passed = (bool(cards) and raised_ok and docs_ok and tasks_ok and all(hits) and writes == 0
              and 'applied' not in statuses)
    return {'pass': passed, 'measures': {
        'raised_at': raised, 'card_at': first, 'cards': len(cards), 'documents': 'all' if card.get('all') else names,
        'tasks': card.get('tasks'), 'brief': brief[:300], 'brief_matched': f'{sum(hits)}/{len(hits)}',
        'writes': writes, 'plan_status': statuses}}
