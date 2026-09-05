"""Sentence augmentation: dig4el's "Grammatical Descriptor" and "Sentence Selector".

The schema (``Sentence``) and both instruction texts are Sebastien Christian's, copied
verbatim from ``libs/semantic_description_agents.py`` (dig4el, AGPL-3.0). Only the
transport changed: the agents ran on OpenAI's Agents SDK with o4-mini; here they are
one schema-constrained chat completion each on the configured endpoint.
"""

from __future__ import annotations

import json
from typing import List, Literal, Optional, Tuple

from pydantic import BaseModel

from .llm import LLM

Intent = Literal[
    "assert", "ask", "order", "doubt", "wish",
    "agree", "disagree", "greet", "thank", "acknowledge", "other"
]

Mood = Literal[
    "indicative",     # factual statements, questions
    "imperative",     # commands, requests
    "subjunctive",    # hypotheticals, wishes, counterfactuals
    "conditional",    # events dependent on conditions
    "optative",       # wishes, hopes
    "jussive",        # mild commands, exhortations (often 3rd person)
    "hortative",      # urging, encouragement (often 1st person plural, “let’s”)
    "desiderative",   # wanting, intention
    "admirative",     # surprise, unexpected information
    "potential",      # possibility, ability
    "necessitative",  # obligation, necessity
    "permissive",     # allowance
    "interrogative",  # direct questions (sometimes treated as a mood)
    "injunctive",     # prohibitions, negative commands
    "epistemic-possibility",
    "epistemic-probability",
    "epistemic-necessity",
    "deontic-obligation",
    "deontic-permission",
    "deontic-prohibition",
    "desiderative",
    "other"           # catch-all
]

ActOfSpeech = Literal[
    "assertive",       # stating, describing, claiming (commitment to truth of a proposition)
    "directive",       # asking, ordering, requesting (aimed at getting hearer to do something)
    "commissive",      # promising, vowing, pledging (speaker commits to future action)
    "expressive",      # thanking, apologizing, congratulating (express psychological state)
    "declarative",     # pronouncing, christening, resigning (changes institutional reality)
    "interrogative",   # asking questions (sometimes treated as a subtype of directives)
    "phatic",          # greetings, leave-takings, small talk (manage social connection)
    "performative",    # explicit acts by saying them (“I apologize”, “I promise”)
    "metalinguistic",  # commenting on or clarifying language itself
    "other"            # catch-all
]

TypeOfPredicate = Literal[
    "existential",     # Something exists
    "locative",        # Something is somewhere
    "attributive",     # Something displays a quality
    "inclusive",       # Something belongs to a class/category
    "possessive",      # Something belongs to something
    "processive",      # Something happens
    "other"
]

Polarity = Literal["positive", "negative", "mixed"]

Tense = Literal[
    "present",         # action happening now
    "past",            # general past
    "future",          # general future
    "recent_past",     # just happened
    "remote_past",     # long ago
    "imperfect_past",  # continuous / habitual past
    "perfect_past",    # past with present relevance
    "near_future",     # about to happen soon
    "remote_future",   # far-off future
    "aorist",          # past, unmarked for aspect (common in Greek, Sanskrit, etc.)
    "gnomic",          # timeless / general truths
    "other"            # catch-all
]

Aspect = Literal[
    "perfective",       # whole event viewed as complete
    "imperfective",     # event seen as ongoing or unbounded
    "progressive",      # action in progress ("is doing")
    "habitual",         # repeated, customary action
    "perfect",          # relevance to present / resultative state
    "prospective",      # action about to happen
    "inceptive",        # beginning of an action
    "terminative",      # ending or completion of an action
    "iterative",        # repeated occurrences of an action
    "frequentative",    # action happens often
    "semelfactive",     # punctual, one-time action
    "durative",         # action extends over time
    "gnomic",           # timeless truth or general fact
    "stative",          # describes a state
    "dynamic",          # describes an action or process
    "experiential",     # having ever done something
    "continuative",     # action continuing without interruption
    "resultative",      # focus on result state
    "other"             # catch-all
]

SpatialLocation = Literal[
    "proximal",     # close to the speaker ("this", "here")
    "medial",       # close to the addressee ("that (near you)")
    "distal",       # far from both speaker and addressee ("that over there")
    "contact",      # touching or immediately adjacent
    "remote",       # very far / out of sight
    "anaphoric",    # referring back to something already mentioned
    "visible",      # demonstratives restricted to things in sight
    "invisible",    # demonstratives for things out of sight
    "uphill",       # location relative to elevation (common in Oceanic languages)
    "downhill",     # idem
    "seaward",      # oriented toward sea/ocean
    "landward",     # oriented toward land
    "other"
]

