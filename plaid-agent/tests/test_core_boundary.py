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


def test_the_focus_note_names_the_document_and_fences_nothing():
    """Asked from inside a document, the model is told which one is open. It is
    a default, not a fence: the note must say the rest of the project is still
    readable, or a question that needs the corpus gets refused."""
    from plaid_agent.core.service import focus_note

    note = focus_note('Text 1')
    assert '"Text 1"' in note
    # The whole point of the soft scope.
    assert 'anything else in the project' in note
    # Nothing in it may read as a restriction.
    assert not any(w in note.lower() for w in ('only', 'do not read', 'must not', 'restrict'))


def test_an_app_with_no_document_view_gets_no_focus_note():
    from plaid_agent.core.service import BaseAssistantService

    assert BaseAssistantService.document_name(None, None, 'any-id') is None
