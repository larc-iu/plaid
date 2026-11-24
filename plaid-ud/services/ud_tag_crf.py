"""
Author: J. Elizabeth Liebl 
Contact: jliebl@gmu.edu

CRF part-of-speech tagger service for Plaid UD

Tags the syntactic words of a document with UPOS using a linear-chain CRF
(python-crfsuite) trained on the project's own annotated sentences,
optionally together with a Universal Dependencies treebank of a related
language as a starter. Serves the `parse` task, so it appears under
**Parse** in Plaid UD. Nothing in it is specific to one language: what the
model knows comes from the training data and from a feature specification
that a project can replace with its own (character classes, regular
expressions, affix lengths, window size).

Requirements:  pip install larc-plaid-client python-crfsuite regex

Commands
--------

  python ud_tag_crf.py [PROJECT_ID ...] [--url URL]
      Serve the parse task on those projects (all accessible ones when none
      are named). Each request trains a model when none is cached for the
      project's current annotations and settings, then tags the document.

  python ud_tag_crf.py train PROJECT_ID [--treebank UD_X] [--features NAME|FILE]
                                         [--no-project-data] [--folds K] [--url URL]
      Train (and cache) the model a request with the same settings would use,
      and print an evaluation report. With --folds, also run K-fold
      cross-validation over the project's annotated sentences.

  python ud_tag_crf.py features PROJECT_ID [--set FILE | --clear | --template]
      Show, set or clear the project's custom feature specification (stored
      in the project's config under the `crf-tagger` namespace). Requests
      use it when "Features" is set to "Custom". --template prints a
      starting spec to edit.

  python ud_tag_crf.py treebanks
      List the starter treebanks offered in the Parse dialog.

Authentication is BaseService's: a named API token in a `.token` file in the
working directory (prompted for and saved on first run).

What it reads and writes
------------------------
A token is a unit of the text as written (the UD app's Tokens layer; Plaid's word role). 
A syntactic word is a unit the grammar sees (the UD app's Words layer). Usually they're 
the same; a contraction like Spanish del is one token holding two syntactic words, de + el. 
UPOS tags go on syntactic words.

Training data is every sentence of the project in which EVERY syntactic word
has a UPOS value a person made, contributed or verified (imported CoNLL-U
counts as made by a person). Machine-made, unconfirmed tags, including this
service's own, are never trained on.

A run tags every sentence of the document that has words. For each
syntactic word it writes, updates or leaves a UPOS span:

- no UPOS yet: one is created;
- a machine-made, unconfirmed UPOS: updated if the new tag differs;
- a UPOS a person made or verified: left alone, unless Overwrite is on.

A token with no syntactic word gets one covering the whole token, following the
behavior of the Stanza parser. Nothing else is touched: no tokens are deleted, no
lemmas, features or relations are written. A document with no sentences or
words yet is refused (press 'Tokenize' first).

Every span and syntactic word written carries the machine stamp
(`prov: inferred`, `provSource: service:crf-tagger`), with `provDetail`
naming the model and, per span, the top alternatives (`valueProbs`).
`provProb` is written only when the model could be calibrated on held-out
data (temperature scaling of the CRF's marginals, fitted on at least
MIN_CALIBRATION_TOKENS held-out tokens).

Models are cached under ~/.cache/plaid/crf-tagger (or --cache DIR), keyed by
the training data, the treebank, the feature spec and the engine version,
so a model is retrained exactly when one of those changes.
"""

from __future__ import annotations

import argparse
import bisect
import contextlib
import hashlib
import io
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import pycrfsuite
import regex
import requests

from plaid_client import BaseService, TASKS, Param, ROLES, find_by_role, is_protected, service_source
from plaid_client.provenance import PROVENANCE_KEYS, stamp_inferred
from plaid_client.service import (PhasedProgress, Refusal, batch_body_budget, locked_for_writes,
                                  partly_written)
from plaid_client.workflows.messages import setup_incomplete
from plaid_client.workflows.requester import requester_of

SERVICE_ID = "crf-tagger"
CONFIG_NAMESPACE = "crf-tagger"
CONFIG_SPEC_KEY = "featureSpec"
ENGINE_VERSION = 1             # bump when features or training change meaning
DEFAULT_CACHE = Path.home() / ".cache" / "plaid" / "crf-tagger"
MIN_CALIBRATION_TOKENS = 200   # below this many held-out tokens, no provProb
HELD_OUT_FRACTION = 0.1
MIN_HELD_OUT_SENTENCES = 20    # a project needs this many gold sentences to be its own test set
RETRAIN_ON_ALL_BELOW = 4000    # sentences: retrain on everything after evaluation below this
MAX_TREEBANK_SENTENCES = 8000  # a seeded sample of larger treebanks, to bound training time
TOP_K = 3
REGEX_TIMEOUT_S = 0.05
SEED = 13


# =============================================================================
# 1. Features
# =============================================================================

_SEG_RE = regex.compile(r"[^\p{M}\p{Lm}][\p{M}\p{Lm}]*|[\p{M}\p{Lm}]+")


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def segments(word: str) -> List[str]:
    """A base character with its combining marks and modifier letters, so
    t̪, kʰ, aː, î each count as one unit for affixes and length."""
    return _SEG_RE.findall(word)


class FeatureSpecError(ValueError):
    pass


def _camel_to_snake(key: str) -> str:
    return regex.sub(r"(?<!^)(?=[A-Z])", "_", key).lower()


