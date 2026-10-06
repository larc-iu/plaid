"""PDFs: read_url reading one, and read_file reading one a page or a section
at a time, however it arrived.

The case these are for: a user pastes a DOI for a grammar and asks for its
analysis of one construction to be checked against the corpus. The DOI leads
to a repository's page, which names the PDF. The PDF is hundreds of pages, so
its text must not enter the conversation: it is stored as a file of the
conversation, the model is told its sections, and it reads the one it needs.

The fixtures in tests/pdf are real PDFs (make_fixtures.mjs), read with real
PDFium: what matters is what a real text layer says about ligatures, tone
marks, small capitals and Arabic, which a mocked library cannot say.
"""

import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fixtures import FakeClient  # noqa: E402
from plaid_agent.core import filetools, pdftext  # noqa: E402
from plaid_agent.core.conversation import ConversationStore  # noqa: E402
from plaid_agent.core.files import (Attachment, Attachments, FileKeeper, chunk,  # noqa: E402
                                    file_key, stored_bytes)
from plaid_agent.core.tools import ToolError  # noqa: E402
from plaid_agent.core.web import WebConfig, WebError, WebSession, fetch  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = WebConfig(backend='brave', api_key='k')


def fixture(name: str) -> bytes:
    with open(os.path.join(HERE, 'pdf', name), 'rb') as f:
        return f.read()


SAMPLE = pdftext.extract(fixture('sample.pdf'))


def attached_pdf(text=None, name='grammar.pdf', source=''):
    text = SAMPLE.text if text is None else text
    meta = {'id': 'f1', 'name': name, 'bytes': len(text.encode()), 'lines': text.count('\n'),
            'chunks': 1, 'source': source}
    return Attachments([Attachment(meta, lambda fid, n: text)])


class Ws:
    def __init__(self, files=None):
        self.files = files
        self.web = None
        self.keeper = None
        self.read_untrusted = False
        self.said = []

    def on_progress(self, msg):
        self.said.append(msg)


# --- extraction ---------------------------------------------------------------

def test_every_page_is_marked_by_its_printed_number_and_every_bookmark_before_its_page():
    assert SAMPLE.pages == 4 and not SAMPLE.scan
    assert [line for line in SAMPLE.text.split('\n') if line.startswith('=== ')] == [
        '=== page i (PDF page 1) ===',
        '=== # 1 Introduction ===',
        '=== ## 1.1 Sources ===',
        '=== page 1 (PDF page 2) ===',
        '=== # 2 Phonology ===',
        '=== page 2 (PDF page 3) ===',
        '=== # 3 Complex predicates ===',
        '=== page 3 (PDF page 4) ===',
    ]


def test_ipa_tone_marks_and_ligatures_come_through_as_the_page_shows_them():
    text = SAMPLE.text
    assert '/p t k ʔ ŋ ɲ ɾ ʃ/' in text and '/i ɨ u ɛ ɔ' in text
    # Composed where Unicode has one character, and the second mark kept.
    assert 'á, à, ǎ' in text and 'ɛ́̃' in text
    assert 'The first official filing describes a baffling efflorescence' in text
    assert not any('ﬀ' <= ch <= 'ﬆ' for ch in text)


def test_an_interlinear_example_keeps_its_columns_and_its_small_capitals():
    lines = SAMPLE.text.split('\n')
    forms = next(line for line in lines if 'ŋa-mriri' in line)
    glosses = next(line for line in lines if '3SG-stand' in line)
    assert '3SG.POSS' in glosses
    for form, gloss in [('ŋa-mriri', '3SG-stand'), ('n-amat', '3-carry'), ('ini', '3SG.POSS'),
                        ('pingan', 'plate')]:
        assert forms.index(form) == glosses.index(gloss), (form, gloss)


