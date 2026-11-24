"""Offline tests for ud_tag_crf.py: features, specs, CoNLL-U reading, reading a
UD document, and the write plan's contract. No server needed."""

import importlib.util
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("ud_tag_crf", HERE.parent / "ud_tag_crf.py")
crf = importlib.util.module_from_spec(_spec)
sys.modules["ud_tag_crf"] = crf
_spec.loader.exec_module(crf)

MACHINE = {"prov": "inferred", "provSource": "service:other"}
STAMP = {"prov": "inferred", "provSource": "service:crf-tagger", "provDetail": {"model": "t"}}


# --- features -----------------------------------------------------------------

def test_segments_keep_diacritics_and_modifiers_together():
    assert crf.segments("t̪aː") == ["t̪", "aː"]
    assert crf.segments("kʰo") == ["kʰ", "o"]
    assert crf.segments("bûn") == ["b", "û", "n"]


def test_affixes_count_segments_not_code_points():
    spec = crf.FeatureSpec(window=0, prefix_lengths=[1], suffix_lengths=[1])
    feats = crf.sentence_features(["kʰaː"], spec)[0]
    assert "0:p1=kʰ" in feats and "0:s1=aː" in feats


def test_every_neighbour_feature_names_its_offset():
    spec = crf.preset_spec("standard")
    feats = crf.sentence_features(["a", "b", "c"], spec)
    assert "-1:w=a" in feats[1] and "+1:w=c" in feats[1]
    assert "-2:PAD" in feats[0] and "+2:w=c" in feats[0]
    assert "BOS" in feats[0] and "EOS" in feats[2]


def test_regex_and_class_features():
    spec = crf.FeatureSpec.from_dict({"window": 0, "charClasses": {"v": ["a", "aː"]},
                                      "regexFeatures": {"pl": "ler$"}})
    feats = crf.sentence_features(["evler"], spec)[0]
    assert "0:re.pl" in feats
    feats = crf.sentence_features(["baː"], spec)[0]
    assert "0:n.v=1" in feats and "0:end.v" in feats     # aː counted once, as one unit


# --- specs --------------------------------------------------------------------

def test_spec_round_trips_through_project_config():
    spec = crf.preset_spec("standard")
    assert crf.FeatureSpec.from_dict(spec.to_config()).to_dict() == spec.to_dict()


@pytest.mark.parametrize("bad, message", [
    ({"windw": 1}, "Unknown"),
    ({"regexFeatures": {"x": "(unclosed"}}, "invalid"),
    ({"window": 9}, "window"),
    ({"charClasses": {"v": []}}, "non-empty"),
    ({"regexFeatures": {"bad name": "a"}}, "may only use"),
])
def test_bad_specs_are_refused_with_a_reason(bad, message):
    with pytest.raises(crf.FeatureSpecError, match=message):
        crf.FeatureSpec.from_dict(bad)


# --- CoNLL-U --------------------------------------------------------------------

def test_parse_conllu_reads_syntactic_words_only():
    text = ("# text = del gato\n"
            "1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_\n"
            "1\tde\tde\tADP\t_\t_\t3\tcase\t_\t_\n"
            "2\tel\tel\tDET\t_\t_\t3\tdet\t_\t_\n"
            "2.1\tx\tx\tNOUN\t_\t_\t_\t_\t_\t_\n"
            "3\tgato\tgato\tNOUN\t_\t_\t0\troot\t_\t_\n\n")
    assert crf.parse_conllu(text) == [(["de", "el", "gato"], ["ADP", "DET", "NOUN"])]


# --- a UD document ----------------------------------------------------------------

def make_doc(words, tags, metas, synwords=True):
    """One sentence; tags[i] None = no UPOS span; synwords False = none at all."""
    body, toks, syn, spans = "", [], [], []
    for i, w in enumerate(words):
        if body:
            body += " "
        b = len(body)
        body += w
        toks.append({"id": f"w{i}", "begin": b, "end": len(body)})
        if synwords:
            syn.append({"id": f"s{i}", "begin": b, "end": len(body), "precedence": None})
            if tags[i] is not None:
                sp = {"id": f"u{i}", "value": tags[i], "tokens": [f"s{i}"]}
                if metas[i]:
                    sp["metadata"] = metas[i]
                spans.append(sp)
    tl = lambda name, role, tokens, span_layers=(): {
        "id": name, "name": name, "config": {"plaid": {"role": role}}, "tokens": tokens,
        "span_layers": list(span_layers)}
    return {"id": "d", "project": "p", "version": 1, "text_layers": [{
        "id": "t", "config": {"plaid": {"role": "baseline"}}, "text": {"id": "x", "body": body},
        "token_layers": [
            tl("S", "sentence", [{"id": "s", "begin": 0, "end": len(body)}]),
            tl("W", "word", toks),
            tl("M", "syntactic-word", syn, [
                {"id": "F", "config": {"ud": {"form": True}}, "spans": []},
                {"id": "U", "config": {"ud": {"upos": True}}, "spans": spans}]),
        ]}]}


