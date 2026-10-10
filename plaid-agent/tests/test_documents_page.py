"""list_documents in every app: a pattern matches a name as the server's
search does (literal, case-insensitive, in NFC on both sides), and a page
past the end says so (H15-REVIEW-4)."""
import unicodedata

from plaid_agent.core.tools import documents_page
from plaid_agent.core.trace import SHARED_DESCRIBE


class Ws:
    def __init__(self, names):
        self.docs = [{'id': f'd{i}', 'name': n} for i, n in enumerate(names)]

    def documents(self):
        return self.docs

    def note_read(self, *args, **kwargs):
        pass


def nfd(s):
    return unicodedata.normalize('NFD', s)


def test_a_decomposed_pattern_finds_a_composed_name_and_the_reverse():
    ws = Ws(['Café story', nfd('Crème brûlée'), 'Other'])
    assert '"Café story"' in documents_page(ws, nfd('café'.replace('é', 'é')))
    assert '"Café story"' in documents_page(ws, nfd('café'))
    assert 'brûlée' in unicodedata.normalize('NFC', documents_page(ws, 'CRÈME'))


def test_case_folds_as_the_server_does_not_as_python_does():
    ws = Ws(['Straße'])
    assert documents_page(ws, 'STRASSE') == 'No documents matched.'
    assert '"Straße"' in documents_page(ws, 'STRASSE'.replace('SS', 'ß').lower())


def test_a_page_past_the_end_says_so():
    ws = Ws([f'Text {i}' for i in range(12)])
    out = documents_page(ws, None, 10, 20)
    assert out == '12 documents, none from 21.'


def test_a_comment_on_the_document_says_so_in_the_trace():
    assert SHARED_DESCRIBE['add_comment']({'document': 'Story'}).startswith('Planned a comment on the document in ')
    assert SHARED_DESCRIBE['add_comment']({'ref': 's3'}) == 'Planned a comment on s3'