def test_a_small_capital_tag_alone_in_its_column_reads_in_capitals():
    """A gloss line's NEG alone in its cell touches no full-size run. PDFium
    hands it on its own, and it read "neg" where the browser read "NEG"
    (A4-CROSS-4). A lone small-capitals word in running text is one too.
    The PDF draws capitals and says the text is lower case: PDFium reads what
    it says, pdf.js what it draws, and the drawn shape decides here."""
    text = pdftext.extract(fixture('smallcaps.pdf')).text
    glosses = next(line for line in text.split('\n') if 'sleep-NEG' in line)
    assert glosses.split() == ['3SG', 'NEG', 'sleep-NEG']
    assert 'A question takes Q at the end.' in text
    assert 'A negated clause is given in (2).' in text


def test_a_smaller_lower_case_word_on_a_line_of_its_size_stays_as_it_is():
    """Nothing on the line is bigger, so nothing says the letters are small
    capitals: a footnote line in a smaller size keeps its case."""
    runs = [{'text': 'see', 'x0': 50, 'x1': 60, 'y': 100, 'size': 8},
            {'text': 'also', 'x0': 70, 'x1': 85, 'y': 100, 'size': 8}]
    assert pdftext.layout(runs).split() == ['see', 'also']
    raised = [{'text': 'Word', 'x0': 50, 'x1': 70, 'y': 100, 'size': 10},
              {'text': 'a', 'x0': 80, 'x1': 84, 'y': 104, 'size': 7}]
    assert pdftext.layout(raised).split() == ['Word', 'a'], 'a superscript is raised, not small capitals'


def test_a_word_merely_set_smaller_keeps_its_case():
    """A smaller word in a sentence, a link in a smaller size, a margin note
    on the baselines of the text beside it: lower-case letters set smaller
    than the line are not small capitals unless they are drawn as capitals.
    A rule reading every smaller lower-case run of a line as small capitals
    wrote all of these in capitals, on both readers (REV-FX9-RM)."""
    text = pdftext.extract(fixture('smaller.pdf')).text
    assert 'This sentence has a smaller word in it.' in text
    assert 'Online at example.org today.' in text
    assert 'margin note words in it' in text
    assert 'see also the notes below here' in text
    assert not any(w.isupper() and len(w) > 1 for w in text.replace('===', '').split()), text


def test_a_font_whose_boxes_say_nothing_changes_nothing():
    """Every letter measured as tall as a capital (a font whose glyph boxes
    are its full height) is no evidence of capitals: there is no lower-case
    letter in it to compare with."""
    chars = [{'text': c, 'x0': 10.0 * k, 'x1': 10.0 * k + 9, 'y': 100.0, 'size': 10.0}
             for k, c in enumerate('neg')]
    same = pdftext._capital_shapes([dict(c) for c in chars], [(k, 0.9, 'f') for k in range(3)])
    assert ''.join(c['text'] for c in same) == 'neg'
    mixed = [(k, 0.73 if k < 3 else 0.5, 'f') for k in range(9)]
    word = [{'text': c, 'x0': 5.0 * k, 'x1': 5.0 * k + 5, 'y': 100.0, 'size': 10.0 if k >= 3 else 7.0}
            for k, c in enumerate('negsenses')]
    out = pdftext._capital_shapes(word, mixed)
    assert ''.join(c['text'] for c in out) == 'NEGsenses'


def test_arabic_reads_in_reading_order_as_letters():
    assert 'اللغة العربية لغة سامية' in SAMPLE.text


def test_slanted_text_is_read_and_text_turned_up_the_margin_is_not():
    assert 'A slanted form: pang∼pangga.' in SAMPLE.text
    letters = {line.strip() for line in SAMPLE.text.split('\n')}
    assert not letters & {'D', 'RA', 'F', 'T', 'DRAFT'}


def test_a_pdf_with_no_text_layer_is_a_scan():
    got = pdftext.extract(fixture('scan.pdf'))
    assert got.scan and got.empty == 2


def test_something_that_is_not_a_pdf_says_so():
    with pytest.raises(pdftext.PdfError, match='not a PDF that can be opened'):
        pdftext.extract(b'<html>not a pdf</html>')