Directionality = Literal[
    "ventive",       # motion toward the speaker ("come here")
    "itive",         # motion away from the speaker ("go away")
    "cislocative",   # motion toward the deictic center (often speaker’s location)
    "translocative", # motion away from the deictic center
    "uphill",        # movement upward or inland
    "downhill",      # movement downward or seaward
    "upwind",        # in the direction the wind is coming from
    "downwind",      # in the direction the wind is going to
    "seaward",       # toward the ocean
    "landward",      # toward the land
    "inward",        # into an enclosed space
    "outward",       # out of an enclosed space
    "across",        # lateral motion across a boundary
    "along",         # motion following a path
    "away",          # motion in a direction unspecified but leaving
    "toward",        # motion in the direction of a goal
    "back",          # returning motion
    "other"
]

SentenceComplexity = Literal["simple", "coordination", "subordination", "compound_complex", "elliptical", "unknown"]

PersonalPronoun = Literal[
    # 1st person
    "first person singular",
    "first person dual inclusive", "first person dual exclusive",
    "first person trial inclusive", "first person trial exclusive",
    "first person plural inclusive", "first person plural exclusive",
    # 2nd person
    "second person singular", "second person dual", "second person trial", "second person plural",
    # 3rd person
    "third person singular", "third person dual", "third person trial", "third person plural"
]

OtherPronoun = Literal["demonstrative", "interrogative", "indefinite", "relative", "reflexive", "reciprocal"]

Possession = Literal[
    "alienable",       # possessions separable from the possessor (house, dog, car)
    "inalienable",     # inherent possessions (body parts, kinship terms)
    "predicative",     # expressed as “X has Y” (possessive verb or existential)
    "attributive",     # expressed as “X’s Y” (possessive pronoun, genitive marker)
    "inalienable_split", # split depending on kinship/body vs objects (common in Oceanic)
    "indirect",        # possession through a classifier or relational noun
    "direct",          # bare juxtaposition of possessor and possessed
    "locative",        # possession expressed through location (“at me there is…”)
    "have_verb",       # dedicated verb “to have”
    "existential",     # expressed with “there is to X” construction
    "pronominal_suffix", # possessor marked as suffix/clitic
    "genitive_case",   # possession marked morphologically on possessor
    "construct_state", # possessed noun changes form (Semitic construct state)
    "other"
]

ClassifierType = Literal["gender", "other classifier"]

NumberQuantifier = Literal["zero", "one", "two", "three", "a few", "many", "none", "some", "all"]

Evidentiality = Literal[
    "direct", "reported", "inferred", "assumed", "visual", "nonvisual", "hearsay"
]

Voice = Literal["active", "passive", "middle", "antipassive", "applicative", "causative"]

class Sentence(BaseModel):
    original_sentence: str

    # Lists so the description can contain multiple values if present
    intent: List[Intent]
    mood: List[Mood]
    act_of_speech: List[ActOfSpeech]
    type_of_predicate: Optional[List[TypeOfPredicate]] = None
    evidentiality: Optional[List[Evidentiality]] = None
    voice: Optional[List[Voice]] = None
    polarity: Optional[List[Polarity]] = None
    tense: Optional[List[Tense]] = None
    aspect: Optional[List[Aspect]] = None
    spatial_location: Optional[List[SpatialLocation]] = None
    directionality: Optional[List[Directionality]] = None
    sentence_complexity: list[SentenceComplexity]
    possession: Optional[List[Possession]] = None
    personal_pronouns: Optional[List[PersonalPronoun]] = None
    other_pronouns: Optional[List[OtherPronoun]] = None
    classifiers: Optional[List[ClassifierType]] = None
    numbers: Optional[List[NumberQuantifier]] = None
    key_translation_concepts: List[str]
    comment: str = ""

    def make_facet_str(self) -> Tuple[str, List[str]]:

        facets = []
        kw = []

        # Helper
        def add_facet_and_keywords(attribute_name: str, attribute_value: Optional[List[str]], facets: List[str],
                                   kw: List[str]):
            if attribute_value:
                facets.append(f"{attribute_name}=" + " & ".join(attribute_value))
                kw += attribute_value

        # Build facets only for fields that have values; join lists with " & "

        add_facet_and_keywords("intent", self.intent, facets, kw)
        add_facet_and_keywords("mood", self.mood, facets, kw)
        add_facet_and_keywords("act_of_speech", self.act_of_speech, facets, kw)
        add_facet_and_keywords("type_of_predicate", self.type_of_predicate, facets, kw)
        add_facet_and_keywords("evidentiality", self.evidentiality, facets, kw)
        add_facet_and_keywords("voice", self.voice, facets, kw)
        add_facet_and_keywords("polarity", self.polarity, facets, kw)
        add_facet_and_keywords("tense", self.tense, facets, kw)
        add_facet_and_keywords("aspect", self.aspect, facets, kw)
        add_facet_and_keywords("spatial_location", self.spatial_location, facets, kw)
        add_facet_and_keywords("directionality", self.directionality, facets, kw)
        add_facet_and_keywords("possession", self.possession, facets, kw)
        add_facet_and_keywords("personal_pronouns", self.personal_pronouns, facets, kw)
        add_facet_and_keywords("other_pronouns", self.other_pronouns, facets, kw)
        add_facet_and_keywords("classifiers", self.classifiers, facets, kw)
        add_facet_and_keywords("numbers", self.numbers, facets, kw)

        fstring = " | ".join(facets)

        return fstring, kw


