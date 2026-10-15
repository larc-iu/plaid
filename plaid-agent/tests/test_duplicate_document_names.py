"""Two documents may share a name (nothing forbids it, and imports produce
it). Every read names such a document in a reference by its id, quoted as a
name is, so the reference can be read back and cited (see
test_tools.test_documents_sharing_a_name_are_printed_and_cited_by_id). Where a
read names a document in prose, it names it as a plan's line does: the name,
with the id beside it."""

from fixtures import document_raw
from test_tools import FakeClient, call_tool, fake_ws


def _ws(nfd_in=()):
    docs = {}
    for i, name in enumerate(['Text 1', 'Text 1', 'Text 2'], 1):
        raw = document_raw()
        raw['id'], raw['name'] = f'd{i}', name
        if raw['id'] in nfd_in:
            text = raw['text_layers'][0]['text']
            text['body'] = text['body'] + ' café'
        docs[raw['id']] = raw
    return fake_ws(FakeClient(documents=docs))


def test_analyses_of_and_check_integrity_print_references_as_search_does():
    w = _ws()
    search = call_tool(w, 'search', {'pattern': 'gam'})
    analyses = call_tool(w, 'analyses_of', {'form': 'gam'})
    integrity = call_tool(w, 'check_integrity', {})
    for ref in ('"d1" s1.w2', '"d2" s1.w2', '"Text 2" s1.w2'):
        assert ref in search and ref in analyses, (ref, analyses)
    assert '("d1" s1, "d2" s1, "Text 2" s1)' in integrity


def test_check_integrity_names_a_document_not_in_nfc_with_its_id_where_the_name_is_shared():
    out = call_tool(_ws(nfd_in=('d2', 'd3')), 'check_integrity', {})
    assert 'precomposed characters exist): "Text 1" (d2), "Text 2"' in out, out