@dataclass
class FeatureSpec:
    """Which features the CRF sees. JSON-serializable; stored in a project's
    config (camelCase or snake_case keys both work).

    window            neighbours on each side that get features (0-4)
    prefix_lengths    prefix lengths, in segments
    suffix_lengths    suffix lengths, in segments
    neighbor_affixes  also give neighbours affix features
    lowercase         lowercase the word form (shape features keep case)
    shape             capitalized / all caps / has digit / punctuation / hyphen
    length            word length in segments
    position          'edge' (sentence start/end markers) or 'absolute' (index)
    char_classes      named sets of graphemes, e.g. {"vowel": ["a", "e", "aː"]}:
                      a count per class and the class the word ends in
    regex_features    named patterns, e.g. {"plural": "(?:ler|lar)$"}: fires
                      when the pattern matches the (lowercased) word
    neighbor_extras   also give neighbours length/shape/class/regex features
    c1, c2            L1 and L2 regularization
    max_iterations    L-BFGS iterations
    """
    window: int = 1
    prefix_lengths: List[int] = field(default_factory=lambda: [1, 2, 3])
    suffix_lengths: List[int] = field(default_factory=lambda: [1, 2, 3])
    neighbor_affixes: bool = True
    lowercase: bool = True
    shape: bool = True
    length: bool = False
    position: str = "edge"
    char_classes: Dict[str, List[str]] = field(default_factory=dict)
    regex_features: Dict[str, str] = field(default_factory=dict)
    neighbor_extras: bool = False
    c1: float = 0.1
    c2: float = 0.05
    max_iterations: int = 150

    def __post_init__(self):
        self._compiled = None

    # -- serialization --------------------------------------------------------
    def to_dict(self) -> dict:
        return {f.name: getattr(self, f.name) for f in fields(self)}

    @classmethod
    def from_dict(cls, d: dict) -> "FeatureSpec":
        if not isinstance(d, dict):
            raise FeatureSpecError("A feature spec must be a JSON object")
        known = {f.name for f in fields(cls)}
        clean, unknown = {}, []
        for k, v in d.items():
            key = k if k in known else _camel_to_snake(k)
            if key in known:
                clean[key] = v
            else:
                unknown.append(k)
        if unknown:
            raise FeatureSpecError(f"Unknown feature setting(s): {', '.join(sorted(unknown))}. "
                                   f"Known: {', '.join(sorted(known))}")
        spec = cls(**clean)
        spec.validate()
        return spec

    def to_config(self) -> dict:
        """camelCase keys, as a JS app would read them."""
        def camel(k):
            head, *rest = k.split("_")
            return head + "".join(p.title() for p in rest)
        return {camel(k): v for k, v in self.to_dict().items()}

    def fingerprint(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False)

    # -- checks -------------------------------------------------------------
    def validate(self) -> None:
        self._compiled = None
        errors = []

        def ints(name, lo, hi):
            v = getattr(self, name)
            if not isinstance(v, list) or any(not isinstance(n, int) or isinstance(n, bool)
                                              or not lo <= n <= hi for n in v):
                errors.append(f"{name} must be a list of whole numbers from {lo} to {hi}")

        if not isinstance(self.window, int) or isinstance(self.window, bool) \
                or not 0 <= self.window <= 4:
            errors.append("window must be a whole number from 0 to 4")
        ints("prefix_lengths", 1, 10)
        ints("suffix_lengths", 1, 10)
        for name in ("neighbor_affixes", "lowercase", "shape", "length", "neighbor_extras"):
            if not isinstance(getattr(self, name), bool):
                errors.append(f"{name} must be true or false")
        if self.position not in ("edge", "absolute"):
            errors.append("position must be 'edge' or 'absolute'")
        for label, table in (("char_classes", self.char_classes),
                             ("regex_features", self.regex_features)):
            if not isinstance(table, dict):
                errors.append(f"{label} must be an object of name: value")
                continue
            for name in table:
                if not isinstance(name, str) or not regex.fullmatch(r"[\w-]+", name):
                    errors.append(f"{label}: the name {name!r} may only use letters, digits, _ and -")
        if isinstance(self.char_classes, dict):
            for name, members in self.char_classes.items():
                if not isinstance(members, list) or not members or \
                        any(not isinstance(m, str) or not m for m in members):
                    errors.append(f"character class {name!r} must be a non-empty list of strings")
        if isinstance(self.regex_features, dict):
            for name, pattern in self.regex_features.items():
                try:
                    regex.compile(nfc(pattern))
                except (regex.error, TypeError) as e:
                    errors.append(f"regular expression {name!r} is invalid: {e}")
        for name in ("c1", "c2"):
            v = getattr(self, name)
            if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
                errors.append(f"{name} must be a number of at least 0")
        if not isinstance(self.max_iterations, int) or not 1 <= self.max_iterations <= 2000:
            errors.append("max_iterations must be a whole number from 1 to 2000")
        if errors:
            raise FeatureSpecError("; ".join(errors))

    def compiled(self):
        if self._compiled is None:
            classes = {}
            for name, members in self.char_classes.items():
                alts = sorted({nfc(m.lower() if self.lowercase else m) for m in members},
                              key=len, reverse=True)       # longest first: "aː" before "a"
                classes[name] = regex.compile("|".join(regex.escape(a) for a in alts))
            regexes = {name: regex.compile(nfc(p)) for name, p in self.regex_features.items()}
            self._compiled = (classes, regexes)
        return self._compiled


FEATURE_PRESETS: Dict[str, dict] = {
    # Close to the classic CRF POS baseline: the word, short affixes, +/-1 window.
    "basic": dict(window=1, prefix_lengths=[1, 2, 3], suffix_lengths=[1, 2, 3], shape=False),
    # A wider window, longer suffixes, word shape and length. A good default
    # for most languages, including heavily suffixing ones.
    "standard": dict(window=2, prefix_lengths=[1, 2, 3], suffix_lengths=[1, 2, 3, 4],
                     shape=True, length=True),
}
FEATURE_SET_OPTIONS = [
    ("standard", "Standard (word, affixes, shape, two words each side)"),
    ("basic", "Basic (word, short affixes, one word each side)"),
    ("project", "Custom (this project's feature settings)"),
]


def preset_spec(name: str) -> FeatureSpec:
    if name not in FEATURE_PRESETS:
        raise FeatureSpecError(f"Unknown feature set {name!r}; choose {', '.join(FEATURE_PRESETS)}")
    spec = FeatureSpec(**FEATURE_PRESETS[name])
    spec.validate()
    return spec


def _search(pattern, word: str) -> bool:
    try:
        return pattern.search(word, timeout=REGEX_TIMEOUT_S) is not None
    except TimeoutError:
        return False


def _is_punct(word: str) -> bool:
    return bool(word) and all(unicodedata.category(c)[0] in "PS" for c in word)


def _word_features(raw: str, spec: FeatureSpec, centre: bool) -> List[str]:
    w = nfc(raw.lower() if spec.lowercase else raw)
    segs = segments(w)
    out = [f"w={w}"]
    if centre or spec.neighbor_affixes:
        for n in spec.prefix_lengths:
            if len(segs) >= n:
                out.append(f"p{n}={''.join(segs[:n])}")
        for n in spec.suffix_lengths:
            if len(segs) >= n:
                out.append(f"s{n}={''.join(segs[-n:])}")
    if centre or spec.neighbor_extras:
        if spec.length:
            out.append(f"len={min(len(segs), 15)}")
        if spec.shape:
            if raw[:1].isupper():
                out.append("cap")
            if len(raw) > 1 and raw.isupper():
                out.append("upper")
            if any(c.isdigit() for c in raw):
                out.append("digit")
            if _is_punct(raw):
                out.append("punct")
            if "-" in raw[1:-1]:
                out.append("hyphen")
        classes, regexes = spec.compiled()
        for name, pat in classes.items():
            found = pat.findall(w)
            out.append(f"n.{name}={min(len(found), 10)}")
            if found and w.endswith(found[-1]):
                out.append(f"end.{name}")
        for name, pat in regexes.items():
            if _search(pat, w):
                out.append(f"re.{name}")
    return out


def sentence_features(words: Sequence[str], spec: FeatureSpec) -> List[List[str]]:
    """Features from the words alone: tags are never an input."""
    centre = [_word_features(w, spec, True) for w in words]
    side = [_word_features(w, spec, False) for w in words] if spec.window else []
    n = len(words)
    out = []
    for i in range(n):
        f = ["bias"] + [f"0:{x}" for x in centre[i]]
        if spec.position == "edge":
            if i == 0:
                f.append("BOS")
            if i == n - 1:
                f.append("EOS")
        else:
            f.append(f"pos={min(i, 30)}")
        for off in range(1, spec.window + 1):
            for sign, j in (("-", i - off), ("+", i + off)):
                if 0 <= j < n:
                    f.extend(f"{sign}{off}:{x}" for x in side[j])
                else:
                    f.append(f"{sign}{off}:PAD")
        out.append(f)
    return out


