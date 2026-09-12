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


def test_a_lexicon_id_beats_a_document_id_and_falls_back_to_it():
    """The hook is the app's, and it has to keep answering for documents."""
    from plaid_agent.igt.service import AssistantService

    class Project:
        vocabs = [{'id': 'v1', 'name': 'Verbs'}]

    class Ws:
        project = Project()

        class corpus:
            @staticmethod
            def ref_name(_id):
                return 'Text 1'

    svc = AssistantService.__new__(AssistantService)
    ws = Ws()
    assert 'vocabulary "Verbs"' in svc.focus_note_for(ws, {'lexicon_id': 'v1'})
    assert '"Text 1"' in svc.focus_note_for(ws, {'document_id': 'd1'})
    # A vocabulary that is not this project's names nothing, and the document
    # underneath still answers.
    assert '"Text 1"' in svc.focus_note_for(ws, {'lexicon_id': 'nope', 'document_id': 'd1'})
    assert svc.focus_note_for(ws, {}) is None
