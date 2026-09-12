"""The core must not know what any app annotates.

The harness is shared by every app's assistant, and the way it stops being
shared is one app's word creeping into it: a key prefix, a default, a phrase
in a docstring that only makes sense for interlinear text. Each of those
compiles and passes every other test, and is found later by the second app
finding it wrong.

So: the app's name does not appear in ``core/`` at all, and the app's own
modules are not importable from it.
"""

import os
import re

CORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'plaid_agent', 'core')

APP_WORDS = re.compile(r'\b(igt|interlinear|morpheme|gloss(?:ed|es|ing)?|lexicon|conllu|deprel|upos)\b', re.I)


def _core_files():
    return sorted(f for f in os.listdir(CORE) if f.endswith('.py'))


def test_the_core_names_no_app():
    """A file here belongs to every app or to none."""
    offences = []
    for name in _core_files():
        with open(os.path.join(CORE, name), encoding='utf-8') as fh:
            for n, line in enumerate(fh, 1):
                found = APP_WORDS.search(line)
                if found:
                    offences.append(f'{name}:{n}: {found.group(0)} in {line.strip()!r}')
    assert not offences, (
        'plaid_agent/core says what an app annotates:\n  ' + '\n  '.join(offences)
        + '\nMove the app\'s word to the app, and give the core a hook or a parameter for it.')


def test_the_core_imports_no_app():
    """An import is the same leak, and the one that actually breaks a build."""
    offences = []
    for name in _core_files():
        with open(os.path.join(CORE, name), encoding='utf-8') as fh:
            for n, line in enumerate(fh, 1):
                if re.search(r'^\s*(from|import)\s+.*\b(plaid_agent\.(igt|ud)|\.\.(igt|ud))\b', line):
                    offences.append(f'{name}:{n}: {line.strip()!r}')
    assert not offences, 'plaid_agent/core imports an app:\n  ' + '\n  '.join(offences)


def test_the_focus_note_names_the_document_and_still_allows_the_corpus():
    """Asked from inside a document, the model is told which one is open, twice
    and by name: a first version mentioned it once and ended by inviting the
    model to read anything else, and it wandered off to another document.

    The scope stays SOFT, so a question about the corpus must still be allowed.
    """
    from plaid_agent.core.service import focus_note

    note = focus_note('Text 1')
    assert note.count('"Text 1"') >= 2
    assert 'read it first' in note
    # The escape has to survive: a comparison question must not be refused.
    assert 'corpus as a whole' in note and 'compare' in note


def test_an_app_with_no_document_view_gets_no_focus_note():
    from plaid_agent.core.service import BaseAssistantService

    assert BaseAssistantService.document_name(None, None, 'any-id') is None


def test_the_lexicon_focus_note_names_the_vocabulary_and_keeps_the_corpus_in_play():
    """The Entries screen docks the assistant too, and what is open there is a
    vocabulary. Same shape as the document note, with one deliberate difference:
    reading the corpus is part of the job rather than the escape, because half
    the useful questions about an entry are answered in the texts.
    """
    from plaid_agent.igt.prompt import lexicon_focus_note

    note = lexicon_focus_note('Verbs')
    assert note.count('"Verbs"') >= 2
    assert 'read it first' in note
    assert 'Reading the corpus' in note
    # The escape is another VOCABULARY, not the corpus.
    assert 'Open another vocabulary only when' in note
    assert 'compare' in note


def _igt_service():
    from plaid_agent.igt.service import AssistantService

    class Project:
        vocabs = [{'id': 'v1', 'name': 'Verbs'}]

    class Ws:
        project = Project()

        class corpus:
            @staticmethod
            def ref_name(_id):
                return 'Text 1'

    return AssistantService.__new__(AssistantService), Ws()


def test_the_kind_picks_the_note_and_documents_are_the_default_case():
    """One `where` with a kind, not a field per surface. Two fields could name
    two places at once and needed a precedence rule between them; one kind
    cannot, which is the whole reason for the shape."""
    svc, ws = _igt_service()
    assert 'vocabulary "Verbs"' in svc.focus_note_for(ws, {'where': {'kind': 'lexicon', 'id': 'v1'}})
    assert '"Text 1"' in svc.focus_note_for(ws, {'where': {'kind': 'document', 'id': 'd1'}})
    assert svc.focus_note_for(ws, {}) is None
    # A vocabulary that is not this project's names NOTHING. The panel said the
    # user is in a vocabulary, so naming a document instead would be a lie
    # about where they are, and silence is the honest answer.
    assert svc.focus_note_for(ws, {'where': {'kind': 'lexicon', 'id': 'nope'}}) is None
    # A kind no app claims is also silence, not a guess.
    assert svc.focus_note_for(ws, {'where': {'kind': 'export', 'id': 'x'}}) is None


