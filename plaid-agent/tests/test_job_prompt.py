"""A job is the assistant, unattended (the owner's rulings 12 and 14 of
2026-11-13): a piece of a job is given the chat's own prompt, its shared rules
word for word, with the paragraphs that assume a person present put the
job's way, and the chat's own tools. One source of truth for the shared
rules: nothing in the job's prompt is a second copy of a chat rule.

The constants are CONTRACT 1's and those added by JG."""

import json

import pytest

from fixtures import FakeClient, fake_ws

from plaid_agent.core import limits, prompt as shared
from plaid_agent.igt import prompt, toolkit
from plaid_agent.igt.job import JobWorkspace


def _project():
    return fake_ws(FakeClient()).project


def _job_prompt():
    return prompt.build_job_prompt(_project())


def _bullets(text):
    """The prompt's paragraphs and bullets, each whole."""
    out, cur = [], []
    for line in text.split('\n'):
        if line.startswith('- ') or not line.strip():
            if cur:
                out.append('\n'.join(cur))
            cur = [line] if line.strip() else []
        else:
            cur.append(line)
    if cur:
        out.append('\n'.join(cur))
    return out


def test_the_constants_are_the_contracts():
    assert (limits.JOB_HEARTBEAT_S, limits.JOB_IDLE_POLL_S, limits.JOB_STRETCH_SENTENCES,
            limits.JOB_CONTEXT_SENTENCES, limits.JOB_SENTENCE_MAX_CHARS, limits.JOB_GUIDELINES_MAX_CHARS,
            limits.JOB_PRECEDENT_PER_FORM, limits.JOB_PRECEDENT_CHARS) == (30, 30, 5, 2, 4000, 24000, 3, 8000)
    assert (limits.JOB_STRETCH_MAX_ROUNDS, limits.JOB_STRETCH_DECIDE_AT_ROUNDS, limits.JOB_CALL_MAX_PROMPT_TOKENS,
            limits.JOB_CALL_DECIDE_AT_TOKENS, limits.JOB_STRETCH_MAX_SENT_TOKENS) == (20, 15, 64000, 48000, 600000)
    assert (limits.JOB_MODEL_RETRY_S, limits.JOB_YIELD_POLL_S, limits.JOB_YIELD_QUIET_S, limits.JOB_PERSON_QUIET_S,
            limits.JOB_LOCK_TRIES, limits.JOB_LOCK_WAIT_S, limits.JOB_DEFER_ROUNDS, limits.JOB_DEFER_WAIT_S,
            limits.HARMONIZE_MAJORITY, limits.JOB_REPORT_LIST_MAX) == (300, 10, 60, 600, 3, 10, 3, 600, (2, 3), 500)
    assert shared.JOB_DECIDE_NOW == ('(system) Decide now with what you have: stage your work on the piece and end '
                                     'with your note.')
    assert (limits.JOB_DOCUMENT_PIECE_MAX_CHARS, limits.JOB_NOTE_MAX_CHARS, limits.JOB_CHANGES_MAX,
            limits.JOB_CHANGE_VALUE_CHARS, limits.JOB_SUMMARY_MAX_CHARS) == (40000, 400, 500, 300, 3000)


def test_every_rule_the_job_keeps_is_the_chats_word_for_word():
    """The job's prompt is the chat's template filled the job's way: each of
    its bullets is either the chat's own, as the chat says it, or one of the
    job's paragraphs (core.prompt JOB_*), never a reworded copy."""
    chat = prompt.SYSTEM
    job_own = [shared.JOB_CONTRACT.split('{')[0][:40], shared.JOB_FIND_FIRST[:40], shared.JOB_STAGE_NOW[:40],
               shared.JOB_PLAN_WHAT_WAS_ASKED[:40], shared.JOB_VALUES[:40], shared.JOB_NOTE[:40],
               shared.JOB_EXAMPLE[:30], prompt._JOB_PROJECT_WIDE[:40], prompt._JOB_EXAMPLE_NOTE[:30]]
    for bullet in _bullets(prompt.JOB_SYSTEM):
        if any(bullet.startswith(own) or own in bullet for own in job_own):
            continue
        assert bullet in chat, bullet[:120]


def test_no_paragraph_that_assumes_a_person_is_said():
    text = _job_prompt()
    for paragraph in (shared.ONE_TURN, shared.STAGE_NOW, shared.FINAL_MESSAGE, shared.PLAN_CONTRACT.split('{')[0],
                      shared.IN_STRETCHES[:60], shared.PLAN_WHAT_WAS_ASKED, shared.ATTACH_FILES[:60],
                      shared.CITE_EVIDENCE[:60], prompt._OPEN_DOCUMENT, prompt._JOBS[:60], prompt._CITE_ITEMS):
        assert paragraph[:60] not in text, paragraph[:60]
    lowered = text.lower()
    for words in ('ask which', 'end your turn', 'plan card', 'stretch', 'propose_job', 'approve it'):
        assert words not in lowered, words
    assert 'unverified machine proposal' in text and 'proposed change' in text
    assert 'GUIDELINE: Glossing' in text and 'Loanwords are **not** segmented' in text, 'every guideline, whole'