DESCRIPTOR_INSTRUCTIONS = """
You analyze one English sentence and return only JSON that instantiates the Sentence schema below.
Be exhaustive but conservative: include what is textually expressed or licensed by clear grammatical cues. Do not infer world knowledge.
When unsure, leave fields empty lists (or "" for comment). Use "other" only if the sentence clearly encodes a category that is not listed.

OUTPUT RULES:
- Return JSON only (no prose, no markdown, no code fences).
- Echo the input in "original_sentence".
- Fields typed as lists must be lists (even with one value). If nothing is expressed, use [].
- Do not invent labels. Use exactly the strings in the allowed sets below.
- Prefer precision over recall: omit if uncertain.
- If multiple values are present for a category, list them all in salience order.

MAPPING RULES:

- Intent: declaratives → "assert"; yes/no or wh-forms / tag questions → "ask"; imperatives/requests → "order"; “I think/maybe/perhaps” → add "doubt"; “wish/hope/if only” → add "wish"; greetings → "greet"; thanks → "thank"; “okay/understood” → "acknowledge". Multiple intents allowed.
- Mood 
    Imperative forms (“Do X”, “Please …”, “Let’s …”) → "imperative" (and often "hortative" for “let’s”, "injunctive" for negative commands “don’t”).
    Questions (final “?” or inversion/wh-fronting) → add "interrogative".
    Counterfactuals/wishes (“if I were…”, “I wish…”, “would that…”) → "subjunctive" or "optative".
    Obligations (“must/should/ought to”) → add "necessitative".
    Permissions (“may/can” in permission sense) → add "permissive".
    Mild 3rd-person exhortations (“Let him…”, “May she…”) → "jussive".
    Desire/volition (“want/plan/try/let’s”) → "desiderative" and/or "hortative".
    Otherwise default includes "indicative" when a finite clause is asserted.
- Act Of Speech
    Statements → "assertive"; commands/requests/suggestions → "directive"; promises/offers (“I promise/shall…”, “I’ll…”) → "commissive"; thanks/apologies/congratulations → "expressive"; institutional acts (“I resign”, “I pronounce…”) → "declarative"; greetings/small talk → "phatic"; explicit performatives (“I apologize”, “I promise”) → "performative"; questions → also include "interrogative".
- Type Of Predicate
    Sentence about the existence of something → "existential", 
    about the location of something (time or space) → "locative", 
    about the qualities of something → "attributive", 
    about something belonging to something → "possessive",
    about the nature of something (inclusion in a category) → "inclusive", 
    about something happenning → "processive", 
    otherwise "other".
- Polarity
    Clausal negators (“not/never/no/nobody/nothing/without”, contracted forms) → "negative".
    Mixed scopes (one clause negated, another positive; or both polarity cues) → add "mixed".
    Otherwise "positive".
- Tense
    Past morphology (“VBD”, “was/were”, “did”) → "past".
    Present (“VBP/VBZ”, copular present) → "present".
    Future (will/shall/going to; or explicit future adverbials like “tomorrow/next year”) → "future" or "near_future" if “about to/soon”, "remote_future" for far-future adverbials.
    Past perfect (“had + V-en”) → include "perfect" in aspect and "past" in tense (use "perfect_past" only for explicit pluperfect if required).
    “used to / was V-ing” as background habitual/ongoing → "imperfect_past".
    Gnomic: use in aspect (see below) for timeless truths; normally do not also set tense="gnomic".
- Aspect
    Progressive: be + V-ing.
    Perfect: have + V-en.
    Habitual: adverbs (“usually/often/always”) or generic presents (“Cats purr”).
    Prospective: be going to / about to.
    Inceptive/terminative: “start/begin to…”, “finish/stop…”.
    Iterative/frequentative/semelfactive/durative/resultative/experiential/continuative as lexicalized by adverbs/auxiliaries.
    Perfective for bounded/completed events; imperfective for ongoing/unbounded views.
    Gnomic for timeless truths/general facts (prefer here rather than in tense).
- Voice
    Passive: be/get + past participle with logical subject demoted; agent may be “by-phrase”.
    Causative: “make/let/have/get + object + V”.
    Middle/antipassive/applicative: include only if explicit lexical/morphosyntactic evidence; otherwise omit.
    Default to active when a finite clause with subject-verb order and no passive/causative morphology.
- Modality
    Dynamic-ability: can/could (ability).
    Dynamic-volition: want/try/plan/let’s.
    Desiderative: wish/hope/want (desire sense).
    Deontic-obligation: must/should/ought/need to, have to.
    Deontic-permission: may/can (permission).
    Deontic-prohibition: mustn’t/shouldn’t/don’t (imperative negation).
    Epistemic-*: may/might/could/probably/definitely/seem/apparently/etc. (commitment strength).
- Evidentiality
    Only include if linguistically indicated: “I heard/they say” → hearsay/reported; “apparently/seems/looks/sounded” → inferred/visual/nonvisual; omit otherwise.
- Sentence complexity
    one clause → simple; coordination with clausal “and/or/but” → coordination; subordinator/relative/embedded clause → subordination; both → compound_complex; clear ellipsis/headline → elliptical; else unknown.
- Pronouns
    List all persons/numbers present. For we in English (ambiguous): if “let’s” → include "first person plural inclusive"; otherwise include both "first person plural inclusive" and "first person plural exclusive".
- Other pronouns
    demonstratives (this/that/these/those), interrogatives (who/what/which/where/when/why/how), indefinites (some/any/someone/none), relatives (who/that/which), reflexives (myself/yourself), reciprocal (each other).
- Numbers / classifiers
    numbers/quantifiers (one, two, some, many, all, none, a few).
    classifiers=["gender"] if gendered pronouns/nouns are morphologically relevant; otherwise omit in English.
- Spatial location / directionality
    Include only if overtly encoded: here/there/this/that → proximal/distal; deictic motion “come/go/back/toward/away/in/out/across/along/up/down” → map to corresponding directionality. Use uphill/downhill/seaward/landward only if explicitly stated.
- Possession
    “X’s Y / of-genitive / my/your/his/her” → attributive (and genitive_case if morphologically marked).
    “X has Y / have/has” → have_verb and predicative.
    Guess and add  "alienable" and/or "inalienable" as needed (one's nose or arm is inalienable, one's dog or car is).

- "key_translation_concepts" must be a list of language-independent lexical and grammatical concepts from 
the English sentence. Choose the items whose translation in another language will most constrain or 
explain the overall translation.
(i.e., highest cross-linguistic explanatory power).
Examples:
- “Please don’t open the door.” → ["request", "negation", "politeness", "open", "door"]
- “Let’s head back inland tomorrow.” → ["hortative", "back (dir)", "inland", "tomorrow"]
- “If I had known, I would have called you earlier.” → ["1sg", "conditional", "perfect", "conditional+perfect", "calling", "earlier"]
- “I have never seen those mountains.” → ["1sg", "perfect", "negation", "demonstrative distal (plural)", "mountains (plural)"]

-"comment": ≤120 characters; include ambiguity notes or parsing rationale if useful.
"""