def test_the_place_noun_is_the_app_word_for_it():
    """The noun is written in front of the user's own question, so it has to be
    what the app calls the thing on screen."""
    svc, ws = _igt_service()
    assert svc.place(ws, {'kind': 'lexicon', 'id': 'v1'}) == ('vocabulary', 'Verbs')
    assert svc.place(ws, {'kind': 'document', 'id': 'd1'}) == ('document', 'Text 1')
    assert svc.place(ws, None) is None


def test_a_question_is_stamped_with_where_it_was_asked_only_when_that_changed():
    """A thread holds questions asked from several places once the panel stops
    belonging to one screen. Each question keeps its own place, and a thread
    that has not moved carries the stamp once rather than on every turn."""
    from plaid_agent.core.service import stamped

    def user(text):
        return {'role': 'user', 'content': text}

    first = stamped([user('what is here')], ('document', 'Text 1'))
    assert first[0]['content'] == '[Asked from the document "Text 1"]\n\nwhat is here'

    # Same place again: nothing added, and the earlier stamp still stands.
    again = stamped(first + [{'role': 'assistant', 'content': 'ok'}, user('and now')],
                    ('document', 'Text 1'))
    assert again[-1]['content'] == 'and now'

    # Moved: the new place is stamped, which is the fact the model needs.
    moved = stamped(first + [{'role': 'assistant', 'content': 'ok'}, user('and now')],
                    ('document', 'Text 2'))
    assert moved[-1]['content'] == '[Asked from the document "Text 2"]\n\nand now'

    # Back again is a change too: the LAST stamp is what it is compared with.
    back = stamped(moved + [{'role': 'assistant', 'content': 'ok'}, user('again')],
                   ('document', 'Text 1'))
    assert back[-1]['content'] == '[Asked from the document "Text 1"]\n\nagain'

    # The noun counts: the same name in a different kind of place has moved.
    kind = stamped(first + [{'role': 'assistant', 'content': 'ok'}, user('and now')],
                   ('vocabulary', 'Text 1'))
    assert kind[-1]['content'] == '[Asked from the vocabulary "Text 1"]\n\nand now'


def test_nothing_is_stamped_when_there_is_nowhere_to_name():
    """The panel is open on a screen the assistant has no tools for, or on none
    at all. A turn must still run, unstamped."""
    from plaid_agent.core.service import stamped

    msgs = [{'role': 'user', 'content': 'a question'}]
    assert stamped(msgs, None) is msgs
    # Not a user message last (an apply, a malformed record): left alone.
    other = [{'role': 'assistant', 'content': 'hi'}]
    assert stamped(other, ('document', 'Text 1')) is other
    assert stamped([], ('document', 'Text 1')) == []


def test_usage_is_read_off_a_response_and_a_silent_provider_is_not_invented():
    """The counts are the provider's, when it gives them. A provider that says
    nothing leaves the reader with no figure, which is correct: an estimate
    shown in the same place as a measurement reads as a measurement."""
    from plaid_agent.core.agent import usage_of

    class U:
        prompt_tokens = 1200
        completion_tokens = 340

    class Resp:
        usage = U()

    assert usage_of(Resp()) == {'sent': 1200, 'received': 340}

    class NoUsage:
        usage = None

    assert usage_of(NoUsage()) is None
    assert usage_of(object()) is None

    # A provider that counts the prompt but not the reply still answers the
    # question the tracker asks, so it is kept with a zero rather than dropped.
    class Half:
        class usage:
            prompt_tokens = 900
            completion_tokens = None

    assert usage_of(Half()) == {'sent': 900, 'received': 0}

    # A prompt count that is not a number is no count at all.
    class Bad:
        class usage:
            prompt_tokens = 'lots'
            completion_tokens = 1

    assert usage_of(Bad()) is None


def test_an_unknown_model_has_no_window_rather_than_a_guessed_one():
    """An operator can point the service at anything litellm can reach,
    including a proxy litellm has no record of."""
    from plaid_agent.core.agent import context_window

    assert context_window('gpt-4o-mini') is not None
    assert context_window('some-proxy/model-nobody-has-heard-of') is None


def test_the_reply_carries_its_usage_only_when_there_is_one():
    from plaid_agent.core.conversation import assistant_item

    with_usage = assistant_item('hi', None, [], [], '', 'm', {'sent': 10, 'received': 2, 'window': 100})
    assert with_usage['usage'] == {'sent': 10, 'received': 2, 'window': 100}
    # No key at all rather than a null, so a reader cannot mistake "not
    # reported" for "zero".
    assert 'usage' not in assistant_item('hi', None, [], [], '', 'm')
    assert 'usage' not in assistant_item('hi', None, [], [], '', 'm', None)