def test_the_prompt_shows_one_whole_piece_in_prose():
    text = _job_prompt()
    assert 'A WHOLE PIECE, FOR EXAMPLE.' in text and prompt._JOB_EXAMPLE_NOTE in text
    assert 'set_analysis(' not in text and '{"' not in text, 'calls told in prose, never call syntax'


def test_a_piece_is_offered_the_chats_tools_but_drafting_and_reading_jobs():
    """A plan that edits the text: every tool of the chat's but the two
    (test_job_text_edits has the plan that does not)."""
    ws = JobWorkspace(FakeClient(), _project())
    ws.edits_text = True
    names = [t['function']['name'] for t in toolkit.job_piece_tools(ws)]
    chat = [t['function']['name'] for t in toolkit.tools_for(ws)]
    assert names == [n for n in chat if n not in ('propose_job', 'read_job')], 'the same list, in the same order'
    assert 'run_code' in names or 'run_code' not in chat, 'the code tool wherever the chat has it'
    assert {t['function']['name'] for t in toolkit.job_piece_tools(ws, plan_only=True)} == \
        {n for n in names if n in toolkit.WRITE_TOOLS}


def test_a_tool_outside_the_list_is_refused_and_not_run():
    ws = JobWorkspace(FakeClient(), _project())
    out = toolkit.job_piece_call(ws, 'propose_job', {'action': 'help'})
    assert str(out).startswith('Error') and "not one of this job's" in out


def test_the_planning_context_reads_and_plans_and_stages_nothing():
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    names = {t['function']['name'] for t in toolkit.job_plan_tools(ws)}
    assert 'plan_work' in names and not names & set(toolkit.WRITE_TOOLS) and 'propose_job' not in names
    assert {t['function']['name'] for t in toolkit.job_plan_tools(ws, plan_only=True)} == {'plan_work'}
    assert str(toolkit.job_plan_call(ws, 'set_field', {})).startswith('Error')
    out = toolkit.call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1'], 'field': 'Translation',
                                              'value': 'x'})
    assert 'stages no change' in out and not ws.ops


@pytest.mark.parametrize('args,said', [
    ({'pieces': 'chapters'}, 'pieces: give "sentences", "document" or "selection".'),
    ({'pieces': 'document', 'documents': ['Text 9']}, 'documents: not documents of this job: "Text 9". Leave them '
     'out of documents, or leave documents out for every document.'),
    # BRIEF PF: an argument plan_work does not take is named, with the fix.
    ({'pieces': 'document', 'every_sentence': True}, 'plan_work takes no every_sentence. Call it again without it.'),
])
def test_plan_work_takes_only_the_menu(args, said):
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    out = toolkit.job_plan_call(ws, 'plan_work', args)
    assert str(out).startswith('Error') and said in out, out
    assert ws.plan_work is None


def test_plan_work_keeps_a_valid_plan():
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}, {'id': 'd2', 'name': 'Text 2'}]
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'document', 'fills': ['segmentation'], 'piece_instructions': ' Gloss -da as LOC. ',
                                                  'documents': ['text 2', 'd1', 'Text 2']})
    assert out.startswith('The plan is kept.'), out
    assert ws.plan_work == {'pieces': 'document', 'piece_instructions': 'Gloss -da as LOC.', 'documents': ['d2', 'd1'],
                            'fills': ['segmentation']}


def test_plan_work_cuts_piece_instructions_past_their_cap_at_a_whole_sentence_and_says_so():
    """BRIEF PF: instructions past the cap are never refused (a planner
    refused eight times in a row for them ran out of calls). They are cut at
    the end of their last whole sentence within the cap, the answer says
    so, and the plan records how long they were."""
    from plaid_agent.core.limits import JOB_PIECE_INSTRUCTIONS_MAX_CHARS as cap
    assert cap == 4000
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    sentence = 'Gloss -da as LOC wherever it follows a noun.'
    told = ' '.join([sentence] * 100)
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'document', 'fills': ['segmentation'], 'piece_instructions': told})
    kept = ws.plan_work['piece_instructions']
    assert len(kept) <= cap and kept.endswith('noun.') and told.startswith(kept)
    assert len(kept) > cap - len(sentence) - 1, 'every whole sentence that fits'
    assert ws.plan_work['instructions_cut'] == len(told)
    assert out == (f'The plan is kept. piece_instructions were {len(told):,} characters, past the most, 4,000: they '
                   f'are kept up to their last whole sentence within it, {len(kept):,} characters. Pieces already '
                   'have the guidelines and the instructions. End now with a one-line reply.'), out


