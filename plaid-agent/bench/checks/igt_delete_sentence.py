"""IGT: a sentence typed twice, the copy deleted in the chat (BRIEF-JS).

args:
  document, from: `document` starts with two sentences reading `from`, the
    second a copy with no analysis.

Pass: the conversation holds an applied plan, and every plan applied holds
one change, a deleted sentence; the copy is gone and every other sentence of
`document` reads as before, the first with its words, analyses and values
(`igt_job_plan.doubled_gone`); every other document, the lexicon and the
guidelines are as they were.

Measures: had, left, rest_kept, plan_changes, other_documents, lexicon,
guidelines.
"""
from plaid_agent.igt.project import load_project

import common as c
import igtlib as L
from exact_changes import plan_items
from igt_job_plan import _docs, doubled_gone


def check(ctx):
    a = ctx.args
    project = load_project(ctx.client, ctx.project['id'])
    _d, before, after = _docs(ctx, project, a['document'])
    gone, measures = doubled_gone(before, after, a['from'])
    applied = [p for p in plan_items(ctx.conversation) if p.get('status') == 'applied']
    kinds = [row[0] for p in applied for row in (p.get('plan') or {}).get('proposed') or []]
    others = sorted(n for n in c.project_changes(ctx, c.igt_values) if n != a['document'])
    base = getattr(ctx, 'lex_baseline', None) or []
    labels = L.labels(base)
    lexicon = c.diff(L.lex_values(base, labels),
                     L.lex_values(L.vocab_items(ctx.client, ctx.project['vocabs'][0]['id']), labels))
    guidelines = c.guideline_changes(ctx)
    measures.update({'plan_changes': kinds, 'other_documents': others[:5], 'lexicon': sorted(lexicon)[:5],
                     'guidelines': sorted(guidelines)[:5]})
    ok = gone and bool(applied) and kinds == ['delete_sentence'] and not others and not lexicon and not guidelines
    return c.result(ok, **measures)