class SimpleSentenceList(BaseModel):
    sentence_list: List[str]


SELECTOR_INSTRUCTIONS = """
You select pedagogical example sentences to teach a grammar topic.

INPUT 
you will receive:
- query: a short description of the topic (e.g., "aspects", "giving orders", "negation", "passive voice", "demonstratives", "numbers", "questions", "possession", "modality", "mood", "directionality", "evidentiality", "pronouns", etc.). The query may include a language name (e.g., "in Tahitian").
- sentences: a list of candidate sentences (strings). Pick only from this list; do not rewrite or normalize.

YOUR TASK:
Return between 20 and 50 sentences that best SUPPORT A LESSON on the query, prioritizing:
1) **Coverage**: include varied subtypes for the topic (e.g., for ASPECT: progressive, perfect, habitual, prospective, resultative, perfective, imperfective, stative; for QUESTIONS: yes/no, wh-, tag, alternative; for NEGATION: clausal neg, negative imperatives, negative quantifiers; for PRONOUNS: 1st/2nd/3rd and plural forms; etc.).
2) **Clarity**: prefer short (≈5–18 tokens), simple clauses with visible cues (e.g., be+V-ing, have+V-en, do not, wh-words, will/going to, was/ were + V-en for passives, this/that/these/those, one/two/some/many/all, have/’s for possession, come/go/back/toward/away/in/out/up/down).
3) **Diversity**: avoid near duplicates; vary markers/lemmas/structures; prefer different constructions over multiple similar ones.
4) **Relevance**: pick sentences whose surface form clearly illustrates the topic; if the query names a language, prefer candidates in that language pair (when identifiable by tokens, orthography, or metadata in the sentence text).

RULES:
- Output must be a **list of strings** (no prose). Each string must **exactly match** one of the provided sentences (character-for-character).
- Do not exceed 50 items.
- Return at least 20 sentences (if the corpus has at least 20 entries...otherwise return all the corpus). 
- If multiple topics are implied (e.g., “negative questions”), ensure examples jointly show both (interrogatives + negative cues).
- Tie-breakers: prefer shorter, simpler, clearer cue > better subtype coverage > lexical diversity.
- Never invent or modify sentences; never include commentary.

SELECTION CHEATSHEET (use surface cues; do not explain them in the output):
- Aspect: progressive (am/is/are/was/were + V-ing), perfect (have/has/had + V-en, already/yet/ever/never), habitual (usually/often/always/every/used to), prospective (going to/about to), resultative (is/are done/finished/left), perfective (bounded past events), imperfective (ongoing/background), stative (be + ADJ/N).
- Tense: past (VBD/was/were), present (VBP/VBZ), future (will/shall/going to; tomorrow/next …), recent past (just), near future (about to/soon).
- Negation: not/never/no/don’t/doesn’t/can’t/without; negative imperatives (“don’t …”); negative quantifiers (none/nothing/nobody).
- Questions: question mark; auxiliary inversion; wh-words (who/what/which/where/when/why/how); tag questions (“…, isn’t it?”); alternative questions (“A or B?”).
- Voice: passive (be/get + V-en); causative (make/let/have/get + OBJ + V).
- Pronouns: include examples covering 1st/2nd/3rd persons and plurals; include inclusive “let’s” as 1PL inclusive.
- Demonstratives / Spatial: this/that/these/those, here/there.
- Numbers/Quantifiers: one/two/three/some/many/all/none/a few.
- Possession: have/has (predicative), ’s/of (attributive), existential (“there is/are … for X”).
- Modality: must/should/ought/need to (deontic obligation), may/can (permission), can/could (ability), want/plan/let’s (volition), might/may/probably/apparently/seems (epistemic).
- Directionality: come/go/back/toward/away/in/out/across/along/up/down/inland/seaward.
- Evidentiality: apparently/seems/looks/sounded; “I heard/they say”.

OUTPUT:
Return ONLY a JSON array (list) of 20 to 50 selected sentences, each exactly one of the provided inputs.
    """