def test_plan_work_cuts_one_long_sentence_at_the_cap():
    from plaid_agent.core.limits import JOB_PIECE_INSTRUCTIONS_MAX_CHARS as cap
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = []
    toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'document', 'fills': ['segmentation'], 'piece_instructions': 'x' * (cap + 7)})
    assert ws.plan_work['piece_instructions'] == 'x' * cap and ws.plan_work['instructions_cut'] == cap + 7


def test_plan_work_says_when_it_cut_inside_a_sentence():
    """REV-L2-7: with no sentence end within the cap the cut is at the cap,
    and the answer says so rather than "last whole sentence"."""
    from plaid_agent.core.limits import JOB_PIECE_INSTRUCTIONS_MAX_CHARS as cap
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = []
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'document', 'fills': ['segmentation'], 'piece_instructions': 'x' * (cap + 7)})
    assert out == (f'The plan is kept. piece_instructions were {cap + 7:,} characters, past the most, 4,000: they '
                   f'are cut at {cap:,} characters, inside a sentence. Pieces already have the guidelines and the '
                   'instructions. End now with a one-line reply.'), out


@pytest.mark.parametrize('end', [chr(0x3002), chr(0x964) + ' ', chr(0x61F) + ' '], ids=['cjk', 'danda', 'arabic'])
def test_plan_work_cuts_after_a_sentence_end_of_other_scripts(end):
    """REV-L2-7: the ideographic full stop (no space after it), the danda and
    the Arabic question mark end a sentence too."""
    from plaid_agent.core.limits import JOB_PIECE_INSTRUCTIONS_MAX_CHARS as cap
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = []
    sentence = 'y' * 37 + end
    told = sentence * (cap // len(sentence) + 3)
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'document', 'fills': ['segmentation'], 'piece_instructions': told})
    kept = ws.plan_work['piece_instructions']
    assert kept.endswith(end.strip()) and len(kept) > cap - len(sentence) - 1, len(kept)
    assert 'last whole sentence' in out


def test_plan_work_measures_its_instructions_composed_as_core_does():
    """REV-L2-2: core composes (NFC) every string of a job route before it
    measures, and a precomposed nukta letter (U+09DF) is two characters
    composed. Instructions of 3,999 of them passed the cut and core refused
    the plan with a 400. They are composed, then measured and cut."""
    import unicodedata
    from plaid_agent.core.limits import JOB_PIECE_INSTRUCTIONS_MAX_CHARS as cap
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = []
    told = chr(0x9DF) * (cap - 1)
    toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'document', 'fills': ['segmentation'], 'piece_instructions': told})
    kept = ws.plan_work['piece_instructions']
    assert unicodedata.normalize('NFC', kept) == kept and len(kept) <= cap
    assert ws.plan_work['instructions_cut'] == 2 * (cap - 1)


def test_every_decision_and_message_the_worker_sends_is_composed():
    """REV-L2-2: one helper for every capped text the worker measures (a
    decision's analysis, which holds notes, table cells and proposed values,
    and the job's message): composed before it is measured."""
    import unicodedata
    from plaid_agent.core.job import canonical, error_line
    letter = chr(0x9DF)
    assert canonical({'note': letter}) == unicodedata.normalize('NFC', '{"note":"' + letter + '"}')
    line = error_line(Exception(letter * 400))
    assert unicodedata.normalize('NFC', line) == line and len(line) <= 300


def test_plan_work_at_the_cap_is_kept_whole_and_not_marked():
    from plaid_agent.core.limits import JOB_PIECE_INSTRUCTIONS_MAX_CHARS as cap
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = []
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'document', 'fills': ['segmentation'], 'piece_instructions': 'x' * cap})
    assert out == 'The plan is kept. End now with a one-line reply.'
    assert ws.plan_work['piece_instructions'] == 'x' * cap and 'instructions_cut' not in ws.plan_work


def test_the_planner_is_told_pieces_have_the_guidelines_and_the_instructions():
    """BRIEF PF: the piece_instructions line, in no more words than it had
    (28), says pieces already have the project's guidelines and the job's
    instructions, so piece_instructions hold only what the planner decided."""
    line = next(x for x in prompt.JOB_PLAN_RULES.replace('\\\n', '').splitlines()
                if x.startswith('- piece_instructions:'))
    assert len(line[2:].split()) <= 28, len(line[2:].split())
    assert line == ('- piece_instructions: only your decisions, as plain imperative sentences naming forms and '
                    'values exactly. Pieces already have the project\'s guidelines and the job\'s instructions. Read '
                    'the documents to decide.')


