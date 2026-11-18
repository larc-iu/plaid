"""What the planner is told of a plan's size and cost (RPF3 round 4).

A real model planned the rename of one gloss (33 hits in 24 documents, found
by search) as "sentences" over all 45 documents: every sentence walked in
stretches, about four hours for 33 exact replacements. The planner's rules
said "sentences" was for sentence by sentence work, "Every sentence", and
"selection" for finding where documents disagree, with findings in its last
message: it read a selection as a report and "sentences" as the way to change
values. Now the rules say the cost of a sentences plan as a fact, and that a
selection makes the same exact change wherever a known value occurs; and
plan_work's answer says how many pieces a sentences or document plan is."""

from fixtures import FakeClient, MGLOSS

from plaid_agent.core.limits import JOB_STRETCH_SENTENCES
from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project
from plaid_agent.igt.prompt import JOB_PLAN_RULES


def _planning(docs):
    ws = JobWorkspace(FakeClient(), load_project(FakeClient(), 'p1'), mode=JobWorkspace.PLAN)
    ws.job_documents = docs
    return ws


DOCS = [{'id': f'd{i}', 'name': f'Text {i}', 'sentences': 20, 'empty': {}} for i in range(1, 46)]


def test_the_rules_say_what_a_sentences_plan_costs_and_what_a_selection_changes():
    rules = JOB_PLAN_RULES.replace('\n', ' ')
    assert 'A plan in sentences makes at least one model call for each stretch the plan takes.' in rules, rules
    assert ('and for the same exact change wherever a known value occurs (one value for another): it finds them with '
            'search or code and stages each change, which is written in its document.' in rules), rules
    assert 'for work that needs each sentence read' in rules


def test_plan_work_says_how_many_pieces_a_sentences_or_document_plan_is():
    per = -(-20 // JOB_STRETCH_SENTENCES)
    out = toolkit.job_plan_call(_planning(DOCS), 'plan_work', {'pieces': 'sentences', 'fills': ['Morph Gloss']})
    assert out == (f'The plan is kept. This plan is {45 * per:,} pieces over 45 documents. {toolkit.PLAN_END}')
    assert toolkit.PLAN_END == 'End now with a one-line reply, or call plan_work again if another plan fits better.'
    some = [{**d, 'empty': {MGLOSS: 1}} for d in DOCS]
    out = toolkit.job_plan_call(_planning(some), 'plan_work', {'pieces': 'sentences', 'fills': ['Morph Gloss'],
                                                               'skip_filled_sentences': True,
                                                               'documents': ['Text 1', 'Text 2']})
    assert f'This plan is at most {2 * per:,} pieces over 2 documents.' in out, out
    out = toolkit.job_plan_call(_planning(DOCS[:1]), 'plan_work', {'pieces': 'document', 'fills': ['Morph Gloss']})
    assert 'This plan is 1 piece over 1 document.' in out, out
    out = toolkit.job_plan_call(_planning(DOCS), 'plan_work', {'pieces': 'selection', 'fills': ['Morph Gloss']})
    assert out == f'The plan is kept. This plan is 1 piece over 45 documents. {toolkit.PLAN_END}', out


def test_plan_work_may_be_called_again_and_the_last_plan_is_kept():
    ws = _planning(DOCS)
    toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'sentences', 'fills': ['Morph Gloss']})
    toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'selection', 'fills': ['Morph Gloss']})
    assert ws.plan_work['pieces'] == 'selection'


def test_a_document_plan_counts_the_stretches_a_long_document_is_worked_in():
    """REV-RPF3B-6 (the reviewer's sizes): documents of 12, 5, 1 and 900
    sentences, the last past the most one piece takes: worked in stretches,
    as whole_document decides, so 3 + 180 pieces."""
    from plaid_agent.core.limits import JOB_DOCUMENT_PIECE_MAX_TOKENS
    docs = [{'id': 'd1', 'name': 'A', 'sentences': 12, 'empty': {}, 'tokens': 150},
            {'id': 'd2', 'name': 'B', 'sentences': 5, 'empty': {}, 'tokens': 60},
            {'id': 'd3', 'name': 'C', 'sentences': 1, 'empty': {}, 'tokens': 12},
            {'id': 'd4', 'name': 'D', 'sentences': 900, 'empty': {}, 'tokens': JOB_DOCUMENT_PIECE_MAX_TOKENS + 1}]
    out = toolkit.job_plan_call(_planning(docs), 'plan_work', {'pieces': 'document', 'fills': ['Morph Gloss']})
    assert f'This plan is {3 + -(-900 // JOB_STRETCH_SENTENCES):,} pieces over 4 documents.' in out, out


def test_a_plan_that_works_no_sentence_gives_no_size():
    """REV-RPF3B-6: "This plan is at most 185 pieces ... This plan works no
    sentence" said both."""
    docs = [{'id': 'd1', 'name': 'A', 'sentences': 12, 'empty': {}}]
    out = toolkit.job_plan_call(_planning(docs), 'plan_work', {'pieces': 'sentences', 'fills': ['Morph Gloss'],
                                                               'skip_filled_sentences': True})
    assert out == (f'The plan is kept. {toolkit.PLAN_WORKS_NOTHING} Call plan_work again to change it, or end now '
                   'with a one-line reply.'), out


def test_the_rules_cost_sentence_holds_for_every_plan_in_sentences():
    """REV-RPF3B-9: true with skip_filled_sentences and with a search."""
    rules = JOB_PLAN_RULES.replace('\n', ' ')
    assert 'A plan in sentences makes at least one model call for each stretch the plan takes.' in rules, rules


def test_the_rules_say_nothing_more_is_worked_after_a_selection():
    """SF round 2: after a whole-selection piece nothing more is worked, so
    the planner must not count on a walk to finish it."""
    rules = JOB_PLAN_RULES.replace('\n', ' ')
    assert 'Nothing more is worked after it: what it leaves empty stays empty.' in rules, rules


def test_the_rules_steer_filling_word_by_word_to_sentences():
    """BRIEF RW B4: a planner chose one selection piece to fill a 179-word
    text from nothing because a piece in sentences has "no search or code"
    (plan round 7 of the measured run): the rules now say what a sentences
    piece is handed instead, and where word-by-word filling goes."""
    rules = JOB_PLAN_RULES.replace('\n', ' ')
    assert ('no search or code: each piece is handed how its words\' forms were analysed before and the lexicon '
            'entries spelled in them.') in rules, rules
    # No number: a piece's calls are 20 and a closing one (REV-RW-8).
    assert ('- To fill what is empty word by word, plan "sentences": a piece has a fixed number of model calls, too '
            'few for a whole text.') in rules, rules