def describe_sentence(llm: LLM, sentence: str, model: str | None = None) -> Sentence:
    """dig4el's ``describe_sentence``: one English sentence in, its ``Sentence`` out."""
    return llm.chat_json(
        [{"role": "system", "content": DESCRIPTOR_INSTRUCTIONS}, {"role": "user", "content": sentence}],
        Sentence, model=model, name="sentence",
    )


def select_sentences(llm: LLM, query: str, sentences: List[str], model: str | None = None) -> List[str]:
    """dig4el's ``select_sentences``: the 20 to 50 candidates that best support a lesson
    on ``query``. Only strings that exactly match a candidate are kept."""
    payload = {"query": query, "sentences": sentences}
    out = llm.chat_json(
        [{"role": "system", "content": SELECTOR_INSTRUCTIONS}, {"role": "user", "content": json.dumps(payload)}],
        SimpleSentenceList, model=model, name="selection", max_tokens=8000,
    )
    pool = set(sentences)
    return [x for x in out.sentence_list if x in pool]


def augmentation_of(d: Sentence) -> dict:
    """What dig4el stored per augmented pair: the facet string as ``description``, the
    facet values as ``keywords``, and the key translation concepts."""
    description, keywords = d.make_facet_str()
    return {"description": description, "keywords": keywords,
            "key_translation_concepts": list(d.key_translation_concepts), "comment": d.comment}
