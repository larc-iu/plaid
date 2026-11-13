"""IGT: a job scoped in the chat and drafted as a job card (BRIEF-JB): the
assistant raised what the data shows matters before it drafted, the card it
left covers the right documents, and its brief carries the user's
answer. Nothing is written: a card writes nothing, and the user starts it.

args:
  form:      the form people analysed in two ways. A reply before the
             user's message that answers (``answer_turn``, the second by
             default) must raise it: name it, a word of its own,
             case-insensitive, and in the same reply each of ``ways``.
             Raised before any draft, or in the reply that drafts. A card
             drafted before it was raised fails too.
  ways:      a regex, or a list of them, each matched in the reply that
             raises the form (case-insensitive): the analyses people hold,
             so the reply says how the form is analysed. A fixed rule that
             does not judge whether or how a question is put.
  documents: the names the newest card must cover, exactly, or "all" for a
             card over every document of the project
  brief:     a regex, or a list of them, the newest card's brief must match
             (case-insensitive): the user's answer, stated
  reject_brief: a regex, or a list of them, the newest card's brief must NOT
             match (case-insensitive): work the user did not ask for

Measures: raised_in_turn and card_in_turn (the user message, counted from 1,
whose reply raised the form or first drafted a card, None for never), cards,
the newest card's documents and brief, brief_rejected (the reject_brief
patterns it matched), writes (changed addresses and guidelines), plan
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
    ways = [re.compile(p, re.I) for p in _list(a.get('ways'))]
    raised = next((i for i, d in replies
                   if form.search(c.shown_text(ctx.app, d) or '')
                   and all(w.search(c.shown_text(ctx.app, d) or '') for w in ways)), None)
    first = cards[0][0] if cards else None
    asked = [i for i, d in enumerate(display) if isinstance(d, dict) and d.get('kind') == 'user']
    turn = int(a.get('answer_turn') or 2)
    answer_at = asked[turn - 1] if len(asked) >= turn else len(display)
    card = cards[-1][1] if cards else {}
    names = sorted(d.get('name') for d in card.get('documents') or [])
    want = a.get('documents')
    docs_ok = bool(card) and (bool(card.get('all')) if want == 'all'
                              else not card.get('all') and names == sorted(_list(want)))
    brief = str(card.get('brief') or '')
    hits = [bool(re.search(p, brief, re.I | re.S)) for p in _list(a.get('brief'))]
    rejected = [p for p in _list(a.get('reject_brief')) if re.search(p, brief, re.I | re.S)]
    changes = c.project_changes(ctx, READERS['igt'][0])
    writes = sum(len(ch) for ch in changes.values()) + len(c.guideline_changes(ctx))
    statuses = [p.get('status') for p in plan_items(ctx.conversation)]
    raised_ok = raised is not None and raised < answer_at and first is not None and raised <= first
    passed = (bool(cards) and raised_ok and docs_ok and all(hits) and not rejected and writes == 0
              and 'applied' not in statuses)

    def turn_of(i):
        # The user message a reply answers, counted from 1: a display index
        # read as a turn once made "raised_at: 3" look like a third turn
        # (bench glm53-stretch-3, the second reply).
        return None if i is None else sum(1 for j in asked if j < i)
    return {'pass': passed, 'measures': {
        'raised_in_turn': turn_of(raised), 'card_in_turn': turn_of(first), 'cards': len(cards),
        'documents': 'all' if card.get('all') else names,
        'brief': brief[:300], 'brief_matched': f'{sum(hits)}/{len(hits)}', 'brief_rejected': rejected,
        'writes': writes, 'plan_status': statuses}}