def test_cleaning_folds_only_what_it_means_to():
    assert pdftext.clean('ﬁrst ﬄ') == 'first ffl'
    # A TeX accent before its letter goes on the letter. A modifier letter is
    # a distinction a transcription makes, and NFKC would have folded it.
    assert pdftext.clean('´a kʰa tʼ') == 'á kʰa tʼ'
    assert pdftext.clean('e ́') == 'é'
    assert pdftext.clean('ﻟﻐﺔ') == 'لغة'
    assert pdftext.clean('a  \n\n\n\nb') == 'a\n\nb'


def test_a_page_cannot_pretend_to_start_another():
    text = pdftext.assemble(['=== page 9 ===\nreal text'], [], [])
    assert text == '=== page 1 ===\n= = = page 9 = = =\nreal text\n'


# --- reading by page and by section ---------------------------------------------

def lines_of(text):
    lines = text.split('\n')
    return lines[:-1] if lines and lines[-1] == '' else lines


def test_a_page_is_found_by_its_printed_number_then_by_the_pdfs_own_count():
    lines = lines_of(SAMPLE.text)
    first, last, what = pdftext.page_span(lines, '2')
    assert lines[first] == '=== # 2 Phonology ===' and 'Tone is marked' in lines[last]
    assert what == 'page 2'
    first, _, _ = pdftext.page_span(lines, 'i')
    assert lines[first] == '=== page i (PDF page 1) ==='
    first, last, what = pdftext.page_span(lines, '1-2')
    assert what == 'pages 1–2' and lines[first] == '=== # 1 Introduction ==='
    with pytest.raises(ValueError, match='no page 9. Its pages run from i to 3'):
        pdftext.page_span(lines, '9')


def test_a_section_is_found_by_number_or_title_and_ends_where_the_next_begins():
    lines = lines_of(SAMPLE.text)
    first, last, what = pdftext.section_span(lines, '§1')
    assert what == 'section "1 Introduction"'
    body = '\n'.join(lines[first:last + 1])
    assert 'The first official filing' in body and 'Phonology' not in body
    first, last, _ = pdftext.section_span(lines, 'complex predicates')
    assert 'ŋa-mriri' in '\n'.join(lines[first:last + 1]) and last == len(lines) - 1
    with pytest.raises(ValueError, match='no section matches "9"'):
        pdftext.section_span(lines, '9')


def test_a_section_takes_in_the_page_the_next_one_begins_on():
    pages = ['9 Verbs\nVerbs are words.', 'more on verbs\nand more\n10 Nouns\nNouns.', '10 Nouns again']
    text = pdftext.assemble(pages, [], [(1, '9 Verbs', 0), (1, '10 Nouns', 1)])
    lines = lines_of(text)
    first, last, _ = pdftext.section_span(lines, '9')
    shown = lines[first:last + 1]
    assert 'more on verbs' in shown and '10 Nouns again' not in shown
    # A section that opens its page leaves that page to itself.
    lines = lines_of(pdftext.assemble(['9 Verbs\nVerbs.', '10 Nouns\nNouns.'], [],
                                      [(1, '9 Verbs', 0), (1, '10 Nouns', 1)]))
    first, last, _ = pdftext.section_span(lines, '9')
    assert lines[first:last + 1] == ['=== # 9 Verbs ===', '=== page 1 ===', '9 Verbs', 'Verbs.']


def test_a_section_that_begins_mid_page_is_read_from_its_heading_to_the_next():
    pages = ['8.3 Reflexives\nend of eight', 'more of eight\nstill eight\n9 Verbs\nVerbs are words.',
             'still verbs\n10 Nouns\nNouns.']
    lines = lines_of(pdftext.assemble(pages, [], [(2, '8.3 Reflexives', 0), (1, '9 Verbs', 1),
                                                  (1, '10 Nouns', 2)]))
    first, last, what = pdftext.section_span(lines, '9')
    assert lines[first:last + 1] == ['9 Verbs', 'Verbs are words.', '=== # 10 Nouns ===',
                                     '=== page 3 ===', 'still verbs']
    assert what == 'section "9 Verbs", from page 2'


