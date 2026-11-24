# CRF part-of-speech tagger for Plaid UD

Author: J. Elizabeth Liebl 
Contact: jliebl@gmu.edu

`ud_tag_crf.py` is a [Plaid](https://larc-iu.github.io/plaid/) service that tags the
words of a document with Universal Dependencies part-of-speech tags (UPOS). It uses a
conditional random field (CRF), a statistical model that works well with small amounts
of data, and it learns from your own project's annotations, so it works for any
language once some sentences are tagged. If you have no annotated data yet, it can also
learn from a Universal Dependencies treebank of a related language.

You can use it in two ways:

- **From the Plaid UD app**: it appears under **Parse**, next to any other parser.
- **From the command line**: train a model, see how accurate it is, and design your own
  features for the tagger to use.

This guide covers both. If you only want to tag documents, read sections 1–4. If you
want to design features for your language, read section 6.

**Contents**

1. [What you need](#1-what-you-need)
2. [Key terms](#2-key-terms)
3. [Setting up and starting the service](#3-setting-up-and-starting-the-service)
4. [Tagging documents in the UD app](#4-tagging-documents-in-the-ud-app)
5. [The command line](#5-the-command-line)
6. [Designing your own features](#6-designing-your-own-features)
7. [Reading the evaluation report](#7-reading-the-evaluation-report)
8. [How models are trained and stored](#8-how-models-are-trained-and-stored)
9. [Troubleshooting](#9-troubleshooting)
10. [Limitations](#10-limitations)

---

## 1. What you need

- A running Plaid server (for a local one, see the
  [Plaid Quick Start](https://larc-iu.github.io/plaid/#_quick_start)) and a project made in
  the **UD** app.
- Python 3.11 or later.
- The Python packages:

  ```bash
  pip install larc-plaid-client python-crfsuite regex
  ```

  If you work from a checkout of the Plaid repository, install the client from it instead
  (`pip install -e plaid-client-py`), so that client and server versions match.
- `git` is optional: it is used to download a starter treebank when the GitHub API is
  unavailable.

No GPU is needed. Training takes seconds for a few hundred sentences and about a minute
for several thousand.

## 2. Key terms

**Token and syntactic word.** A *token* is a unit of the text as written: the UD app's
**Tokens** layer (Plaid's `word` role). A *syntactic word* is a unit the grammar sees: the
UD app's **Words** layer (Plaid's `syntactic-word` role). Usually the two are the same. A
contraction such as Spanish *del* is one token holding two syntactic words, *de* + *el*.
UPOS tags go on syntactic words, so that is what the tagger tags. In what follows, "word"
means syntactic word.

**Made by a person vs. made by a machine.** Plaid records who made each annotation. A
tag typed or confirmed by a person, or imported from a CoNLL-U file, counts as **made by
a person**. A tag written by a service (this one, Stanza, …) is **machine-made** until a
person confirms it, and the UD app shows it in violet until then.

**Gold sentence.** A sentence in which *every* word has a UPOS tag made by a person.
These are what the tagger learns from.

**Feature.** Something the tagger notices about a word, such as "ends in *-ler*" or "the
word before it is *the*". The tagger learns which features predict which tags. You can
change which features it uses (section 6).

## 3. Setting up and starting the service

### 3.1 Make an API token

The service logs in to Plaid with a named API token. In any Plaid app, open your
**Profile → API Tokens**, create a token (name it, for example, "crf-tagger"), and copy it.
It is shown only once.

### 3.2 Start the service

Run the script from the folder you want it to work in:

```bash
python ud_tag_crf.py
```

The first time, it asks for the token and saves it in a file called `.token` in the
current folder. **Every command in this guide must be run from that folder**, or it will
ask for the token again. Keep `.token` private and out of version control.

It is ready when it prints:

```
CRF part-of-speech tagger serving 1 project(s); … Waiting for requests…
```

Leave the terminal open: the tagger is only available while the script is running. Press
Ctrl+C to stop it.

Options:

| Option | What it does |
|---|---|
| `PROJECT_ID …` | Serve only these projects. With none, it serves every project the token can reach, including ones created later. |
| `--url URL` | The Plaid server's address. Default: `http://localhost:8080`. |
| `--cache DIR` | Where models and downloaded treebanks are kept. Default: `~/.cache/plaid/crf-tagger`. |

It can run at the same time as other services, such as the Stanza parser, with the same
`.token` file.

### 3.3 Find your project ID

Several commands need the project's ID. Open the project in the UD app and look at the
address bar:

```
http://localhost:8080/ud/#/projects/01a20a9f-ae2d-7000-a56c-cc436e672183/documents
                                    └──────────── project ID ────────────┘
```

Or list every project your token can see:

```bash
python -c "
from plaid_client import PlaidClient
c = PlaidClient('http://localhost:8080', open('.token').read().strip())
for p in c.projects.list(): print(p['id'], p['name'])
"
```

## 4. Tagging documents in the UD app

1. Make sure the document is **tokenized** (it has sentences and tokens). If not, press
   **Tokenize** first. The tagger refuses an untokenized document.
2. Press **Parse** and choose **CRF part-of-speech tagger** as the method.
3. Set the options (below) and start the run.

The first run trains a model, which shows as "Training the tagger…" in the progress bar.
Later runs reuse that model until the training data or the settings change.

### 4.1 Options

| Option | What it does |
|---|---|
| **Starter treebank** | A Universal Dependencies treebank to learn from as well as your project. Useful when you have few gold sentences. Choose a closely related language, or at least one written in the same script: a treebank in another script contributes almost nothing. Downloaded once, then kept. |
| **Other UD treebank** | Any other UD treebank, by its repository name (e.g. `UD_Faroese-FarPaHC`; see [universaldependencies.org](https://universaldependencies.org)). When filled in, it replaces the choice above. |
| **Learn from this project's annotated sentences** | Train on the project's gold sentences. On by default. Turn it off to tag with a treebank model alone. |
| **Features** | What the tagger looks at. **Standard** suits most languages. **Basic** is smaller and simpler. **Custom** uses your project's own feature settings (section 6). |
| **Overwrite human-edited annotations** | Also replace tags a person entered or confirmed. Off by default. |

If you choose neither a treebank nor project data, or the project has no gold sentences
and no treebank is chosen, the run is refused with a message saying so.

### 4.2 What a run changes

For each word in each sentence:

- **no UPOS tag yet**: a tag is added;
- **a machine-made tag**: replaced if the tagger now predicts a different one;
- **a tag a person made or confirmed**: left alone, unless **Overwrite** is on;
- **a tag that already matches the prediction**: left alone, whoever made it.

A token with no syntactic word yet gets one covering the whole token. Nothing else
changes: no tokens are deleted, and lemmas, features and dependency relations are never
written.

Everything the tagger writes is marked as machine-made, with:

- its **top three alternatives** and their probabilities, which the UD editor offers when
  you correct a tag;
- its **confidence** in the chosen tag, which the editor shows on hover, when the model
  could be calibrated (section 8).

Confirm a tag in the editor and it counts as made by a person from then on, so it becomes
training data once its whole sentence is confirmed.

When the run ends, the app reports how many sentences were tagged, how many were already
as the tagger would tag them, and how many were kept because a person had tagged every
word in them.

## 5. The command line

Run these from the folder holding `.token`. Add `--url URL` to any of them if your
server is not at `http://localhost:8080`.

### 5.1 `train`: train a model and see how good it is

```bash
python ud_tag_crf.py train PROJECT_ID
```

This trains the same model the UD app would train with the same settings, stores it so
the next **Parse** starts at once, and prints an evaluation (section 7):

```
Project has 200 fully annotated sentence(s) in 2 document(s)
Training on 180 sentence(s) (200 from the project, 0 from no treebank), holding out 20
Held-out accuracy 0.9211 (unknown words 0.7593, most-frequent-tag baseline 0.8927) on 317 project tokens
Trained. Model f7642eedb9eefedddfe3: 200 project sentence(s), features: standard
  Held-out (project, 317 tokens): accuracy 0.9211, known words 0.9544, unknown words 0.7593 (54 tokens), macro-F1 0.7632; most-frequent-tag baseline 0.8927
  Weakest tags: NUM F1 0.0 (n=1), X F1 0.0 (n=1), ADJ F1 0.4706 (n=10), ADV F1 0.7273 (n=7), DET F1 0.75 (n=3)
  Probabilities calibrated: yes, T=1.05; trained in 1.6 s
```

Options:

| Option | What it does |
|---|---|
| `--features NAME_OR_FILE` | `standard` (default), `basic`, `project` (the project's saved custom features), or the path to a JSON feature file (section 6). |
| `--treebank UD_NAME` | Also learn from this UD treebank, e.g. `UD_Persian-Seraji`. |
| `--no-project-data` | Ignore the project's sentences (use with `--treebank`). |
| `--folds K` | Also run K-fold cross-validation on the project's gold sentences (section 7.2). The best way to compare feature sets. |
| `--cache DIR` | As for the service. |

### 5.2 `features`: show, save or remove a project's custom features

```bash
python ud_tag_crf.py features --template > my_features.json   # write a file to start from
python ud_tag_crf.py features PROJECT_ID --set my_features.json # save it to the project
python ud_tag_crf.py features PROJECT_ID                        # show what is saved
python ud_tag_crf.py features PROJECT_ID --clear                # remove it
```

`--set` checks the file first and refuses it, naming the problem, if anything is wrong.
Saving changes the project's settings, so your account needs permission to change them;
if it is refused, ask a project maintainer.

### 5.3 `treebanks`: list the starter treebanks

```bash
python ud_tag_crf.py treebanks
```

Lists the treebanks in the **Starter treebank** menu. Any other UD treebank can be named
in **Other UD treebank** or with `train --treebank`.

## 6. Designing your own features

The built-in feature sets look at the word itself, its beginning and end, its shape and
its neighbours. That goes a long way, but you know things about your language that the
tagger does not: which sounds count as vowels, which endings mark a plural, which
prefixes mark negation. Custom features let you tell it.

### 6.1 The workflow

1. **Write a starting file.** This command creates a new file; name it whatever you like:

   ```bash
   python ud_tag_crf.py features --template > my_features.json
   ```

   It holds the Standard feature set plus **two placeholders**: a `vowel` class with
   English vowels and an `example-suffix` pattern for English *-ing*/*-ed*. **Replace or
   delete both.** If you leave them, they become part of your model.

2. **Edit the file** in any text editor. Section 6.2 explains every setting; section 6.5
   has examples.

3. **Measure it against the built-in features.** Nothing is saved to the project yet:

   ```bash
   python ud_tag_crf.py train PROJECT_ID --features standard --folds 5
   python ud_tag_crf.py train PROJECT_ID --features my_features.json --folds 5
   ```

   Compare the last lines (section 7.2 explains how to read them). This needs gold
   sentences in the project, or a `--treebank`.

4. **Repeat steps 2 and 3** until you are happy. Keep copies of versions you might return
   to (`my_features_v1.json`, `my_features_v2.json`, …).

5. **Save the winner to the project:**

   ```bash
   python ud_tag_crf.py features PROJECT_ID --set my_features.json
   ```

6. **Use it in the UD app:** in **Parse**, set **Features** to **Custom**. If you already
   ran `train` with this exact file, and the project's gold sentences have not changed
   since, the model it trained is reused and the run starts at once.

### 6.2 Every setting

The file is JSON: a list of `"name": value` pairs between braces. Names and text go in
**double quotes**; `true`, `false` and numbers do not. Settings you leave out take the
default shown here (the defaults of the file itself; the **Standard** feature set changes
some of them, as the template shows). Any setting name the tagger does not know is
refused, so a typo cannot slip through.

#### What the tagger looks at

| Setting | Values | Default | What it does |
|---|---|---|---|
| `"window"` | 0–4 | `1` | How many words on each side of a word the tagger looks at. `0`: the word alone. `2`: two before and two after. Larger windows help with word order but need more data. |
| `"prefixLengths"` | list of 1–10 | `[1, 2, 3]` | The word's first N **segments**, one feature per length. `[1, 2]` gives features for the first segment and the first two. `[]` turns prefixes off. |
| `"suffixLengths"` | list of 1–10 | `[1, 2, 3]` | The same for the word's last N segments. For a language with long suffixes, try up to 5 or 6. |
| `"neighborAffixes"` | true / false | `true` | Whether neighbouring words also get prefix and suffix features. |
| `"lowercase"` | true / false | `true` | Lowercase the word before making features, so *Ez* and *ez* are one word. Capitalization is still seen through `"shape"`. See the note below on regular expressions. |
| `"shape"` | true / false | `true` | Five features from the word as written: starts with a capital; all capitals; contains a digit; is only punctuation or symbols; has a hyphen inside it. |
| `"length"` | true / false | `false` | The word's length in segments (15 or more counts as 15). |
| `"position"` | `"edge"` / `"absolute"` | `"edge"` | `"edge"` marks the first and last word of the sentence. `"absolute"` instead gives every word its position number (1st, 2nd, …; 31 or more counts as 31). |
| `"charClasses"` | names → lists | none | Named groups of characters (section 6.3). |
| `"regexFeatures"` | names → patterns | none | Named patterns (section 6.4). |
| `"neighborExtras"` | true / false | `false` | Whether neighbouring words also get the length, shape, class and pattern features. Neighbours always get their word form. |

**Segments.** Lengths and affixes count *segments*, not keyboard characters: a letter
together with any combining marks and modifier letters that follow it. So *t̪*, *kʰ*,
*aː*, *î* and *kʼ* each count as one, and a 2-segment suffix of *kʰaːn* is *aːn*.

#### How the tagger learns

| Setting | Values | Default | What it does |
|---|---|---|---|
| `"c1"` | 0 or more | `0.1` | L1 regularization (see below). |
| `"c2"` | 0 or more | `0.05` | L2 regularization (see below). |
| `"maxIterations"` | 1–2000 | `150` | How many training steps to take at most. More steps take longer and rarely help past a few hundred. |

**Regularization** stops the tagger from leaning too hard on any one feature. Without it,
a tagger trained on a small corpus memorizes: if a word appeared once with a wrong tag,
it will repeat that mistake with high confidence. Both settings penalize features the
tagger gives a lot of weight to:

- `c1` pushes features that barely help down to exactly zero, so they are dropped.
  Higher `c1` means a smaller, simpler model.
- `c2` shrinks every feature's weight a little. Higher `c2` means smoother, more cautious
  predictions.

Values between 0 and 1 are the usual range. Raise them if the tagger does much better on
words it has seen than on new ones, or repeats one-off errors; lower them if it does
poorly across the board. Change one at a time and measure each change with `--folds`.

### 6.3 Character classes

A character class is a named group of characters:

```json
"charClasses": {
  "vowel": ["a", "e", "i", "o", "u", "aː", "eː", "ə"],
  "nasal": ["m", "n", "ŋ"]
}
```

Each class gives every word two features:

- `n.vowel=2`: how many times the class occurs in the word (10 or more counts as 10);
- `end.vowel`: the word ends in a member of the class.

Details:

- A member can be several characters, such as `"aː"` or `"ts"`. Longer members are
  matched first, so *aː* counts once as `aː`, not once as `a` plus a leftover `ː`.
- When `"lowercase"` is on, members are lowercased for you, so `"A"` and `"a"` are the same.
- Class names may contain letters, digits, `_` and `-`.
- To know *which* vowel a word ends in, you do not need a class: a 1-segment suffix
  (`"suffixLengths"` containing `1`) already says it.

### 6.4 Regular expressions

A regular expression ("regex") is a pattern for matching text. Each named pattern gives a
word a feature when the pattern matches anywhere in it:

```json
"regexFeatures": {
  "plural": "(?:ler|lar)$",
  "negative": "^(?:ne|me)",
  "reduplicated": "^(\\w+)-\\1$"
}
```

Here `plural` fires for words ending in *-ler* or *-lar*, `negative` for words beginning
with *ne-* or *me-*, and `reduplicated` for hyphenated full reduplication such as
*kata-kata* (`\1` repeats whatever the group in brackets matched).

Rules to know:

- **Anchor your patterns.** A pattern matches *anywhere* in the word. `"ler"` fires for
  *evler* but also for *lerzan*. Use `$` for "ends with" and `^` for "begins with".
- **Write patterns in lowercase when `"lowercase"` is on** (the default). Patterns are
  matched against the lowercased word, so `"^Ne"` will never match anything. This is the
  most common reason a pattern silently does nothing.
- **Double every backslash.** JSON uses `\` itself, so the regex `\w` is written `"\\w"`
  and `\p{L}` (any letter) is written `"\\p{L}"`. A single backslash makes the file
  invalid, and `--set` says so.
- `(?:…)` groups alternatives without capturing: `(?:ler|lar)$` means "ends in *ler* or *lar*".
- Patterns are matched on the word in composed Unicode form (NFC), as is the pattern
  itself, so *ê* typed as one character or as *e* + a combining circumflex behaves the
  same.
- A pattern that takes more than 0.05 seconds on one word is treated as not matching.
  This protects the server from patterns that never finish.
- The tagger uses Python's [`regex`](https://pypi.org/project/regex/) module, which
  understands everything Python's built-in `re` does plus Unicode classes such as
  `\p{L}`. For learning the syntax, the
  [W3Schools Python RegEx page](https://www.w3schools.com/python/python_regex.asp) is a
  gentle start. To try a pattern on your own words before using it,
  [regex101.com](https://regex101.com) with the "Python" flavour selected is handy.

Every pattern adds a feature that the tagger then has to learn to use. A handful of
well-chosen patterns usually beats a long list, and an unhelpful one can make results
slightly worse, which `--folds` will show.

### 6.5 Examples

A complete file for a mostly suffixing language with vowel length:

```json
{
  "window": 2,
  "prefixLengths": [1, 2],
  "suffixLengths": [1, 2, 3, 4, 5],
  "neighborAffixes": true,
  "lowercase": true,
  "shape": true,
  "length": true,
  "position": "edge",
  "charClasses": {
    "vowel": ["a", "e", "i", "o", "u", "aː", "eː", "iː", "oː", "uː"]
  },
  "regexFeatures": {
    "plural": "(?:ler|lar)$",
    "past": "(?:di|dı|du|dü)$",
    "negative": "^(?:ne|me)"
  },
  "neighborExtras": false,
  "c1": 0.1,
  "c2": 0.05,
  "maxIterations": 150
}
```

A minimal file. Everything not listed takes its default:

```json
{
  "suffixLengths": [1, 2, 3, 4],
  "regexFeatures": {"clitic": "=\\w+$"}
}
```

**Porting a feature set from another CRF tagger.** Most hand-written CRF feature
functions map onto these settings:

| If your old features had… | Use |
|---|---|
| the word and its neighbours | always included; set `"window"` |
| `word[-3:]`, `word[:2]`, … | `"suffixLengths"`, `"prefixLengths"` (counted in segments here) |
| `word.isupper()`, `word.istitle()`, `word.isdigit()` | `"shape": true` |
| `len(word)` | `"length": true` |
| the word's index in the sentence | `"position": "absolute"` |
| vowel or consonant counts | `"charClasses"` |
| "ends in X" flags for particular suffixes | `"regexFeatures"` with `$`; each pattern is its own feature, so a word can fire several |
| the same features for neighbouring words | `"neighborAffixes"`, `"neighborExtras"` |
| the *tags* of neighbouring words | not needed: the CRF models tag sequences itself, and using gold tags as features leaks the answers during evaluation |

### 6.6 What the tagger actually sees

For the curious: every feature is a short string, prefixed with which word it describes.
`0:` is the word being tagged, `-1:` the word before, `+2:` two words after. For the
word *evler* with the defaults, the tagger sees features like:

```
bias  0:w=evler  0:p1=e  0:p2=ev  0:s1=r  0:s2=er  0:s3=ler  0:n.vowel=2  0:re.plural
-1:w=…  -1:s1=…  +1:w=…  BOS
```

`PAD` stands in for a neighbour beyond the start or end of the sentence. The tags of
neighbouring words are never features: the CRF learns which tags follow which on its own.

## 7. Reading the evaluation report

### 7.1 The numbers

| Number | Meaning |
|---|---|
| **accuracy** | Share of held-out words tagged correctly. |
| **known words** | Accuracy on held-out words that also occur in the training data. |
| **unknown words** | Accuracy on held-out words the tagger has never seen. This is where good features show most, since the tagger can only go by the word's form and context. |
| **macro-F1** | The average of each tag's F1 score, every tag counting equally. Low when rare tags are often wrong, even if accuracy is high. |
| **most-frequent-tag baseline** | The accuracy of simply giving every word the tag it most often had in training (and the most common tag overall to unseen words). The tagger should beat this clearly. |
| **weakest tags** | The five tags with the lowest F1, with how many held-out words had that tag (`n`). A tag with `n=1` tells you very little. |
| **calibrated** | Whether the tagger's confidence values were adjusted on held-out data so that they can be taken at face value (section 8). |

The full report, with precision, recall and F1 for every tag and a confusion matrix
showing which tags are mistaken for which, is saved next to the model as
`~/.cache/plaid/crf-tagger/models/<model key>.report.json`. The model key is printed
after `Model` in the report.

### 7.2 Comparing feature sets: use `--folds`

The plain report tests on a single held-out tenth of your gold sentences. With a small
project that may be only a few hundred words, and one or two words can move it by a
point. To compare feature sets, use cross-validation:

```bash
python ud_tag_crf.py train PROJECT_ID --features my_features.json --folds 5
```

```
  fold 1: accuracy 0.8574, unknown words 0.7182
  …
  fold 5: accuracy 0.8882, unknown words 0.6619
5-fold CV accuracy 0.8948 ± 0.0216; unknown words 0.7283
```

The gold sentences are split into 5 parts; the tagger is trained on 4 and tested on the
fifth, 5 times over, so every sentence is tested once. The last line gives the average
accuracy, its spread (±, one standard deviation across the folds) and the average
unknown-word accuracy.

- The folds are the same every run, for every feature file, as long as the project's gold
  sentences have not changed. So two runs compare the features, not the luck of the split.
- A difference smaller than the ± is probably noise. Prefer the simpler feature set when
  two are that close.
- With a treebank (`--treebank`), the treebank is added to every training part but never
  tested on: the score is always on your own language.
- Cross-validation trains K models, so it takes K times as long as one training run.

## 8. How models are trained and stored

**What it trains on.** Every gold sentence in the project (if **Learn from this project**
is on), plus the treebank's training sentences (if one is chosen). A treebank larger
than 8,000 sentences is cut to a fixed random sample of 8,000 to keep training time
reasonable. Sentences with a machine-made tag anywhere in them are never used, including
the tagger's own output.

**Held-out evaluation and calibration.** Before the final model is trained, a tenth of
the gold sentences is held out to measure accuracy (the report in section 7). That needs
at least 20 gold sentences; with fewer, a tenth of the treebank is held out instead, and
with neither, the model is not evaluated. When the held-out part has at least 200 words,
the tagger's probabilities are also **calibrated** on it, so that tags given 80%
confidence are right about 80% of the time; only then are confidence values written into
Plaid. If there are 4,000 sentences or fewer in all, the final model is then retrained on
everything, held-out part included.

**When it retrains.** A model is identified by its training data, treebank, feature
settings and the tagger's own version. When any of these changes (a sentence is confirmed
or corrected, you pick another treebank, you save new features), the next run trains a
new model. Otherwise the stored one is reused.

**Where models are kept.** In `~/.cache/plaid/crf-tagger` (or `--cache DIR`):

```
models/<key>.zip           the model and its settings
models/<key>.report.json   the full evaluation report
treebanks/<UD name>/       downloaded treebanks
```

These files are safe to delete: anything missing is retrained or downloaded again when
next needed. Deleting a project in Plaid does not delete its models here.

## 9. Troubleshooting

| Message or problem | What to do |
|---|---|
| The UD app says **"No parsing service is online for this project"** | The service is not running, or not serving this project. Start it (section 3.2) and reopen **Parse**. |
| **"This document has no sentences and words yet"** | Press **Tokenize** in the UD app, then **Parse**. |
| **"There is nothing to learn from yet"** | No sentence in the project has every word tagged by a person, and no treebank was chosen. Tag some sentences by hand, import a CoNLL-U file, or choose a starter treebank. |
| **"This project has no custom feature settings yet"** | You chose **Features: Custom** before saving any. Save a file with `features PROJECT_ID --set` (section 5.2), or choose Standard. |
| **"The project's custom feature settings are invalid"** or `FeatureSpecError` | The message names the setting at fault. Common causes: a single backslash in a pattern, an unknown setting name, a list where a number belongs, or the reverse. |
| JSON errors such as `Expecting property name enclosed in double quotes` | The file is not valid JSON: single quotes instead of double, a trailing comma after the last item, or a missing comma. |
| A regex feature never seems to help | Check that it is in lowercase (section 6.4) and anchored. `train` with and without it, using `--folds`, to see whether it matters. |
| **"Could not download UD_…"** | Check the treebank's name on universaldependencies.org and that the machine can reach github.com. Unauthenticated GitHub API use is limited to 60 requests an hour; the tagger then tries `git clone`, which needs `git` installed. |
| The service asks for a token every time | Run it from the folder holding `.token`. |
| **"Plaid rejected that token"** | The token was revoked or mistyped. Make a new one (section 3.1) and delete `.token`. |
| A run seems stuck at "Training the tagger" | Training on a large treebank can take a few minutes; the step count keeps moving. **Stop** in the UD app ends it, and the document is left as it was. |
| The service will not start: **"The service description is … bytes"** | Only if you edited the script: the list of starter treebanks or the summary has grown too long for Plaid's registration URL (about 8 KB). Shorten one of them. |

## 10. Limitations

- **UPOS only.** It does not write lemmas, morphological features, XPOS or dependency
  relations. It registers for Plaid's `parse` task because that is where POS tagging is
  offered in the UD app.
- **Overwrite cannot catch a person's mistakes in the training data.** Gold sentences are
  training data, so a wrong tag in them is learned, and an overwrite run reproduces it.
  Overwrite is for replacing tags with the tagger's own; to find errors, look at the
  tagger's low-confidence tags and the confusion matrix instead.
- **Tag sets must agree.** When combining your project with a treebank, both should use
  the UD UPOS tags. Tags found in your project but not in the treebank are listed in the
  training log.
- **The treebank menu is short.** Plaid's registration URL limits how many treebanks fit
  in the menu; use **Other UD treebank** for the rest.
- **One request at a time.** The service handles one run at a time across all the
  projects it serves; a second request arriving meanwhile is asked to try again later.