@pytest.mark.parametrize('pieces', ['sentences', 'document', 'selection'])
@pytest.mark.parametrize('only', [True, False, None])
def test_plan_work_keeps_skip_filled_sentences_only_when_true_on_a_plan_in_sentences(pieces, only):
    """BRIEF EW: a plan in sentences walks every sentence unless it says so.
    DF1 (the owner's steer): the model sets skip_filled_sentences, which
    means what it reads as (skip a sentence where nothing the job fills is
    empty). The plan keeps it as only_empty, the key the job page reads,
    only when true and only on a plan in sentences."""
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    args = {'pieces': pieces, 'fills': ['segmentation'], **({} if only is None else {'skip_filled_sentences': only})}
    assert toolkit.job_plan_call(ws, 'plan_work', args).startswith('The plan is kept.')
    assert ws.plan_work.get('only_empty') is (True if only and pieces == 'sentences' else None)
    assert 'skip_filled_sentences' not in ws.plan_work
    props = toolkit.PLAN_WORK['function']['parameters']['properties']
    assert 'skip_filled_sentences' in props and 'only_empty' not in props and 'skip_analyzed_sentences' not in props


@pytest.mark.parametrize('fills,kept', [
    ('segmentation, Morph Gloss', ['segmentation', 'Morph Gloss']),
    ('["segmentation", "Morph Gloss"]', ['segmentation', 'Morph Gloss']),
    ('[segmentation, Morph Gloss]', ['segmentation', 'Morph Gloss']),
    ('Morph Gloss', ['Morph Gloss']),
    ('[]', []),
])
def test_plan_work_reads_fills_given_as_one_string(fills, kept):
    """REV-DF4-1: a list sent as one string (a tool-call parser's habit with
    Qwen models) is read as a JSON list, or as names separated by commas
    when every part names a target, the way the piece tools read refs."""
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'sentences', 'fills': fills})
    assert out.startswith('The plan is kept.'), out
    from plaid_agent.igt import targets as tg
    assert ws.plan_work['fills'] == [t.id for t in tg.named(ws.project, kept)[0]]


@pytest.mark.parametrize('fills', ['segmentation, glosses', 'segmentation and Morph Gloss', '["segmentation", 3'])
def test_plan_work_refuses_a_string_of_fills_it_cannot_read_saying_fills_is_a_list(fills):
    """REV-DF4-1: a string that does not read as names is refused saying
    what is wrong, with an example in the project's own names."""
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'sentences', 'fills': fills})
    assert out == ('Error: fills is a list of names, such as ["segmentation", "Gloss"]. Name each as listed under '
                   'What a job can fill: segmentation, Gloss, Morph Gloss, Translation, IPA.'), out
    assert ws.plan_work is None


@pytest.mark.parametrize('documents,kept', [
    ('Text 2, Text 1', ['d2', 'd1']), ('["Text 2", "d1"]', ['d2', 'd1']), ('Text 1, 2', ['d3'])])
def test_plan_work_reads_documents_given_as_one_string(documents, kept):
    """REV-DF4-1: documents given as one string, read the same way. A name
    holding a comma is a name first."""
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}, {'id': 'd2', 'name': 'Text 2'},
                        {'id': 'd3', 'name': 'Text 1, 2'}]
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'document', 'fills': [], 'documents': documents})
    assert out.startswith('The plan is kept.'), out
    assert ws.plan_work['documents'] == kept


def test_plan_work_refuses_a_string_of_documents_it_cannot_read_saying_documents_is_a_list():
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}, {'id': 'd2', 'name': 'Text 2'}]
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'document', 'fills': [], 'documents': 'Text 1, Text 9'})
    assert out == ('Error: documents is a list of names, such as ["Text 1", "Text 2"]. Leave out a document not '
                   'of this job, or leave documents out for every document.'), out
    assert ws.plan_work is None


@pytest.mark.parametrize('given,read', [('true', True), ('True', True), (' TRUE ', True), ('false', False),
                                        (True, True), (False, False)])
@pytest.mark.parametrize('arg', ['skip_filled_sentences', 'edits_text'])
def test_plan_work_reads_true_and_false_given_as_strings(arg, given, read):
    """REV-DF4-4: "true" was kept silently as false (the plan walked every
    sentence). The strings true and false are read as the booleans."""
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'sentences', 'fills': ['Gloss'], arg: given})
    assert out.startswith('The plan is kept.'), out
    key = {'skip_filled_sentences': 'only_empty', 'edits_text': 'edits_text'}[arg]
    assert ws.plan_work.get(key) is (True if read else None)


@pytest.mark.parametrize('given', ['yes', '', 1, 0, 'none', ['true']])
@pytest.mark.parametrize('arg', ['skip_filled_sentences', 'edits_text'])
def test_plan_work_refuses_anything_else_for_true_or_false(arg, given):
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'sentences', 'fills': ['Gloss'], arg: given})
    assert out == f'Error: {arg} is true or false, not {json.dumps(given)}.', out
    assert ws.plan_work is None