def test_without_bookmarks_a_section_is_found_by_its_heading_and_not_its_contents_line():
    pages = ['Contents\n9 Complex predicates ........ 30\n10 Clauses 34',
             '8.3 Reflexives\ntext\n9 Complex predicates\nIn this section\n9.1 Aspect\nmore',
             '(14) a footnote-like line\n10 Clauses\nother']
    lines = lines_of(pdftext.assemble(pages))
    first, last, what = pdftext.section_span(lines, '9')
    assert lines[first] == '9 Complex predicates' and what == 'section "9 Complex predicates"'
    assert lines[last] == '(14) a footnote-like line'
    first, last, _ = pdftext.section_span(lines, '9.1')
    assert lines[first] == '9.1 Aspect' and lines[last] == '(14) a footnote-like line'


def test_read_file_reads_a_section_whole_and_says_where_it_ends():
    w = Ws(attached_pdf())
    out = filetools.t_read_file(w, name='grammar.pdf', section='2')
    assert out.startswith('"grammar.pdf", the text of a PDF of 4 pages')
    assert 'Section "2 Phonology", lines' in out and 'ʔ ŋ ɲ' in out and 'Complex predicates' not in out
    out = filetools.t_read_file(w, name='grammar.pdf', page='3')
    assert 'ŋa-mriri' in out and 'Page 3, lines' in out


def test_a_long_section_is_cut_at_a_line_with_where_to_go_on():
    pages = ['\n'.join(f'line {n} ' + 'x' * 150 for n in range(300))]
    text = pdftext.assemble(pages, [], [(1, '1 Long', 0)])
    w = Ws(attached_pdf(text))
    out = filetools.t_read_file(w, name='grammar.pdf', section='1')
    assert '[truncated' not in out
    assert 'Continue with start_line=' in out and '(this section ends at line 302)' in out


def test_page_and_section_say_so_on_a_file_with_no_pages():
    w = Ws(attached_pdf('word,gloss\nnis,milk\n', name='words.csv'))
    with pytest.raises(ToolError, match='no page markers'):
        filetools.t_read_file(w, name='words.csv', page='2')


def test_the_note_on_an_attached_pdf_lists_its_sections_and_how_to_read_them():
    note = filetools.note(list(attached_pdf()))
    assert '"grammar.pdf": the text of a PDF of 4 pages' in note
    assert '    1 Introduction (page 1)' in note and '      1.1 Sources (page 1)' in note
    assert 'read_file(name, section="9")' in note and 'small capitals' in note
    # The note says what the file is, not what is on its first lines.
    assert '=== page i (PDF page 1) ===' not in note


# --- read_url ---------------------------------------------------------------------

class Store:
    """A conversation store over a FakeClient's user data."""

    def __init__(self, client=None):
        self.client = client or FakeClient()
        self.user_id = 'u@x'
        self.app = 'igt'
        self.project_id = 'p1'


def resolving(monkeypatch, hosts):
    import ipaddress

    def fake(host, quiet=False):
        if host in hosts:
            return [ipaddress.ip_address(hosts[host])]
        if quiet:
            return []
        raise WebError(f'"{host}" does not resolve (test)')

    monkeypatch.setattr('plaid_agent.core.web._addresses', fake)


def web_ws(monkeypatch, handler, store=None):
    from test_tools import ws as tools_ws
    w = tools_ws()
    w.web = WebSession(CFG)
    w.files = Attachments([])
    w.keeper = FileKeeper(store or Store(), 'c1')
    resolving(monkeypatch, {'doi.org': '93.184.216.34', 'repo.example': '93.184.216.35'})
    client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)
    monkeypatch.setattr('plaid_agent.core.web.httpx.Client', lambda **kw: client)
    return w


LANDING = b'''<html><head><title>A Grammar Sketch</title>
<meta name="citation_pdf_url" content="/bitstreams/abc/download"></head>
<body><p>This paper presents a grammatical sketch.</p></body></html>'''