# =============================================================================
# 2. Training, tagging, evaluation
# =============================================================================

Corpus = List[Tuple[List[str], List[str]]]   # [(words, tags)]


class _Trainer(pycrfsuite.Trainer):
    """Reports each optimizer iteration; an exception from the callback
    (a stop pressed in Plaid) aborts training."""

    def __init__(self, on_iteration=None):
        super().__init__(verbose=False)
        self._cb = on_iteration

    def message(self, message):
        if self.logparser.feed(message) == "iteration" and self._cb:
            self._cb(dict(self.logparser.last_iteration))


def train_model(corpus: Corpus, spec: FeatureSpec,
                on_iteration: Optional[Callable[[int, int], None]] = None) -> bytes:
    """Train a CRF and return the model file's bytes."""
    trainer = _Trainer(lambda info: on_iteration(info.get("num") or 0, spec.max_iterations)
                       if on_iteration else None)
    for words, tags in corpus:
        trainer.append(sentence_features(words, spec), list(tags))
    trainer.set_params({"c1": float(spec.c1), "c2": float(spec.c2),
                        "max_iterations": spec.max_iterations,
                        "feature.possible_transitions": True})
    fd, path = tempfile.mkstemp(suffix=".crfsuite")
    os.close(fd)
    try:
        trainer.train(path)
        return Path(path).read_bytes()
    finally:
        with contextlib.suppress(OSError):
            os.remove(path)


class Tagger:
    """A trained model with its spec and calibration temperature."""

    def __init__(self, model_bytes: bytes, spec: FeatureSpec, temperature: Optional[float] = None,
                 meta: Optional[dict] = None):
        self.model_bytes = model_bytes
        self.spec = spec
        self.temperature = temperature       # None: probabilities are not calibrated
        self.meta = meta or {}
        self._tagger = pycrfsuite.Tagger()
        self._tagger.open_inmemory(model_bytes)
        self.labels = list(self._tagger.labels())
        self._lock = threading.Lock()        # a pycrfsuite Tagger holds one sequence at a time

    def marginals(self, words: Sequence[str]) -> Tuple[List[str], List[Dict[str, float]]]:
        if not words:
            return [], []
        with self._lock:
            self._tagger.set(sentence_features(words, self.spec))
            best = self._tagger.tag()
            dists = [{lab: self._tagger.marginal(lab, i) for lab in self.labels}
                     for i in range(len(words))]
        return best, dists

    def tag(self, words: Sequence[str]) -> List[Tuple[str, Dict[str, float], Optional[float]]]:
        """[(tag, top-k {label: prob}, calibrated prob of tag or None)] per word.
        The tag is the Viterbi path; the probabilities are the (calibrated,
        when possible) marginals."""
        best, dists = self.marginals(words)
        out = []
        for tag, dist in zip(best, dists):
            if self.temperature:
                dist = scale(dist, self.temperature)
            top = dict(sorted(dist.items(), key=lambda kv: -kv[1])[:TOP_K])
            if tag not in top:
                top[tag] = dist.get(tag, 0.0)
            top = {k: round(v, 4) for k, v in top.items()}
            out.append((tag, top, round(dist.get(tag, 0.0), 4) if self.temperature else None))
        return out


def scale(dist: Dict[str, float], t: float) -> Dict[str, float]:
    """Temperature scaling of a distribution: p^(1/t), renormalized."""
    powered = {k: max(v, 1e-12) ** (1.0 / t) for k, v in dist.items()}
    z = sum(powered.values())
    return {k: v / z for k, v in powered.items()}


def fit_temperature(pairs: List[Tuple[Dict[str, float], str]]) -> Optional[float]:
    """The temperature minimizing held-out negative log-likelihood, or None
    with too few tokens to fit one honestly."""
    if len(pairs) < MIN_CALIBRATION_TOKENS:
        return None
    grid = [round(0.5 + 0.05 * i, 2) for i in range(71)]   # 0.5 .. 4.0
    best_t, best_nll = 1.0, float("inf")
    for t in grid:
        nll = 0.0
        for dist, gold in pairs:
            nll -= math.log(max(scale(dist, t).get(gold, 0.0), 1e-9))
        if nll < best_nll:
            best_t, best_nll = t, nll
    return best_t


def evaluate(tagger: Tagger, gold: Corpus, train_vocab: set) -> dict:
    """Accuracy, known/unknown-word accuracy, macro-F1, per-tag scores and the
    most-frequent-tag baseline, on `gold`."""
    lower = tagger.spec.lowercase
    norm = (lambda w: nfc(w.lower())) if lower else nfc
    confusion = defaultdict(Counter)
    known, unknown = [0, 0], [0, 0]
    pairs = []
    for words, tags in gold:
        best, dists = tagger.marginals(words)
        for w, g, p, d in zip(words, tags, best, dists):
            confusion[g][p] += 1
            bucket = known if norm(w) in train_vocab else unknown
            bucket[0] += g == p
            bucket[1] += 1
            pairs.append((d, g))
    total = known[1] + unknown[1]
    correct = known[0] + unknown[0]
    labels = sorted(set(confusion) | {p for row in confusion.values() for p in row})
    per_tag = {}
    for lab in labels:
        tp = confusion[lab][lab]
        support = sum(confusion[lab].values())
        predicted = sum(row[lab] for row in confusion.values())
        p = tp / predicted if predicted else 0.0
        r = tp / support if support else 0.0
        per_tag[lab] = {"precision": round(p, 4), "recall": round(r, 4),
                        "f1": round(2 * p * r / (p + r), 4) if p + r else 0.0, "support": support}
    supported = [v["f1"] for v in per_tag.values() if v["support"]]
    return {"accuracy": round(correct / total, 4) if total else None,
            "known_word_accuracy": round(known[0] / known[1], 4) if known[1] else None,
            "unknown_word_accuracy": round(unknown[0] / unknown[1], 4) if unknown[1] else None,
            "n_tokens": total, "n_unknown": unknown[1],
            "macro_f1": round(sum(supported) / len(supported), 4) if supported else None,
            "per_tag": per_tag,
            "confusion": {g: dict(row) for g, row in sorted(confusion.items())},
            "_pairs": pairs}


def most_frequent_tag_accuracy(train: Corpus, test: Corpus, lowercase: bool) -> Optional[float]:
    norm = (lambda w: nfc(w.lower())) if lowercase else nfc
    by_word, overall = defaultdict(Counter), Counter()
    for words, tags in train:
        for w, t in zip(words, tags):
            by_word[norm(w)][t] += 1
            overall[t] += 1
    if not overall:
        return None
    default = overall.most_common(1)[0][0]
    lex = {w: c.most_common(1)[0][0] for w, c in by_word.items()}
    hits = total = 0
    for words, tags in test:
        for w, t in zip(words, tags):
            hits += lex.get(norm(w), default) == t
            total += 1
    return round(hits / total, 4) if total else None