@pytest.mark.parametrize('old', ['only_empty', 'skip_analyzed_sentences'])
def test_plan_work_takes_no_old_name(old):
    """The old names are refused as any argument it does not take."""
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    out = toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'sentences', 'fills': [], old: True})
    assert f'plan_work takes no {old}.' in out and ws.plan_work is None
    assert 'It takes pieces, ' in out and 'skip_filled_sentences' in out and 'fills' in out, out


def test_the_planner_is_told_every_sentence_by_default_and_when_to_skip_filled_sentences():
    """The guidance line says a plan in sentences takes every sentence, what
    a sentences piece can do (REV-DAY-P-10), and when to set
    skip_filled_sentences, and plan_work's description says what it skips
    and what fills is."""
    line = next(x for x in prompt.JOB_PLAN_RULES.replace('\\\n', '').splitlines()
                if x.startswith('- pieces "sentences"'))
    assert 'Every sentence, unless the job only fills what is empty: then skip_filled_sentences true.' in line
    assert 'no search or code' in line
    built = prompt.build_plan_prompt(_project())
    assert 'every_sentence' not in built and 'only_empty' not in built and 'skip_analyzed' not in built
    description = toolkit.PLAN_WORK['function']['description']
    assert 'only_empty' not in description
    assert 'skip_filled_sentences: with "sentences", true skips every sentence in which nothing the job fills is ' \
           'empty.' in description
    assert 'fills: what the job fills, each named as the message lists it under What a job can fill' in description


NOTHING = 'This plan works no sentence: nothing it fills is empty in its documents.'


def _planned(docs, args):
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN)
    ws.job_documents = docs
    return ws, toolkit.job_plan_call(ws, 'plan_work', args)


# The planning context's counts, by target id: segmentation, the word Gloss.
FULL = {'id': 'd1', 'name': 'Text 1', 'sentences': 3, 'empty': {'segmentation': 0, 'sl-gloss': 4}}
HALF = {'id': 'd2', 'name': 'Text 2', 'sentences': 4, 'empty': {'segmentation': 2, 'sl-gloss': 0}}


def test_a_plan_that_skips_every_sentence_is_kept_and_says_so():
    """BRIEF OE item 3, by the plan's targets: skip_filled_sentences on
    documents where nothing it fills is empty works nothing. The answer says
    so in one line, as a fixed rule on the planning context's counts, and
    the plan is kept, so the planner may call plan_work again."""
    ws, out = _planned([FULL], {'pieces': 'sentences', 'fills': ['segmentation'], 'skip_filled_sentences': True})
    assert out == f'The plan is kept. {NOTHING} Call plan_work again to change it, or end now with a one-line reply.'
    assert ws.plan_work['only_empty'] is True and ws.plan_work['fills'] == ['segmentation']
    assert toolkit.job_plan_call(ws, 'plan_work', {'pieces': 'sentences', 'fills': ['segmentation']}) == \
        'The plan is kept. End now with a one-line reply.'
    assert 'only_empty' not in ws.plan_work and ws.plan_work['fills'] == ['segmentation']


def test_a_plan_that_fills_nothing_and_skips_works_nothing():
    _, out = _planned([HALF], {'pieces': 'sentences', 'fills': [], 'skip_filled_sentences': True})
    assert NOTHING in out


FILLS_NOTHING = ('This plan fills nothing: its pieces are shown nothing as empty, and the report lists nothing as '
                 'left blank.')


def test_plan_work_refuses_a_plan_that_does_not_say_what_it_fills():
    """REV-DF-D-1: fills is required. A planner that left it out made a job
    that filled nothing and said nothing: it is refused with a line it can
    act on, naming what the project can fill and the empty list."""
    assert toolkit.PLAN_WORK['function']['parameters']['required'] == ['pieces', 'fills']
    ws, out = _planned([HALF], {'pieces': 'sentences', 'skip_filled_sentences': True})
    assert out == ('Error: fills: say what the job fills, each named as listed under What a job can fill: '
                   'segmentation, Gloss, Morph Gloss, Translation, IPA. Give [] when it fills nothing, such as a check '
                   'or a summary.'), out
    assert ws.plan_work is None


@pytest.mark.parametrize('pieces, said', [
    ('sentences', f'{FILLS_NOTHING} Its pieces are offered only set_field and reads.'),
    ('document', FILLS_NOTHING),
    ('selection', FILLS_NOTHING),
])
def test_a_plan_that_fills_nothing_is_kept_and_says_so(pieces, said):
    """REV-DF-D-1: an empty fills is a plan that fills nothing (a check, a
    summary): kept, with fills [], and its answer says so in one line, so a
    planner that meant the job to fill something may plan again."""
    ws, out = _planned([HALF], {'pieces': pieces, 'fills': []})
    assert out == f'The plan is kept. {said} Call plan_work again to change it, or end now with a one-line reply.'
    assert ws.plan_work['fills'] == []