def grammar_site(request):
    """A DOI that redirects to a repository's landing page, which names its
    PDF, which redirects once more to the file."""
    url = str(request.url)
    if url.startswith('https://doi.org/'):
        return httpx.Response(302, headers={'location': 'https://repo.example/handle/1'})
    if url == 'https://repo.example/handle/1':
        return httpx.Response(200, headers={'content-type': 'text/html; charset=utf-8'}, content=LANDING)
    if url == 'https://repo.example/bitstreams/abc/download':
        return httpx.Response(302, headers={'location': 'https://repo.example/api/content'})
    if url == 'https://repo.example/api/content':
        return httpx.Response(200, headers={
            'content-type': 'application/pdf;charset=UTF-8',
            'content-disposition': 'inline; filename="D06_grammar.pdf"; filename*=UTF-8\'\'D06_grammar.pdf'},
            content=fixture('sample.pdf'))
    return httpx.Response(404)


def test_a_doi_is_followed_to_its_pdf_which_is_stored_and_not_returned(monkeypatch):
    from plaid_agent.igt.toolkit import call_tool, tools_for
    store = Store()
    w = web_ws(monkeypatch, grammar_site, store)
    w.web.offer(['https://doi.org/10.1/x'])
    out = call_tool(w, 'read_url', {'url': 'https://doi.org/10.1/x'})

    assert out.startswith('Web page: https://repo.example/handle/1 leads to the PDF '
                          'https://repo.example/api/content.')
    assert 'stored with this conversation as "D06_grammar.pdf"' in out
    assert 'untrusted text from the web begins' in out and 'Landing page title: A Grammar Sketch' in out
    assert '3 Complex predicates (page 3)' in out
    # The text itself is not in the result: the model reads the part it needs.
    assert 'baffling' not in out and 'ŋa-mriri' not in out
    # It is stored as a file of the conversation, the way an attachment is.
    [ref] = w.keeper.refs
    assert ref['name'] == 'D06_grammar.pdf' and ref['source'] == 'https://repo.example/api/content'
    part = store.client.user_data.get('u@x', f'{file_key("igt", "p1", "c1", ref["id"])}:part:0')['value']
    assert part == SAMPLE.text
    # And read like one, in the same turn.
    assert 'read_file' in {t['function']['name'] for t in tools_for(w)}
    page = call_tool(w, 'read_file', {'name': 'D06_grammar.pdf', 'section': '3'})
    assert 'ŋa-mriri' in page and 'untrusted text from the web begins' in page


def test_reading_the_same_pdf_again_stores_it_once(monkeypatch):
    from plaid_agent.igt.toolkit import call_tool
    w = web_ws(monkeypatch, grammar_site)
    w.web.offer(['https://doi.org/10.1/x'])
    call_tool(w, 'read_url', {'url': 'https://doi.org/10.1/x'})
    call_tool(w, 'read_url', {'url': 'https://doi.org/10.1/x'})
    assert len(w.keeper.refs) == 1 and len(w.files) == 1


def test_a_turn_that_reads_a_pdf_from_the_web_in_a_later_turn_cannot_plan():
    from plaid_agent.igt.toolkit import call_tool
    from test_tools import ws as tools_ws
    w = tools_ws()
    w.files = attached_pdf(source='https://repo.example/api/content')
    assert w.web is None  # a later turn, with web lookup switched off since
    call_tool(w, 'read_file', {'name': 'grammar.pdf', 'page': '3'})
    out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'x'})
    assert 'cannot also plan changes' in out and not w.ops


def test_a_page_that_links_to_pdfs_lists_them_and_they_may_be_opened(monkeypatch):
    page = b'<html><body><p>Papers</p><a href="/files/one.PDF">one</a><a href="two.html">two</a></body></html>'
    handler = lambda r: httpx.Response(200, headers={'content-type': 'text/html'}, content=page)  # noqa: E731
    w = web_ws(monkeypatch, handler)
    w.web.offer(['https://repo.example/list'])
    from plaid_agent.igt.toolkit import call_tool
    out = call_tool(w, 'read_url', {'url': 'https://repo.example/list'})
    assert 'PDF links on this page:\nhttps://repo.example/files/one.PDF' in out
    assert w.web.allowed('https://repo.example/files/one.PDF')
    assert not w.web.allowed('https://repo.example/two.html')