def vocabulary(corpus: Corpus, lowercase: bool) -> set:
    return {nfc(w.lower() if lowercase else w) for words, _ in corpus for w in words}


def kfold(n: int, k: int, seed: int = SEED) -> List[List[int]]:
    idx = list(range(n))
    random.Random(seed).shuffle(idx)
    return [idx[f::k] for f in range(k)]


# =============================================================================
# 3. Starter treebanks (Universal Dependencies)
# =============================================================================

# (repository, label): a spread of families and scripts. The list travels in
# the service's registration URL, which servers cap at about 8 KB, so it is
# kept short; any other UD repository name can be typed in the dialog's
# "Other UD treebank" box (see universaldependencies.org).
STARTER_TREEBANKS = [
    ("UD_Arabic-PADT", "Arabic"),
    ("UD_Armenian-ArmTDP", "Armenian"),
    ("UD_Basque-BDT", "Basque"),
    ("UD_Chinese-GSDSimp", "Chinese"),
    ("UD_Czech-FicTree", "Czech"),
    ("UD_Dutch-Alpino", "Dutch"),
    ("UD_English-EWT", "English"),
    ("UD_Finnish-TDT", "Finnish"),
    ("UD_French-GSD", "French"),
    ("UD_German-GSD", "German"),
    ("UD_Greek-GDT", "Greek"),
    ("UD_Hebrew-HTB", "Hebrew"),
    ("UD_Hindi-HDTB", "Hindi"),
    ("UD_Hungarian-Szeged", "Hungarian"),
    ("UD_Indonesian-GSD", "Indonesian"),
    ("UD_Irish-IDT", "Irish"),
    ("UD_Japanese-GSD", "Japanese"),
    ("UD_Korean-Kaist", "Korean"),
    ("UD_Kurmanji-MG", "Kurmanji Kurdish"),
    ("UD_Persian-Seraji", "Persian"),
    ("UD_Portuguese-Bosque", "Portuguese"),
    ("UD_Russian-GSD", "Russian"),
    ("UD_Spanish-GSD", "Spanish"),
    ("UD_Tamil-TTB", "Tamil"),
    ("UD_Turkish-IMST", "Turkish"),
    ("UD_Urdu-UDTB", "Urdu"),
    ("UD_Vietnamese-VTB", "Vietnamese"),
    ("UD_Wolof-WTB", "Wolof"),
    ("UD_Yoruba-YTB", "Yoruba"),
]
NO_TREEBANK = "none"
_REPO_RE = regex.compile(r"UD_[A-Za-z_]+-[A-Za-z0-9]+")


def parse_conllu(text: str) -> Corpus:
    """(forms, UPOS) per sentence: syntactic words only (multiword-token
    ranges and empty nodes skipped). A sentence with a missing UPOS is dropped."""
    out, words, tags, ok = [], [], [], True
    for line in text.splitlines():
        line = line.strip("\r")
        if not line.strip():
            if words and ok:
                out.append((words, tags))
            words, tags, ok = [], [], True
            continue
        if line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) < 4 or "-" in cols[0] or "." in cols[0]:
            continue
        form, upos = nfc(cols[1]), cols[3]
        if upos in ("", "_"):
            ok = False
        words.append(form)
        tags.append(upos)
    if words and ok:
        out.append((words, tags))
    return out


def _treebank_files_via_api(repo: str) -> Dict[str, str]:
    """{file name: raw download URL} of the repository's .conllu files."""
    r = requests.get(f"https://api.github.com/repos/UniversalDependencies/{repo}/contents",
                     timeout=30, headers={"Accept": "application/vnd.github+json"})
    if r.status_code == 404:
        raise Refusal(f"There is no Universal Dependencies treebank called {repo}. "
                      f"Names look like UD_English-EWT (see universaldependencies.org).")
    r.raise_for_status()
    return {f["name"]: f["download_url"] for f in r.json()
            if f.get("name", "").endswith(".conllu") and f.get("download_url")}


def _treebank_files_via_git(repo: str, dest: Path) -> Dict[str, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="ud_"))
    try:
        subprocess.run(["git", "clone", "--depth", "1", "--quiet",
                        f"https://github.com/UniversalDependencies/{repo}", str(tmp / "repo")],
                       check=True, capture_output=True, timeout=600)
        out = {}
        for p in (tmp / "repo").glob("*.conllu"):
            shutil.copy(p, dest / p.name)
            out[p.name] = dest / p.name
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def fetch_treebank(repo: str, cache: Path, log=print) -> Tuple[Corpus, str]:
    """The treebank's training sentences (its train file, or every file when
    it has no train split) and a fingerprint of them. Downloaded once."""
    if not _REPO_RE.fullmatch(repo):
        raise Refusal(f"{repo!r} is not a UD treebank name. Names look like UD_English-EWT.")
    dest = cache / "treebanks" / repo
    done = dest / ".complete"
    if not done.exists():
        dest.mkdir(parents=True, exist_ok=True)
        log(f"Downloading {repo}…")
        try:
            urls = _treebank_files_via_api(repo)
            for name, url in urls.items():
                r = requests.get(url, timeout=120)
                r.raise_for_status()
                (dest / name).write_bytes(r.content)
        except Refusal:
            raise
        except Exception as e:  # noqa: BLE001 - rate limit, proxy: try git instead
            log(f"  GitHub API download failed ({e}); trying git clone")
            try:
                _treebank_files_via_git(repo, dest)
            except Exception as e2:  # noqa: BLE001
                raise Refusal(f"Could not download {repo} ({e2}). Check the name and that the "
                              f"service's machine can reach github.com.") from e2
        if not list(dest.glob("*.conllu")):
            raise Refusal(f"{repo} has no .conllu files.")
        done.write_text(time.strftime("%Y-%m-%d"))
    files = sorted(dest.glob("*.conllu"))
    train = [p for p in files if p.name.endswith("-train.conllu")] or files
    corpus = []
    for p in train:
        corpus += parse_conllu(p.read_text(encoding="utf-8"))
    h = hashlib.sha256()
    for p in train:
        h.update(p.name.encode())
        h.update(p.read_bytes())
    if len(corpus) > MAX_TREEBANK_SENTENCES:
        corpus = random.Random(SEED).sample(corpus, MAX_TREEBANK_SENTENCES)
    return corpus, h.hexdigest()[:16]


# =============================================================================
# 4. Reading a UD document
# =============================================================================

def _tid(tok):
    return tok.get("id") if isinstance(tok, dict) else tok


@dataclass
class Slot:
    """One syntactic word of a sentence: stored (`token`) or still to make
    (`token` None, covering `word`)."""
    word: dict
    token: Optional[dict]
    form: str
    upos: List[dict]          # the UPOS spans stored on it


@dataclass
class UdDocument:
    doc: dict
    text_id: str
    body: str
    word_layer: dict
    synword_layer: dict
    upos_layer: dict
    sentences: List[List[Slot]]   # sentences with words, in order
    n_sentences: int


def span_layer_by_ud_flag(layers, key):
    for layer in layers or []:
        if (layer.get("config") or {}).get("ud", {}).get(key) is True:
            return layer
    return None