@pytest.mark.parametrize('docs, args', [
    ([FULL, HALF], {'pieces': 'sentences', 'fills': ['segmentation'], 'skip_filled_sentences': True}),
    ([FULL], {'pieces': 'sentences', 'fills': ['Gloss'], 'skip_filled_sentences': True}),
    ([FULL], {'pieces': 'sentences', 'fills': ['segmentation']}),
    ([FULL], {'pieces': 'document', 'fills': ['segmentation'], 'skip_filled_sentences': True}),
    ([{**FULL, 'sentences': 0}], {'pieces': 'sentences', 'fills': ['segmentation'], 'skip_filled_sentences': True}),
    ([FULL, HALF], {'pieces': 'sentences', 'fills': ['segmentation'], 'skip_filled_sentences': True,
                    'documents': ['Text 2']}),
], ids=['one-has-blanks', 'a-field-has-blanks', 'not-set', 'by-documents', 'no-sentences', 'planned-one-has-blanks'])
def test_a_plan_that_works_some_sentence_says_nothing_of_it(docs, args):
    _, out = _planned(docs, args)
    assert out == 'The plan is kept. End now with a one-line reply.'


def test_the_documents_a_plan_names_are_the_ones_counted():
    """A plan naming only the segmented one of two documents works nothing."""
    _, out = _planned([FULL, HALF], {'pieces': 'sentences', 'fills': ['segmentation'],
                                     'skip_filled_sentences': True, 'documents': ['Text 1']})
    assert NOTHING in out


@pytest.mark.parametrize('given, kept', [
    (['segmentation', 'Morph Gloss'], ['segmentation', 'sl-mgloss']),
    (['"Gloss" (word level)', 'translation'], ['sl-gloss', 'sl-trans']),
    (['morph gloss (morpheme)', 'Morph Gloss'], ['sl-mgloss']),
])
def test_plan_work_keeps_what_the_job_fills_by_target_id(given, kept):
    """fills names targets as the planning message lists them (case aside,
    with or without quotes and level), and the plan keeps their ids."""
    ws, out = _planned([HALF], {'pieces': 'sentences', 'fills': given})
    assert out.startswith('The plan is kept.') and ws.plan_work['fills'] == kept


def test_plan_work_refuses_a_target_the_project_does_not_have():
    ws, out = _planned([HALF], {'pieces': 'sentences', 'fills': ['Word class']})
    assert 'fills: not something a job on this project can fill: "Word class".' in out and ws.plan_work is None
    assert 'segmentation, Gloss, Morph Gloss, Translation' in out


def test_no_job_prompt_has_a_semicolon_or_an_em_dash_of_its_own():
    """The job's own paragraphs (the chat's are the chat's)."""
    for text in (shared.JOB_CONTRACT, shared.JOB_FIND_FIRST, shared.JOB_STAGE_NOW, shared.JOB_PLAN_WHAT_WAS_ASKED,
                 shared.JOB_VALUES, shared.JOB_NOTE, shared.JOB_DECIDE_NOW, shared.JOB_PLAN_CONTRACT,
                 prompt.JOB_PLAN_RULES, shared.JOB_PLAN_NOW, shared.JOB_SUMMARY_CONTRACT, prompt._JOB_EXAMPLE_DID,
                 prompt._JOB_EXAMPLE_NOTE, prompt._JOB_PROJECT_WIDE, prompt.JOB_TABLES,
                 # What the planning context reads of plan_work (REV-JG-16).
                 toolkit.PLAN_WORK['function']['description']):
        assert ';' not in text and '—' not in text, text[:80]