def test_a_landing_page_whose_pdf_cannot_be_had_is_read_with_the_reason(monkeypatch):
    def handler(request):
        if str(request.url).endswith('/handle/1'):
            return httpx.Response(200, headers={'content-type': 'text/html'}, content=LANDING)
        return httpx.Response(403)
    w = web_ws(monkeypatch, handler)
    w.web.offer(['https://repo.example/handle/1'])
    from plaid_agent.igt.toolkit import call_tool
    out = call_tool(w, 'read_url', {'url': 'https://repo.example/handle/1'})
    assert 'This paper presents a grammatical sketch.' in out
    assert 'names its PDF, https://repo.example/bitstreams/abc/download, which could not be read' in out
    assert 'answered 403' in out and not w.keeper.refs


def test_a_scan_is_refused_in_a_sentence_and_nothing_is_stored(monkeypatch):
    handler = lambda r: httpx.Response(200, headers={'content-type': 'application/pdf'},  # noqa: E731
                                       content=fixture('scan.pdf'))
    w = web_ws(monkeypatch, handler)
    w.web.offer(['https://repo.example/scan.pdf'])
    from plaid_agent.igt.toolkit import call_tool
    out = call_tool(w, 'read_url', {'url': 'https://repo.example/scan.pdf'})
    assert out.startswith('Error: https://repo.example/scan.pdf is a PDF with no text in it')
    assert not w.keeper.refs and not w.files


def test_a_pdf_over_the_download_cap_is_refused(monkeypatch):
    from plaid_agent.core import web
    monkeypatch.setattr(web, 'MAX_PDF_BYTES', 1000)
    resolving(monkeypatch, {'repo.example': '93.184.216.35'})
    big = httpx.Response(200, headers={'content-type': 'application/pdf'}, content=fixture('sample.pdf'))
    client = httpx.Client(transport=httpx.MockTransport(lambda r: big), follow_redirects=False)
    with pytest.raises(WebError, match='is a PDF .*over the 0 MB this tool reads'):
        fetch('https://repo.example/g.pdf', CFG, client=client)


def test_a_pdf_whose_text_is_over_the_file_limit_is_refused(monkeypatch):
    from plaid_agent.core import files
    monkeypatch.setattr(files, 'MAX_FILE_BYTES', 500)
    handler = lambda r: httpx.Response(200, headers={'content-type': 'application/pdf'},  # noqa: E731
                                       content=fixture('sample.pdf'))
    w = web_ws(monkeypatch, handler)
    w.web.offer(['https://repo.example/g.pdf'])
    from plaid_agent.igt.toolkit import call_tool
    out = call_tool(w, 'read_url', {'url': 'https://repo.example/g.pdf'})
    assert 'is a PDF whose text is over the 0.0005 MB a file in this conversation may hold' in out
    assert not w.keeper.refs


def test_reading_stops_as_soon_as_the_text_is_over_the_limit():
    with pytest.raises(pdftext.PdfTooLong, match='over the 0.0005 MB'):
        pdftext.extract(fixture('sample.pdf'), max_text_bytes=500)


# --- PDFium in a process of its own ---------------------------------------------------

def test_several_pdfs_read_at_once_each_come_out_whole():
    # PDFium is not safe on two threads at once, and the service answers
    # several requests at once. Each read has a process of its own.
    from concurrent.futures import ThreadPoolExecutor
    data = fixture('sample.pdf')
    with ThreadPoolExecutor(4) as pool:
        got = list(pool.map(lambda _: pdftext.extract(data), range(4)))
    assert all(g.text == SAMPLE.text and g.sections == SAMPLE.sections for g in got)


def test_a_pdf_that_takes_too_long_is_given_up():
    with pytest.raises(pdftext.PdfError, match='took longer than 0 seconds'):
        pdftext.extract(fixture('sample.pdf'), timeout=0.001)


def test_a_reader_that_dies_is_said_and_the_service_goes_on(monkeypatch):
    # What a PDF that crashes PDFium looks like from here: the process ends
    # with nothing said.
    monkeypatch.setattr(sys, 'executable', '/bin/false')
    with pytest.raises(pdftext.PdfError, match='The PDF reader stopped on it'):
        pdftext.extract(fixture('sample.pdf'))


