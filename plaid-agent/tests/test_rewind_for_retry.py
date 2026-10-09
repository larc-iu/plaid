"""Sending the user's last message again, made by the service now that it is
the only writer of the record (``rewind_for_retry``). The cases are plaid-ui's
resume.test.js, where the rewind lived before (design/SINGLE-WRITER.md)."""

import re

from plaid_agent.core.conversation import answered_last, rewind_for_retry

ISO_MS = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')


def conv(messages, display):
    return {'messages': messages, 'display': display}


def test_drops_the_question_of_a_lost_turn_from_the_transcript_and_says_it_got_no_answer():
    c = conv([{'role': 'user', 'content': 'first'}, {'role': 'assistant', 'content': 'ok'},
              {'role': 'user', 'content': 'second'}],
             [{'kind': 'user', 'text': 'first'}, {'kind': 'assistant', 'text': 'ok'},
              {'kind': 'user', 'text': 'second'}])
    out, asked = rewind_for_retry(c)
    assert asked['text'] == 'second'
    assert len(out['messages']) == 2
    assert out['display'][:3] == c['display'] and len(out['display']) == 4
    line = out['display'][3]
    assert line['kind'] == 'error' and line['lost'] is True
    assert line['text'] == 'No answer came back for this message.' and ISO_MS.match(line['created_at'])


def test_leaves_the_transcript_alone_for_a_failed_turn_whose_question_was_dropped():
    c = conv([{'role': 'user', 'content': 'first'}, {'role': 'assistant', 'content': 'ok'}],
             [{'kind': 'user', 'text': 'first'}, {'kind': 'assistant', 'text': 'ok'},
              {'kind': 'user', 'text': 'second'}, {'kind': 'error', 'text': 'could not answer'}])
    out, asked = rewind_for_retry(c)
    assert asked['text'] == 'second' and len(out['messages']) == 2 and out['display'] == c['display']


def test_never_sends_again_a_question_with_an_answer_after_it():
    c = conv([{'role': 'user', 'content': 'first'}, {'role': 'assistant', 'content': 'ok'},
              {'role': 'user', 'content': '[Asked from the document "Doc1"]\n\nWhat is s4?'},
              {'role': 'assistant', 'content': 'play-01'}],
             [{'kind': 'user', 'text': 'first'}, {'kind': 'assistant', 'text': 'ok'},
              {'kind': 'user', 'text': 'What is s4?'}, {'kind': 'assistant', 'text': 'play-01'},
              {'kind': 'error', 'text': 'The conversation has no message to answer'}])
    assert answered_last(c['display']) is True
    assert rewind_for_retry(c) is None
    assert answered_last(c['display'][:3]) is False


def test_takes_a_failed_turns_stamped_question_off_before_sending_it_again():
    c = conv([{'role': 'user', 'content': 'first'}, {'role': 'assistant', 'content': 'ok'},
              {'role': 'user', 'content': '[Asked from the document "Doc1"]\n\nsecond'}],
             [{'kind': 'user', 'text': 'first'}, {'kind': 'assistant', 'text': 'ok'},
              {'kind': 'user', 'text': 'second'}, {'kind': 'error', 'text': 'The model could not answer.'}])
    out, _ = rewind_for_retry(c)
    assert out['messages'] == c['messages'][:2] and out['display'] == c['display']


def test_takes_the_question_off_and_keeps_a_plan_note_written_after_it():
    note = 'The user discarded the plan.'
    c = conv([{'role': 'user', 'content': 'first'}, {'role': 'assistant', 'content': 'Planned.'},
              {'role': 'user', 'content': '[Asked from the document "Doc1"]\n\nsecond'},
              {'role': 'user', 'content': note}],
             [{'kind': 'user', 'text': 'first'}, {'kind': 'assistant', 'text': 'Planned.'},
              {'kind': 'user', 'text': 'second'}, {'kind': 'error', 'text': 'The model could not answer.'}])
    out, _ = rewind_for_retry(c)
    assert out['messages'] == [c['messages'][0], c['messages'][1], c['messages'][3]]


def test_keeps_an_earlier_answered_copy_of_the_same_question():
    c = conv([{'role': 'user', 'content': 'again?'}, {'role': 'assistant', 'content': 'ok'}],
             [{'kind': 'user', 'text': 'again?'}, {'kind': 'assistant', 'text': 'ok'},
              {'kind': 'user', 'text': 'again?'}, {'kind': 'error', 'text': 'could not answer'}])
    assert rewind_for_retry(c)[0]['messages'] == c['messages']


def test_a_first_turn_that_failed_leaves_an_empty_transcript():
    c = conv([], [{'kind': 'user', 'text': 'hi'}, {'kind': 'error', 'text': 'boom'}])
    out, asked = rewind_for_retry(c)
    assert asked['text'] == 'hi' and out['messages'] == [] and out['display'] == c['display']


def test_nothing_to_send_again():
    assert rewind_for_retry(conv([], [])) is None


def test_sends_the_files_and_projects_and_place_the_message_carried():
    files = [{'id': 'f1', 'name': 'wordlist.csv', 'bytes': 24, 'lines': 2, 'chunks': 1}]
    projects = [{'id': 'pB', 'name': 'B'}]
    where = {'kind': 'document', 'id': 'd1', 'name': 'Text 1'}
    c = conv([], [{'kind': 'user', 'text': 'count these', 'files': files, 'projects': projects,
                   'where': where}, {'kind': 'error', 'text': 'x'}])
    out, asked = rewind_for_retry(c)
    assert asked == {'text': 'count these', 'files': files, 'projects': projects, 'where': where}
    assert out['display'] == c['display']
