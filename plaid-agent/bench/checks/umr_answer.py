"""checks/answer.py for a umr task, with "nothing was written" read over the
whole UMR graph (umr_graph.flat: nodes, roles, alignments, the document
graph, constants and the igt layers under it) rather than the sentence
graphs only.

args: answer.py's, plus
  no_plan:  true when the turn must not even PROPOSE a plan (a request that
            needs a question back first: a plan over every candidate, left
            unapproved, is still the wrong answer)
"""
import answer
import umr_graph
from exact_changes import plan_items

answer.READERS = {**answer.READERS, 'umr': (umr_graph.flat, None)}


def check(ctx):
    got = answer.check(ctx)
    if ctx.args.get('no_plan'):
        proposed = len(plan_items(ctx.conversation))
        got['measures']['plans_proposed'] = proposed
        if proposed:
            got['pass'] = False
    return got