def read_ud_document(doc: dict) -> UdDocument:
    """Bind a document to UD's layers by role and `ud` flag, never by name,
    and group its syntactic words into sentences."""
    text_layer = find_by_role(doc.get("text_layers") or [], ROLES.BASELINE)
    if not text_layer:
        raise setup_incomplete("no baseline-role text layer")
    text = text_layer.get("text") or {}
    body = text.get("body") or ""
    tls = text_layer.get("token_layers") or []
    sent_layer = find_by_role(tls, ROLES.SENTENCE)
    word_layer = find_by_role(tls, ROLES.WORD)
    syn_layer = find_by_role(tls, ROLES.SYNTACTIC_WORD)
    if not (sent_layer and word_layer and syn_layer):
        raise setup_incomplete("no sentence, word or syntactic-word token layer")
    spans = syn_layer.get("span_layers") or []
    upos_layer = span_layer_by_ud_flag(spans, "upos")
    form_layer = span_layer_by_ud_flag(spans, "form")
    if not upos_layer:
        raise setup_incomplete("no UPOS span layer (config ud.upos)")

    form_of = {}
    for sp in (form_layer or {}).get("spans") or []:
        v = sp.get("value")
        if sp.get("tokens") and isinstance(v, str) and v not in ("", "_"):
            form_of[_tid(sp["tokens"][0])] = v
    upos_of = defaultdict(list)
    for sp in upos_layer.get("spans") or []:
        if sp.get("tokens"):
            upos_of[_tid(sp["tokens"][0])].append(sp)

    sents = sorted(sent_layer.get("tokens") or [], key=lambda t: t["begin"])
    words = sorted(word_layer.get("tokens") or [], key=lambda t: (t["begin"], t["end"]))
    syns = sorted(syn_layer.get("tokens") or [],
                  key=lambda t: (t["begin"], t.get("precedence") or 0, t["end"]))
    # each syntactic word belongs to the word containing it (words do not overlap)
    begins = [w["begin"] for w in words]
    syn_of_word = defaultdict(list)
    for s in syns:
        i = bisect.bisect_right(begins, s["begin"]) - 1
        if i >= 0 and words[i]["begin"] <= s["begin"] and s["end"] <= words[i]["end"]:
            syn_of_word[words[i]["id"]].append(s)

    out = []
    wi = 0
    for sent in sents:
        slots = []
        while wi < len(words) and words[wi]["begin"] < sent["end"]:
            w = words[wi]
            wi += 1
            if w["begin"] < sent["begin"]:
                continue
            surface = body[w["begin"]:w["end"]]
            parts = syn_of_word.get(w["id"]) or []
            if not parts:
                slots.append(Slot(w, None, surface, []))
            for s in parts:
                slots.append(Slot(w, s, form_of.get(s["id"]) or body[s["begin"]:s["end"]],
                                  upos_of.get(s["id"], [])))
        if slots:
            out.append(slots)
    return UdDocument(doc, text.get("id"), body, word_layer, syn_layer, upos_layer, out, len(sents))


def gold_sentences(ud: UdDocument) -> Corpus:
    """Sentences in which every syntactic word has a UPOS a person made,
    contributed or verified."""
    out = []
    for slots in ud.sentences:
        if all(s.token and s.upos and is_protected(s.upos[0].get("metadata"))
               and isinstance(s.upos[0].get("value"), str) and s.upos[0]["value"]
               for s in slots):
            out.append(([s.form for s in slots], [s.upos[0]["value"] for s in slots]))
    return out


class ProjectReader:
    """A project's gold sentences, re-reading only documents whose version
    changed since the last call."""

    def __init__(self):
        self._docs: Dict[str, Tuple[int, Corpus]] = {}

    def read(self, client, project_id: str, log=print) -> Corpus:
        corpus = []
        docs = client.projects.list_documents(project_id) or []
        for d in docs:
            cached = self._docs.get(d["id"])
            if cached and cached[0] == d.get("version"):
                corpus += cached[1]
                continue
            full = client.documents.get(d["id"], include_body=True)
            try:
                gold = gold_sentences(read_ud_document(full))
            except Refusal:
                gold = []          # a document without UD's layers teaches nothing
            self._docs[d["id"]] = (full.get("version"), gold)
            corpus += gold
        log(f"Project has {len(corpus)} fully annotated sentence(s) in {len(docs)} document(s)")
        return corpus


# =============================================================================
# 5. Models: build, cache, describe
# =============================================================================

@dataclass
class TrainingRequest:
    project_id: str
    use_project_data: bool
    treebank: Optional[str]
    feature_set: str          # preset name or 'project'
    spec: FeatureSpec


