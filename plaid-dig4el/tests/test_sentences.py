"""Offline checks of the sentence-pair stage: the facet string dig4el derived from a
description, the pair-file parser, and the vector packing used by retrieval."""

import numpy as np
import pytest

from plaid_dig4el import augment, sentences
from plaid_dig4el.web.app import parse_pairs


def test_facet_string_and_keywords_follow_dig4el():
    d = augment.Sentence(
        original_sentence="Please don't open the door.", intent=["order"], mood=["imperative", "injunctive"],
        act_of_speech=["directive"], polarity=["negative"], tense=["present"], sentence_complexity=["simple"],
        key_translation_concepts=["request", "negation", "open", "door"], comment="",
    )
    a = augment.augmentation_of(d)
    assert a["description"] == "intent=order | mood=imperative & injunctive | act_of_speech=directive | polarity=negative | tense=present"
    assert a["keywords"] == ["order", "imperative", "injunctive", "directive", "negative", "present"]
    assert a["key_translation_concepts"] == ["request", "negation", "open", "door"]
    assert sentences.vector_text("Please don't open the door.", a["description"]).endswith("tense=present.")


def test_pair_files_json_and_csv():
    js = b'[{"source": "A", "target": "a", "comments": "c"}, {"source": "", "target": "b"}, {"source": "B", "target": "bb"}]'
    assert parse_pairs("x.json", js) == [{"source": "A", "target": "a", "comments": "c"},
                                         {"source": "B", "target": "bb", "comments": ""}]
    csv = "﻿source,target, comments\nHello ,ia ora na, greeting\n,no source,\n".encode()
    assert parse_pairs("x.csv", csv) == [{"source": "Hello", "target": "ia ora na", "comments": "greeting"}]
    with pytest.raises(Exception):
        parse_pairs("x.json", b'[{"source": "", "target": ""}]')


def test_vectors_pack_normalized_and_unpack():
    blob = sentences.pack([[3.0, 4.0], [0.0, 0.0], [1.0, 0.0]])
    arr = sentences.unpack(blob, 2)
    assert arr.shape == (3, 2)
    assert np.allclose(arr[0], [0.6, 0.8]) and np.allclose(arr[1], [0, 0]) and np.allclose(arr[2], [1, 0])


def test_keyword_hits_match_substrings():
    class Row:
        def __init__(self, kws):
            self.keywords = kws
    rows = [Row(["negative", "imperative"]), Row(["present", "assertive"]), Row(["negation"])]
    hits = sentences.keyword_hits(rows, "negat", [" "])
    assert [h.augmentation.keywords for h in hits] == [["negative", "imperative"], ["negation"]]
