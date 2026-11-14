"""How a form names a lexicon entry, one rule for every tool (EV2,
2026-11-14): analyze_sentence's linking, link_entry and every tool that names
an entry by its form (``Workspace.find_entry``), and the entries a job piece's
evidence block lists, all compare ``fit.form_key`` of the entry's form as
stored with ``fit.form_key`` of the form given.

The rule is plaid-igt's: the pair picker finds the entries spelled like a
morpheme by plaid-ui's collationKey (NFC, then lower case) of each side, and
strips no marker, since every writer of an entry form stores it without its
affix or clitic markers (plaid_client's entry_form, R27). So a morpheme "di"
never fits an entry stored "-di", in any tool, and the block never lists one
as if it could."""

import unicodedata

from fixtures import FakeClient, document_raw, fake_ws, lexicon_raw
from job_fixtures import JobClient, document
from test_analyze_sentence import call as analyze, links, untagged
from test_job_evidence import _asked, _small

from plaid_agent.igt import fit
from plaid_agent.igt.toolkit import call_tool

ACUTE = '\N{COMBINING ACUTE ACCENT}'


def _ws(items):
    lex = {**lexicon_raw(), 'items': items}
    return fake_ws(FakeClient(project=untagged(), documents={'d1': document_raw()}, lexicon=lex))


def _decomposed_lexicon():
    """gam 'fish' stored with a decomposed accent, as a file may hold it:
    "gá" + "m" with U+0301 after the a."""
    form = 'ga' + ACUTE + 'm'
    assert unicodedata.normalize('NFC', form) != form
    return [{'id': 'e-gam', 'form': form, 'metadata': {'gloss': 'fish'}}]


def test_link_entry_names_an_entry_by_the_key_linking_compares():
    """The entry is stored decomposed and named composed (and in capitals):
    link_entry finds it as analyze_sentence's linking and the pair picker
    would. It compared lower case only, so the composed name found nothing."""
    w = _ws(_decomposed_lexicon())
    composed = unicodedata.normalize('NFC', 'GA' + ACUTE + 'M')
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_form': composed})
    assert out.startswith('Planned 1'), out
    assert [(o['token_id'], o['item_id']) for o in w.ops if o['kind'] == 'link'] == [('w-2', 'e-gam')]


def test_analyze_sentence_links_by_the_same_key():
    w = _ws(_decomposed_lexicon())
    analyze(w, ref='s1.w2', forms=unicodedata.normalize('NFC', 'ga' + ACUTE + 'm'), gloss='fish')
    assert links(w) == [('w-2.m1', 'e-gam')]


def test_a_morpheme_never_fits_an_entry_stored_with_its_marker_and_the_block_does_not_list_one(monkeypatch):
    """The fixture's lexicon holds "-di" ERG, stored with its marker (no
    writer stores that since R27). "di" ERG links to nothing, link_entry
    "di" names nothing, and a piece whose word is "Gamdi" is not shown "-di"
    as an entry spelled inside it: what the block lists is what can link."""
    w = fake_ws(FakeClient(project=untagged()))
    out = analyze(w, ref='s1.w1', forms='Ali-di', gloss='Ali-ERG')
    assert links(w) == [('w-1.m1', 'vi-ali')]
    assert 'di ‘ERG’ ×1 (s1.w1.m2).' in out
    assert call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w1.m2'], 'entry_form': 'di'}).startswith('Error')
    (asked,) = _asked(monkeypatch, _small())
    block = asked.split('Lexicon entries spelled inside these forms (form ‘gloss’ type):\n')[1].split('\n\n')[0]
    assert block.splitlines() == ['gam#1 ‘fish’', 'gam#2 ‘net’']


def test_the_rule_is_one_function(monkeypatch):
    """A rule changed in fit.form_key changes every tool at once: with a key
    that drops a leading or trailing marker, "di" fits "-di" in
    analyze_sentence, link_entry names it, and the block lists it."""
    monkeypatch.setattr(fit, 'form_key', lambda form: fit.collation_key(form).strip('-='))
    w = fake_ws(FakeClient(project=untagged()))
    analyze(w, ref='s1.w1', forms='Ali-di', gloss='Ali-ERG')
    assert links(w) == [('w-1.m1', 'vi-ali'), ('w-1.m2', 'vi-erg')]
    w = fake_ws(FakeClient(project=untagged()))
    assert call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w1.m2'], 'entry_form': 'di'}).startswith(
        'Planned 0')  # already linked to it in the fixture: linked back, nothing to write
    (asked,) = _asked(monkeypatch, JobClient({
        'A': document('A', 'Doc A', [{'words': ['Gamdi', 'ka,', 'zo']}])}))
    assert '-di ‘ERG’ suffix' in asked