def test_progress_is_told_page_by_page():
    seen = []
    pdftext.extract(fixture('sample.pdf'), on_page=lambda done, total: seen.append((done, total)))
    assert seen == [(n, SAMPLE.pages) for n in range(1, SAMPLE.pages + 1)]


def test_a_download_that_trickles_is_given_up(monkeypatch):
    from plaid_agent.core import web
    monkeypatch.setattr(web, 'PDF_DOWNLOAD_S', -1)
    resolving(monkeypatch, {'repo.example': '93.184.216.35'})
    resp = httpx.Response(200, headers={'content-type': 'application/pdf'}, content=fixture('sample.pdf'))
    client = httpx.Client(transport=httpx.MockTransport(lambda r: resp), follow_redirects=False)
    with pytest.raises(WebError, match='took longer than -1 seconds to download'):
        fetch('https://repo.example/g.pdf', CFG, client=client)


def test_a_long_section_of_a_web_pdf_says_where_to_go_on_and_fences_its_title():
    from plaid_agent.core.limits import MAX_RESULT_CHARS
    long = ('=== # 9 Complex predicates ===\n=== page 1 ===\n'
            + '\n'.join(f'ia sofa punit ia namnamin {i}' for i in range(4000))
            + '\n=== # 10 Clause coordination ===\n=== page 2 ===\nend\n')
    w = Ws(attached_pdf(long, source='https://repo.example/g.pdf'))
    out = filetools.t_read_file(w, name='grammar.pdf', section='9')
    assert len(out) <= MAX_RESULT_CHARS and '[truncated' not in out
    assert 'Continue with start_line=' in out and '(this section ends at line 4,005)' in out
    # The PDF's own title is the web's text, so it is inside the fence.
    before_fence = out.split('untrusted text from the web begins')[0]
    assert 'Complex predicates' not in before_fence
    assert 'Complex predicates' in out and w.read_untrusted


def test_a_web_pdfs_pages_named_in_a_refusal_are_fenced():
    w = Ws(attached_pdf(source='https://repo.example/g.pdf'))
    with pytest.raises(ToolError) as e:
        filetools.t_read_file(w, name='grammar.pdf', page='999')
    assert 'untrusted text from the web begins' in str(e.value) and 'has no page 999' in str(e.value)


def test_a_pdf_served_as_bytes_of_no_stated_kind_is_still_a_pdf(monkeypatch):
    resolving(monkeypatch, {'repo.example': '93.184.216.35'})
    resp = httpx.Response(200, headers={'content-type': 'application/octet-stream'}, content=fixture('sample.pdf'))
    client = httpx.Client(transport=httpx.MockTransport(lambda r: resp), follow_redirects=False)
    page = fetch('https://repo.example/papers/Visser%202026.pdf', CFG, client=client)
    assert page.pdf.startswith(b'%PDF-') and page.filename == 'Visser 2026.pdf'


# --- storing what a turn fetched ------------------------------------------------------

def test_a_kept_file_is_cut_by_the_stores_own_measure():
    text = 'ŋa-mriri / "x"\n' * 200
    parts = chunk(text, 300)
    assert ''.join(parts) == text
    assert all(stored_bytes(p) <= 300 for p in parts)
    assert stored_bytes('ŋ/a') == 2 + 6 + 2 + 1


def test_a_failed_turn_takes_back_what_it_stored():
    store = Store()
    keeper = FileKeeper(store, 'c1', budget=100)
    files = Attachments([])
    keeper.keep(files, 'g.pdf', 'x' * 250, source='https://repo.example/g.pdf')
    listed = store.client.user_data.list('u@x', prefix='igt:assistant:p1:file:c1:')
    assert len(listed) == 3
    keeper.discard()
    assert store.client.user_data.list('u@x', prefix='igt:assistant:p1:file:c1:') == []
    assert keeper.refs == []