def test_only_sentences_a_person_tagged_throughout_are_training_data():
    human = make_doc(["a", "b"], ["X", "Y"], [None, None])
    mixed = make_doc(["a", "b"], ["X", "Y"], [None, MACHINE])
    partial = make_doc(["a", "b"], ["X", None], [None, None])
    assert crf.gold_sentences(crf.read_ud_document(human)) == [(["a", "b"], ["X", "Y"])]
    assert crf.gold_sentences(crf.read_ud_document(mixed)) == []
    assert crf.gold_sentences(crf.read_ud_document(partial)) == []


def test_missing_layers_are_refused():
    doc = make_doc(["a"], ["X"], [None])
    doc["text_layers"][0]["token_layers"][2]["span_layers"] = []
    with pytest.raises(crf.Refusal):
        crf.read_ud_document(doc)


class FixedTagger:
    """Says the same tag for every word."""
    def __init__(self, tag):
        self.t = tag

    def tag(self, words):
        return [(self.t, {self.t: 0.9}, 0.9) for _ in words]


def test_write_contract():
    # 0: a person's tag (kept), 1: machine tag differing (updated),
    # 2: no tag (created), 3: machine tag already right (left alone)
    doc = make_doc(["a", "b", "c", "d"], ["X", "Y", None, "N"], [None, MACHINE, None, MACHINE])
    units, counts = crf.plan_document(crf.read_ud_document(doc), FixedTagger("N"), STAMP, False)
    (u,) = units
    assert [x["id"] for x in u.updates] == ["u1"]
    assert [s["tokens"] for s in u.new_spans] == [["s2"]]
    assert not u.new_tokens and not u.deletes
    assert counts == {"parsed_sentences": 1, "unchanged_sentences": 0,
                      "skipped_sentences": 0, "words_tagged": 2}
    created = u.new_spans[0]["metadata"]
    assert created["prov"] == "inferred" and created["provSource"] == "service:crf-tagger"
    assert created["provProb"] == 0.9 and created["provDetail"]["valueProbs"] == {"N": 0.9}


def test_overwrite_replaces_a_persons_tag_and_drops_its_confirmation():
    verified = {**MACHINE, "provConfirmed": True}
    doc = make_doc(["a"], ["X"], [verified])
    units, _ = crf.plan_document(crf.read_ud_document(doc), FixedTagger("N"), STAMP, True)
    ops = units[0].updates[0]["metadata"]
    assert {"op": "delete", "path": ["provConfirmed"]} in ops


def test_a_sentence_a_person_tagged_is_skipped():
    doc = make_doc(["a", "b"], ["X", "Y"], [None, None])
    units, counts = crf.plan_document(crf.read_ud_document(doc), FixedTagger("N"), STAMP, False)
    assert units == [] and counts["skipped_sentences"] == 1 and counts["parsed_sentences"] == 0


def test_words_without_syntactic_words_get_one():
    doc = make_doc(["a", "b"], [None, None], [None, None], synwords=False)
    units, counts = crf.plan_document(crf.read_ud_document(doc), FixedTagger("N"), STAMP, False)
    u = units[0]
    assert len(u.new_tokens) == 2 and all(t["metadata"]["prov"] == "inferred" for t in u.new_tokens)
    assert [s["tokens"] for s in u.new_spans] == [[("new", 0)], [("new", 1)]]


# --- training and the registration -----------------------------------------------

def test_train_and_tag_a_tiny_corpus():
    corpus = [(["the", "dog", "runs"], ["DET", "NOUN", "VERB"]),
              (["a", "cat", "sleeps"], ["DET", "NOUN", "VERB"])] * 10
    spec = crf.preset_spec("basic")
    tagger = crf.Tagger(crf.train_model(corpus, spec), spec)
    assert [t for t, _, _ in tagger.tag(["the", "cat", "runs"])] == ["DET", "NOUN", "VERB"]
    assert crf.fit_temperature([({"A": 1.0}, "A")] * 10) is None     # too few to calibrate


def test_registration_fits_in_a_url():
    assert crf.extras_url_bytes(crf.CrfTaggerService().extras) <= crf.MAX_EXTRAS_URL_BYTES