class ModelStore:
    def __init__(self, cache: Path):
        self.cache = Path(cache)
        (self.cache / "models").mkdir(parents=True, exist_ok=True)
        self._memory: Dict[str, Tagger] = {}
        self.reader = ProjectReader()

    def spec_for(self, client, project_id: str, feature_set: str) -> FeatureSpec:
        if feature_set != "project":
            return preset_spec(feature_set)
        cfg = (client.projects.get(project_id).get("config") or {}).get(CONFIG_NAMESPACE) or {}
        raw = cfg.get(CONFIG_SPEC_KEY)
        if not raw:
            raise Refusal("This project has no custom feature settings yet. Choose Standard or "
                          "Basic features, or ask the service's operator to set them "
                          "(python ud_tag_crf.py features PROJECT_ID --set spec.json).")
        try:
            return FeatureSpec.from_dict(raw)
        except FeatureSpecError as e:
            raise Refusal(f"The project's custom feature settings are invalid: {e}") from e

    def get(self, client, req: TrainingRequest, progress=None, log=print) -> Tuple[Tagger, bool]:
        """The model for this request, trained if not cached. -> (tagger, trained_now)."""
        project = self.reader.read(client, req.project_id, log) if req.use_project_data else []
        treebank, tb_hash = ([], None)
        if req.treebank:
            if progress:
                progress.report(TagProgress.TRAIN, 0.0, f"Getting the {req.treebank} treebank…")
            with (progress.heartbeat(TagProgress.TRAIN, 0.0, f"Downloading {req.treebank}…")
                  if progress else contextlib.nullcontext()):
                treebank, tb_hash = fetch_treebank(req.treebank, self.cache, log)
        if not project and not treebank:
            raise Refusal(
                "There is nothing to learn from yet: no sentence in this project has every "
                "word's UPOS entered or confirmed by a person, and no starter treebank was "
                "chosen. Tag a few sentences by hand (or import a CoNLL-U file), or pick a "
                "starter treebank of a related language.")
        key = hashlib.sha256(json.dumps({
            "engine": ENGINE_VERSION, "spec": req.spec.fingerprint(), "treebank": req.treebank,
            "treebank_hash": tb_hash, "project": sorted(map(json.dumps, project)),
        }, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]
        if key in self._memory:
            return self._memory[key], False
        path = self.cache / "models" / f"{key}.zip"
        if path.exists():
            tagger = load_model(path)
            self._memory[key] = tagger
            return tagger, False
        tagger = build_model(project, treebank, req, progress=progress, log=log)
        tagger.meta["key"] = key
        save_model(tagger, path)
        (self.cache / "models" / f"{key}.report.json").write_text(
            json.dumps(tagger.meta, indent=2, ensure_ascii=False), encoding="utf-8")
        self._memory = {key: tagger}   # keep one model in memory
        return tagger, True


def build_model(project: Corpus, treebank: Corpus, req: TrainingRequest,
                progress=None, log=print) -> Tagger:
    """Hold out part of the in-language data, train, evaluate, calibrate;
    then (for small data) retrain on everything with the same calibration."""
    rng = random.Random(SEED)
    if len(project) >= MIN_HELD_OUT_SENTENCES:
        order = list(range(len(project)))
        rng.shuffle(order)
        n_test = max(2, int(round(HELD_OUT_FRACTION * len(project))))
        test = [project[i] for i in order[:n_test]]
        train = [project[i] for i in order[n_test:]] + treebank
        held_out_source = "project"
    elif len(treebank) >= MIN_HELD_OUT_SENTENCES:
        order = list(range(len(treebank)))
        rng.shuffle(order)
        n_test = max(2, int(round(HELD_OUT_FRACTION * len(treebank))))
        test = [treebank[i] for i in order[:n_test]]
        train = [treebank[i] for i in order[n_test:]] + project
        held_out_source = "treebank"
    else:
        test, train, held_out_source = [], project + treebank, None

    everything = project + treebank
    spec = req.spec
    total_rounds = 2 if test and len(everything) <= RETRAIN_ON_ALL_BELOW else 1

    def on_iter(round_no):
        def cb(i, n):
            if progress:
                frac = (round_no + min(i / max(n, 1), 1.0)) / total_rounds
                progress.report(TagProgress.TRAIN, frac,
                                f"Training the tagger ({i} of up to {n} steps"
                                f"{', final model' if round_no else ''})…")
        return cb

    log(f"Training on {len(train)} sentence(s) "
        f"({len(project)} from the project, {len(treebank)} from "
        f"{req.treebank or 'no treebank'}), holding out {len(test)}")
    t0 = time.time()
    model = train_model(train, spec, on_iter(0))
    tagger = Tagger(model, spec)
    report = {"trained_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "engine": ENGINE_VERSION,
              "feature_set": req.feature_set, "spec": spec.to_dict(),
              "treebank": req.treebank, "project_sentences": len(project),
              "treebank_sentences": len(treebank), "held_out_source": held_out_source,
              "held_out_sentences": len(test)}
    temperature = None
    if test:
        ev = evaluate(tagger, test, vocabulary(train, spec.lowercase))
        pairs = ev.pop("_pairs")
        temperature = fit_temperature(pairs)
        report["evaluation"] = ev
        report["most_frequent_tag_accuracy"] = most_frequent_tag_accuracy(train, test,
                                                                          spec.lowercase)
        log(f"Held-out accuracy {ev['accuracy']} (unknown words {ev['unknown_word_accuracy']}, "
            f"most-frequent-tag baseline {report['most_frequent_tag_accuracy']}) on "
            f"{ev['n_tokens']} {held_out_source} tokens")
    tag_sets = {"project": sorted({t for _, ts in project for t in ts}),
                "treebank": sorted({t for _, ts in treebank for t in ts})}
    if project and treebank:
        extra = sorted(set(tag_sets["project"]) - set(tag_sets["treebank"]))
        if extra:
            report["tags_only_in_project"] = extra
            log(f"  Note: tags {extra} occur in the project but not in the treebank")
    if total_rounds == 2:
        model = train_model(everything, spec, on_iter(1))
        report["final_model"] = "all sentences"
    else:
        report["final_model"] = "training split" if test else "all sentences"
    report["temperature"] = temperature
    report["calibrated"] = temperature is not None
    report["train_seconds"] = round(time.time() - t0, 1)
    report["labels"] = sorted({t for _, ts in everything for t in ts})
    return Tagger(model, spec, temperature, report)


def save_model(tagger: Tagger, path: Path) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("model.crfsuite", tagger.model_bytes)
        z.writestr("meta.json", json.dumps({**tagger.meta, "temperature": tagger.temperature},
                                           ensure_ascii=False))
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(buf.getvalue())
    tmp.replace(path)


def load_model(path: Path) -> Tagger:
    with zipfile.ZipFile(path) as z:
        meta = json.loads(z.read("meta.json"))
        return Tagger(z.read("model.crfsuite"), FeatureSpec.from_dict(meta["spec"]),
                      meta.get("temperature"), meta)


def describe(meta: dict) -> str:
    ev = meta.get("evaluation") or {}
    lines = [f"Model {meta.get('key', '?')}: {meta.get('project_sentences', 0)} project sentence(s)"
             + (f" + {meta['treebank_sentences']} from {meta['treebank']}" if meta.get("treebank")
                else "") + f", features: {meta.get('feature_set')}"]
    if ev:
        lines.append(f"  Held-out ({meta['held_out_source']}, {ev['n_tokens']} tokens): "
                     f"accuracy {ev['accuracy']}, known words {ev['known_word_accuracy']}, "
                     f"unknown words {ev['unknown_word_accuracy']} ({ev['n_unknown']} tokens), "
                     f"macro-F1 {ev['macro_f1']}; most-frequent-tag baseline "
                     f"{meta.get('most_frequent_tag_accuracy')}")
        worst = sorted(((v["f1"], k, v["support"]) for k, v in ev["per_tag"].items()
                        if v["support"]))[:5]
        lines.append("  Weakest tags: " + ", ".join(f"{k} F1 {f} (n={n})" for f, k, n in worst))
    else:
        lines.append("  Not evaluated: too little data to hold any out.")
    lines.append(f"  Probabilities calibrated: {'yes, T=' + str(meta['temperature']) if meta.get('calibrated') else 'no'}"
                 f"; trained in {meta.get('train_seconds')} s")
    return "\n".join(lines)


# =============================================================================
# 6. Writing tags
# =============================================================================

class TagProgress(PhasedProgress):
    TRAIN = (2, 60)
    READ = (60, 65)
    TAG = (65, 80)
    WRITE = (80, 100)


def _restamp(stored_meta, frag):
    """Metadata ops putting `frag` on a stored span and removing the
    provenance keys it lacks (a person's verification, an old provProb)."""
    return ([{"op": "set", "path": [k], "value": v} for k, v in frag.items()]
            + [{"op": "delete", "path": [k]} for k in (stored_meta or {})
               if k in PROVENANCE_KEYS and k not in frag])


@dataclass
class SentenceWrites:
    new_tokens: List[dict] = field(default_factory=list)
    new_spans: List[dict] = field(default_factory=list)   # tokens: [id] or [("new", k)]
    updates: List[dict] = field(default_factory=list)
    deletes: List[str] = field(default_factory=list)
    tagged: int = 0

    def any(self):
        return bool(self.new_tokens or self.new_spans or self.updates or self.deletes)

    def size(self):
        return len(json.dumps([self.new_tokens, self.new_spans, self.updates, self.deletes],
                              default=str))


def plan_document(ud: UdDocument, tagger: Tagger, base_stamp: dict, overwrite: bool,
                  progress: Optional[TagProgress] = None):
    """-> ([SentenceWrites], counts)."""
    detail = dict(base_stamp.get("provDetail") or {})
    units, parsed, unchanged, skipped, tagged = [], 0, 0, 0, 0
    total = len(ud.sentences)
    for n, slots in enumerate(ud.sentences):
        if progress and n % 25 == 0:
            progress.count(TagProgress.TAG, n, total, f"Tagging sentence {n + 1} of {total}…")
        writable = [overwrite or not (s.upos and is_protected(s.upos[0].get("metadata")))
                    for s in slots]
        if not any(writable):
            skipped += 1
            continue
        predictions = tagger.tag([s.form for s in slots])
        unit = SentenceWrites()
        for slot, ok, (tag, top, prob) in zip(slots, writable, predictions):
            if not ok:
                continue
            frag = stamp_inferred(base_stamp["provSource"], prob=prob,
                                  detail={**detail, "value": tag, "valueProbs": top})
            stored = slot.upos[0] if slot.upos else None
            # extra UPOS spans on one syntactic word: machine-made ones go
            for extra in slot.upos[1:]:
                if overwrite or not is_protected(extra.get("metadata")):
                    unit.deletes.append(extra["id"])
            if slot.token is None:
                k = len(unit.new_tokens)
                unit.new_tokens.append({"token_layer_id": ud.synword_layer["id"],
                                        "text": ud.text_id, "begin": slot.word["begin"],
                                        "end": slot.word["end"], "metadata": dict(base_stamp)})
                unit.new_spans.append({"span_layer_id": ud.upos_layer["id"],
                                       "tokens": [("new", k)], "value": tag, "metadata": frag})
            elif stored is None:
                unit.new_spans.append({"span_layer_id": ud.upos_layer["id"],
                                       "tokens": [slot.token["id"]], "value": tag,
                                       "metadata": frag})
            elif stored.get("value") == tag:
                continue                       # already this tag (whoever wrote it): leave it
            else:
                unit.updates.append({"id": stored["id"], "value": tag,
                                     "metadata": _restamp(stored.get("metadata"), frag)})
            unit.tagged += 1
        parsed += 1
        tagged += unit.tagged
        if unit.any():
            units.append(unit)
        else:
            unchanged += 1
    return units, {"parsed_sentences": parsed, "unchanged_sentences": unchanged,
                   "skipped_sentences": skipped, "words_tagged": tagged}


def write_units(client, units: List[SentenceWrites], progress: TagProgress, log=print) -> None:
    """Write sentences in batches under the server's body cap; each batch
    holds whole sentences, so a failure leaves each sentence old or new."""
    budget = batch_body_budget(client)
    groups, cur, size = [], [], 0
    for u in units:
        s = u.size() + 64 * len(u.new_spans)
        if cur and size + s > budget:
            groups.append(cur)
            cur, size = [], 0
        cur.append(u)
        size += s
    if cur:
        groups.append(cur)
    written = 0
    try:
        for group in groups:
            progress.report(TagProgress.WRITE, written / max(len(units), 1),
                            f"Writing sentences {written + 1} to {written + len(group)}…")
            with client.batched() as b:
                tokens = [t for u in group for t in u.new_tokens]
                token_op = None
                if tokens:
                    b.tokens.bulk_create(tokens)
                    token_op = 0
                spans, offset = [], 0
                for u in group:
                    for sp in u.new_spans:
                        ref = sp["tokens"][0]
                        if isinstance(ref, tuple):
                            ref = b.ref(token_op, offset + ref[1])
                        spans.append({**sp, "tokens": [ref]})
                    offset += len(u.new_tokens)
                if spans:
                    b.spans.bulk_create(spans)
                updates = [x for u in group for x in u.updates]
                if updates:
                    b.spans.bulk_update(updates)
                deletes = [x for u in group for x in u.deletes]
                if deletes:
                    b.spans.bulk_delete(deletes)
            written += len(group)
            log(f"  wrote {written} of {len(units)} sentence(s)")
    except Exception as error:
        if written:
            raise partly_written(written, len(units), "tagged", error) from error
        raise


# =============================================================================
# 7. The service
# =============================================================================

SUMMARY = """\
Tags **UPOS** with a CRF that learns from the sentences in this project whose \
tags a person entered or confirmed, so it works for any language. Writes UPOS \
only; tokenize first.

- **Starter treebank**: also learn from a UD treebank of a related language \
(or **Other UD treebank**, e.g. `UD_Faroese-FarPaHC`).
- **Features**: *Custom* uses the project's own feature settings.
- **Overwrite**: also replace tags a person entered or confirmed.

The model retrains when the annotations or settings change. Output is marked \
machine-made, with alternatives and calibrated confidence, until confirmed.
"""

#: Servers refuse a registration URL over about 8 KB, and the extras travel in it.
MAX_EXTRAS_URL_BYTES = 6500


def extras_url_bytes(extras) -> int:
    from urllib.parse import quote
    from plaid_client.transforms import transform_request
    return len(quote(json.dumps(transform_request(extras))))


def _treebank_options():
    return [(NO_TREEBANK, "None: learn from this project only")] + list(STARTER_TREEBANKS)


class CrfTaggerService(BaseService):
    def __init__(self):
        super().__init__(
            service_id=SERVICE_ID,
            service_name="CRF part-of-speech tagger",
            description="Trainable CRF tagger for UPOS: learns from the project's annotated "
                        "sentences and, optionally, a UD treebank of a related language",
            tasks=[TASKS.PARSE],
            summary=SUMMARY,
            parameters=[
                Param.enum("treebank", "Starter treebank", _treebank_options(),
                           default=NO_TREEBANK,
                           description="A UD treebank to learn from as well as this project."),
                Param.string("other_treebank", "Other UD treebank",
                             placeholder="UD_Faroese-FarPaHC",
                             description="Any UD repository name; replaces the 'Starter treebank' choice."),
                Param.boolean("use_project_data", "Learn from this project's annotated sentences",
                              default=True),
                Param.enum("feature_set", "Features", FEATURE_SET_OPTIONS, default="standard",
                           description="What the tagger looks at in and around each word."),
                Param.boolean("overwrite", "Overwrite human-edited annotations", default=False,
                              description="Replace UPOS values a person entered or confirmed."),
            ],
        )
        self.store: Optional[ModelStore] = None
        size = extras_url_bytes(self.extras)
        if size > MAX_EXTRAS_URL_BYTES:
            raise SystemExit(f"The service description is {size} bytes in its registration URL; "
                             f"servers refuse more than about 8 KB. Shorten SUMMARY or "
                             f"STARTER_TREEBANKS.")

    def add_arguments(self, parser):
        parser.add_argument("--cache", default=str(DEFAULT_CACHE),
                            help="Where downloaded treebanks and trained models are kept")

    def setup(self, args):
        self.store = ModelStore(Path(args.cache))
        print(f"Model cache: {self.store.cache}")

    def process_request(self, request_data, response_helper):
        document_id = request_data.get("document_id")
        requester = requester_of(self.client, request_data)
        progress = TagProgress(response_helper)
        progress.report(TagProgress.TRAIN, 0.0, "Starting…")

        project_id = self.client.documents.get(document_id).get("project")
        other = (request_data.get("other_treebank") or "").strip()
        choice = request_data.get("treebank") or NO_TREEBANK
        treebank = other or (None if choice == NO_TREEBANK else choice)
        feature_set = request_data.get("feature_set") or "standard"
        req = TrainingRequest(project_id=project_id,
                              use_project_data=bool(request_data.get("use_project_data", True)),
                              treebank=treebank, feature_set=feature_set,
                              spec=self.store.spec_for(self.client, project_id, feature_set))
        # Training reads the whole project and may take minutes, so it runs
        # before the document is held: nobody waits on the document meanwhile.
        tagger, trained = self.store.get(self.client, req, progress=progress)
        if trained:
            print(describe(tagger.meta))
        meta = tagger.meta
        base = self.stamp(requester, model=f"crf-tagger:{meta.get('key', '?')}",
                          features=feature_set, **({"treebank": treebank} if treebank else {}))

        label = requester.label("CRF POS tagging")
        with self.client.operation(label, kind="service-run", ref=service_source(self.service_id)):
            with locked_for_writes(self.client, document_id, response_helper=response_helper):
                progress.report(TagProgress.READ, 0.0, "Reading the document…")
                doc = self.client.documents.get(document_id, include_body=True)
                ud = read_ud_document(doc)
                if not ud.body.strip():
                    summary = {"parsed_sentences": 0, "skipped_sentences": 0, "reason": "no-text"}
                elif not ud.sentences:
                    raise Refusal("This document has no sentences and words yet. Press Tokenize "
                                  "first, then run the tagger.")
                else:
                    units, summary = plan_document(ud, tagger, base,
                                                   bool(request_data.get("overwrite")), progress)
                    # one last checkpoint before writing, then the writes run to the end
                    progress.report(TagProgress.WRITE, 0.0, "Writing…")
                    with response_helper.critical():
                        write_units(self.client, units, progress)
        ev = meta.get("evaluation") or {}
        with response_helper.critical():
            response_helper.progress(100, "Done")
            response_helper.complete({
                "document_id": document_id, "status": "success", "mode": "tag", **summary,
                "model": {"trained_now": trained, "held_out_accuracy": ev.get("accuracy"),
                          "held_out_tokens": ev.get("n_tokens"),
                          "project_sentences": meta.get("project_sentences"),
                          "treebank_sentences": meta.get("treebank_sentences")}})


# =============================================================================
# 8. Command line
# =============================================================================

def _client(url):
    return BaseService.get_client(url)


def cmd_train(argv):
    p = argparse.ArgumentParser(prog="ud_tag_crf.py train",
                                description="Train and evaluate the tagger for a project")
    p.add_argument("project_id")
    p.add_argument("--url", default="http://localhost:8080")
    p.add_argument("--cache", default=str(DEFAULT_CACHE))
    p.add_argument("--treebank", default=None, help="UD repository name, e.g. UD_Persian-Seraji")
    p.add_argument("--features", default="standard",
                   help="standard, basic, project (the project's config) or a JSON spec file")
    p.add_argument("--no-project-data", action="store_true")
    p.add_argument("--folds", type=int, default=0, help="Also run K-fold cross-validation")
    a = p.parse_args(argv)
    client = _client(a.url)
    store = ModelStore(Path(a.cache))
    if a.features in ("standard", "basic", "project"):
        spec, fs = store.spec_for(client, a.project_id, a.features), a.features
    else:
        spec, fs = FeatureSpec.from_dict(json.loads(Path(a.features).read_text("utf-8"))), "file"
    req = TrainingRequest(a.project_id, not a.no_project_data, a.treebank, fs, spec)
    tagger, trained = store.get(client, req)
    print(("Trained. " if trained else "Already cached. ") + describe(tagger.meta))
    if a.folds:
        if a.folds < 2:
            raise SystemExit("--folds needs at least 2")
        project = store.reader.read(client, a.project_id) if req.use_project_data else []
        treebank = fetch_treebank(a.treebank, store.cache)[0] if a.treebank else []
        if len(project) < a.folds:
            raise SystemExit(f"Only {len(project)} project sentences: too few for {a.folds} folds")
        accs, unk = [], []
        for k, test_idx in enumerate(kfold(len(project), a.folds)):
            held = set(test_idx)
            train = [s for i, s in enumerate(project) if i not in held] + treebank
            test = [project[i] for i in test_idx]
            ev = evaluate(Tagger(train_model(train, spec), spec), test,
                          vocabulary(train, spec.lowercase))
            accs.append(ev["accuracy"])
            unk.append(ev["unknown_word_accuracy"] or 0.0)
            print(f"  fold {k + 1}: accuracy {ev['accuracy']}, unknown words "
                  f"{ev['unknown_word_accuracy']}")
        m = sum(accs) / len(accs)
        sd = math.sqrt(sum((x - m) ** 2 for x in accs) / len(accs))
        print(f"{a.folds}-fold CV accuracy {m:.4f} ± {sd:.4f}; unknown words "
              f"{sum(unk) / len(unk):.4f}")


def cmd_features(argv):
    p = argparse.ArgumentParser(prog="ud_tag_crf.py features",
                                description="Show or set a project's custom feature spec")
    p.add_argument("project_id", nargs="?")
    p.add_argument("--url", default="http://localhost:8080")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--set", metavar="FILE", help="JSON file with the spec")
    g.add_argument("--clear", action="store_true")
    g.add_argument("--template", action="store_true", help="Print a spec to start from")
    a = p.parse_args(argv)
    if a.template:
        spec = preset_spec("standard")
        spec.char_classes = {"vowel": ["a", "e", "i", "o", "u"]}
        spec.regex_features = {} # "example-suffix": "(?:ing|ed)$"
        print(json.dumps(spec.to_config(), indent=2, ensure_ascii=False))
        return
    if not a.project_id:
        p.error("project_id is required")
    client = _client(a.url)
    if a.set:
        spec = FeatureSpec.from_dict(json.loads(Path(a.set).read_text("utf-8")))
        client.projects.set_config(a.project_id, CONFIG_NAMESPACE, CONFIG_SPEC_KEY,
                                   spec.to_config())
        print("Saved. Choose Features: Custom in the Parse dialog to use it.")
    elif a.clear:
        client.projects.set_config(a.project_id, CONFIG_NAMESPACE, CONFIG_SPEC_KEY, None)
        print("Cleared.")
    else:
        cfg = (client.projects.get(a.project_id).get("config") or {}).get(CONFIG_NAMESPACE) or {}
        print(json.dumps(cfg.get(CONFIG_SPEC_KEY), indent=2, ensure_ascii=False))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "train":
        cmd_train(sys.argv[2:])
    elif cmd == "features":
        cmd_features(sys.argv[2:])
    elif cmd == "treebanks":
        for repo, label in STARTER_TREEBANKS:
            print(f"{repo:34} {label}")
        print("\nAny other UD repository name also works (the dialog's 'Other UD treebank' box, "
              "or train --treebank); see https://universaldependencies.org")
    else:
        CrfTaggerService().run()


if __name__ == "__main__":
    main()