def test_a_later_turn_reads_a_fetched_file_from_the_reply_that_stored_it():
    refs = [{'id': 'f9', 'name': 'g.pdf', 'bytes': 3, 'lines': 1, 'chunks': 1, 'source': 'https://r.example/g.pdf'}]
    display = [{'kind': 'user', 'text': 'read it'}, {'kind': 'assistant', 'text': 'read', 'files': refs},
               {'kind': 'user', 'text': 'and §9?'}]

    class S:
        app, project_id = 'igt', 'p1'

        def read(self, key):
            return 'abc' if key.endswith('f9:part:0') else None

    files = Attachments.of(S(), 'c1', display)
    [a] = list(files)
    assert a.name == 'g.pdf' and a.source == 'https://r.example/g.pdf' and a.text() == 'abc'


def test_a_turn_that_fetched_a_pdf_puts_it_on_its_reply(monkeypatch):
    from test_service_flow import Helper, _request, _seed, _service
    from plaid_agent.core import service as service_mod
    from plaid_agent.core.agent import TurnResult

    client = FakeClient()
    store = _seed(client)

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        ws.keeper.keep(ws.files, 'g.pdf', SAMPLE.text, source='https://r.example/g.pdf')
        return TurnResult('Read.', [{'role': 'assistant', 'content': 'Read.'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert not helper.errors
    conv, _ = ConversationStore(client, 'u@x', 'p1', 'igt').load('c1')
    [ref] = conv['display'][-1]['files']
    assert ref['name'] == 'g.pdf' and ref['source'] == 'https://r.example/g.pdf'
    assert ref['lines'] == SAMPLE.text.count('\n')


def test_a_turn_that_fails_after_fetching_leaves_nothing_stored(monkeypatch):
    from test_service_flow import Helper, _request, _seed, _service
    from plaid_agent.core import service as service_mod

    client = FakeClient()
    _seed(client)

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        ws.keeper.keep(ws.files, 'g.pdf', SAMPLE.text, source='https://r.example/g.pdf')
        raise RuntimeError('the model went away')

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = Helper()
    _service().process_request(_request(client), helper)
    assert helper.errors
    assert client.user_data.list('u@x', prefix='igt:assistant:p1:file:') == []


def test_a_turn_whose_reply_is_dropped_takes_back_what_it_stored(monkeypatch):
    # The user stopped and sent again while the turn ran: the reply is not
    # written, and nothing else names the file it stored.
    from test_service_flow import Helper, _request, _seed, _service
    from plaid_agent.core import service as service_mod
    from plaid_agent.core.agent import TurnResult

    client = FakeClient()
    store = _seed(client, request_id='r1')

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        ws.keeper.keep(ws.files, 'g.pdf', SAMPLE.text, source='https://r.example/g.pdf')
        conv, meta = store.load('c1')
        store.save('c1', conv, {**meta, 'pending': {'kind': 'turn', 'request_id': 'r2'}})
        return TurnResult('Read.', [{'role': 'assistant', 'content': 'Read.'}], [])

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    helper = Helper(request_id='r1')
    _service().process_request(_request(client), helper)
    assert client.user_data.list('u@x', prefix='igt:assistant:p1:file:') == []


def test_a_turn_whose_reply_the_store_refuses_keeps_what_the_answer_names(monkeypatch):
    """The answer goes back whole for the page to write into the record
    (A2-UD-2), and it names what the turn stored, so that stays."""
    from test_service_flow import Helper, _request, _seed, _service
    from plaid_agent.core import service as service_mod
    from plaid_agent.core.agent import TurnResult

    client = FakeClient()
    _seed(client)

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        ws.keeper.keep(ws.files, 'g.pdf', SAMPLE.text, source='https://r.example/g.pdf')
        return TurnResult('Read.', [{'role': 'assistant', 'content': 'Read.'}], [])

    def refuse(*a, **k):
        raise ValueError('too large')

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    monkeypatch.setattr(ConversationStore, 'save', refuse)
    helper = Helper()
    _service().process_request(_request(client), helper)
    [done] = helper.done
    assert done['warning'] and not helper.errors
    [kept] = done['item']['files']
    assert kept['name'] == 'g.pdf'
    assert client.user_data.list('u@x', prefix='igt:assistant:p1:file:') != []