def test_a_pieces_first_call_fits_its_budget_with_the_chats_tools():
    """The budgets stay as they were (CONTRACT 1): the first call of a piece
    of five long sentences, with every tool of the chat and the guidelines
    at their cap, is measured with the tokenizer the worker counts with, and
    leaves room under the decide-now mark for the piece's reads."""
    from plaid_agent.core.agent import token_counter
    count = token_counter('openai/glm-5.3-flash')
    ws = JobWorkspace(FakeClient(), _project())
    tools = toolkit.job_piece_tools(ws)
    system = _job_prompt() + 'x ' * (limits.JOB_GUIDELINES_MAX_CHARS // 2)
    message = ('w ' * 300 + '\n') * (limits.JOB_STRETCH_SENTENCES + limits.JOB_CONTEXT_SENTENCES)
    first = count([{'role': 'system', 'content': system}, {'role': 'user', 'content': message}]) + count(tools)
    assert first < limits.JOB_CALL_DECIDE_AT_TOKENS - 10000, first


# --- what a job's prompt names is what its context has (REV-JG-9) ----------------------------

def _names_in(text):
    """Every tool-like name a prompt mentions: a word with an underscore,
    and a name written as a call (``name(``)."""
    import re
    return (set(re.findall(r'\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b', text))
            | set(re.findall(r'\b([a-z_][a-z0-9_]*)\(', text)))


@pytest.mark.parametrize('mode', [JobWorkspace.PIECE, JobWorkspace.PLAN])
def test_every_tool_and_function_a_job_prompt_names_is_one_its_context_has(monkeypatch, mode):
    """Every tool a job's prompt names is in that context's tool list (or is
    an argument of one), and every function it shows code calling is one
    the context's code is lent, the code section included as where the
    sandbox runs. A small model reaches for what its prompt names."""
    from plaid_agent.core import sandbox
    from plaid_agent.igt import sandbox as igt_sandbox
    monkeypatch.setattr(sandbox, 'available', lambda: None)
    project = _project()
    ws = JobWorkspace(FakeClient(), project, mode=mode)
    if mode == JobWorkspace.PIECE:
        text, tools = prompt.build_job_prompt(project), toolkit.job_piece_tools(ws)
    else:
        text, tools = prompt.build_plan_prompt(project), toolkit.job_plan_tools(ws)
    assert 'Running code:' in text
    offered = {t['function']['name'] for t in tools}
    arguments = {a for t in tools for a in (t['function'].get('parameters') or {}).get('properties') or {}}
    lent = set(igt_sandbox.api(ws))
    stray = sorted(n for n in _names_in(text) if n not in offered | arguments | lent)
    assert not stray, f'the {mode} prompt names what its context does not have: {stray}'


def test_the_planning_prompt_says_its_code_stages_nothing(monkeypatch):
    from plaid_agent.core import sandbox
    monkeypatch.setattr(sandbox, 'available', lambda: None)
    text = prompt.build_plan_prompt(_project())
    assert 'plan(' not in text and 'stages nothing' in text


def test_the_contract_says_a_job_applies_what_it_plans_but_project_setup():
    """BRIEF-JH item 7: what is staged is applied when the piece ends,
    whoever wrote what it changes, deletions included, and project setup is
    listed for a person, as is everything else not applied (REV-JH-5, -7).
    The lines that keep a piece to what the instructions ask stay, and the
    whole is no longer than JH's 121 words."""
    text = _job_prompt()
    contract = shared.JOB_CONTRACT
    assert 'is applied by the job when you end, whoever wrote what it changes' in contract
    assert 'deletions' in contract and 'unverified machine proposal' in contract
    # REV-JH-5 and -7: everything listed and not applied, named.
    assert 'Listed in the report, not applied: project setup' in contract
    for listed in ("changes outside your piece's documents", 'confirmations', 'document restores',
                   'corpus-wide rules', 'renaming, merging or deleting entries unless the starter maintains'):
        assert listed in contract, listed
    assert 'stage what the instructions ask for, and nothing more' in contract
    assert 'fills something empty' not in text and 'not written' not in contract
    assert 'DO WHAT THE INSTRUCTIONS ASK' in text and 'WHAT THE INSTRUCTIONS STATE WINS' in text
    assert len(contract.split()) <= 121, len(contract.split())
    assert ';' not in contract and '—' not in contract


@pytest.mark.parametrize('edits_text', [False, True])
def test_set_analysis_for_form_is_said_to_apply_in_its_own_document(edits_text):
    """REV-DAY-S-2: set_analysis_for_form stages a change at every
    occurrence, applied in the piece's own document: the prompt does not
    list it among the tools that stage a rule a job never applies."""
    text = prompt.build_job_prompt(_project(), edits_text=edits_text)
    rule = next(line for line in text.split('\n- ') if 'stages a rule' in line)
    head = rule.split('stages a rule')[0]
    assert 'set_analysis_for_form' not in head, rule
    assert ('respell_all' in head) is edits_text
    assert "set_analysis_for_form stages a change at every occurrence: those in your piece's document are applied, " \
           'the others listed as proposed changes.' in rule.replace('\n', ' ')


#: Plain words of the project's shape that are also tool names: the
#: tagsets' lead line and the guidelines' heading.
SHAPE_WORDS = {'guidelines', 'tagsets'}


@pytest.mark.parametrize('fills', [('segmentation', 'sl-mgloss'), ('sl-gloss',), (), ('segmentation',),
                                   ('segmentation', 'sl-trans')], ids=['glossing', 'field', 'none', 'segmentation',
                                                                      'segmentation-translation'])
@pytest.mark.parametrize('edits_text', [False, True])
def test_a_sentences_piece_is_told_of_no_tool_it_is_not_offered(fills, edits_text):
    """REV-DAY-P-8: the sentences prompt, every tool description and the
    help a sentences piece reads name no tool it is not offered, one-word
    names included (search, worklist, concordance), whatever its plan fills."""
    import json
    import re
    from plaid_agent.igt import targets as tg
    project = _project()
    fill = [t for t in tg.fillable(project) if t.id in fills]
    ws = JobWorkspace(FakeClient(), project)
    ws.in_sentences, ws.fills, ws.edits_text = True, fill, edits_text
    tools = toolkit.job_piece_tools(ws)
    offered = {t['function']['name'] for t in tools}
    arguments = {a for t in tools for a in (t['function'].get('parameters') or {}).get('properties') or {}}
    names = {t['function']['name'] for t in toolkit.TOOLS}

    def stray(text):
        return sorted(set(re.findall(r'\b([a-z_][a-z0-9_]*)\b', text)) & names - offered - arguments - SHAPE_WORDS)
    assert not stray(prompt.build_job_prompt(project, sentences=True, edits_text=edits_text, targets=fill))
    assert not stray(json.dumps(tools))
    if 'analyze_sentence' in offered:
        help_text = toolkit.job_piece_call(ws, 'analyze_sentence', {'help': True})
        assert not [n for n in stray(help_text) if '_' in n], help_text


def test_the_set_field_line_says_set_analysis_as_its_description_does():
    """REV-DAY-P-9: one rule stated one way."""
    text = _job_prompt()
    line = next(b for b in text.split('\n- ') if b.startswith('set_field changes one field value'))
    assert 'only the values that differ are' in line and 'never to change a single gloss' not in line


@pytest.mark.parametrize('fills, said, unsaid', [
    (('segmentation',), ['Segment each word with set_analysis', 'the instructions said to segment the words nobody '
                         'analysed.', 'Segmented s6. Left s7.w2, a name nobody has analysed.'],
     ['gloss', 'Gloss', 'analyze_sentence', 'translat']),
    (('segmentation', 'sl-gloss'), ['Segment each word with set_analysis'], ['analyze_sentence', 'translat']),
    (('segmentation', 'sl-mgloss'), ['the instructions said to segment and gloss the words nobody analysed.',
                                     'Glossed s6. Left s7.w2', 'analyze_sentence'], ['translat']),
    (('segmentation', 'sl-trans'), ['segment the words nobody analysed and to translate empty translations',
                                    'set the translation of s7', 'Segmented s6 and translated s7.'],
     ['analyze_sentence', 'Glossed']),
    (('segmentation', 'sl-mgloss', 'sl-trans'), ['segment and gloss the words nobody analysed and to translate'],
     []),
], ids=['segmentation', 'with-a-word-field', 'glossing', 'translating', 'glossing-and-translating'])
def test_a_segmenting_piece_is_told_its_task_by_what_its_plan_fills(fills, said, unsaid):
    """REV-DF-D-10: a job that segments and does not gloss gets no glossing
    example and no glossing-shaped line (analyze_sentence takes a gloss for
    every word, so it segments with set_analysis). One prompt, its task
    lines and worked piece built from the targets."""
    from plaid_agent.igt import targets as tg
    project = _project()
    fill = [t for t in tg.fillable(project) if t.id in fills]
    text = prompt.build_job_prompt(project, sentences=True, targets=fill)
    piece = text[text.index('A WHOLE PIECE, FOR EXAMPLE.'):] if 'A WHOLE PIECE' in text else text
    read_first = next(b for b in text.split('\n- ') if b.startswith('The message says what is empty'))
    for x in said:
        assert x in text, (x, text)
    for x in unsaid:
        assert x not in piece and x not in read_first, (x, piece, read_first)


@pytest.mark.parametrize('context', ['document', 'planning'])
def test_no_description_a_document_piece_or_the_planner_reads_names_a_tool_it_is_not_offered(context):
    """REV-DF-D-18: recent_changes named restore_document to a document
    piece that may not edit the text, lexicon_entry named senses to the
    planning context. Every description is read less what names a tool the
    context is not offered (underscore names: a plain word may be data)."""
    import json
    import re
    ws = JobWorkspace(FakeClient(), _project(), mode=JobWorkspace.PLAN if context == 'planning' else JobWorkspace.PIECE)
    ws.job_documents = [{'id': 'd1', 'name': 'Text 1'}]
    tools = toolkit.job_plan_tools(ws) if context == 'planning' else toolkit.job_piece_tools(ws)
    offered = {t['function']['name'] for t in tools}
    arguments = {a for t in tools for a in (t['function'].get('parameters') or {}).get('properties') or {}}
    names = {t['function']['name'] for t in toolkit.TOOLS} | {'restore_document', 'senses'}
    stray = sorted(set(re.findall(r'\b([a-z]+_[a-z0-9_]+)\b', json.dumps(tools))) & names - offered - arguments)
    assert not stray, stray
