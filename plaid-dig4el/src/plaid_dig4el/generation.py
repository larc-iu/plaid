"""Grammar descriptions: dig4el's generation agents and the page's pipeline as one job.

The schemas and every instruction text are Sebastien Christian's, copied verbatim from
``libs/grammar_generation_agents.py`` (dig4el, AGPL-3.0); the data strings handed to
each agent are the page's. The agents ran on OpenAI's Agents SDK (o4-mini for
selection, gpt-5 for the rest); here each is one schema-constrained completion on the
configured endpoint. The pipeline mirrors ``pages/generate_grammar.py``: seed the query,
select grammatical parameters from the approved inference, contribute from the
questionnaire pseudo-glosses (alterlingua), contribute from documents, select sentence
pairs, aggregate into a lesson (optionally reviewed) or a sketch.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime
from typing import List

from plaid_client import PlaidClient
from pydantic import BaseModel

from . import augment, db, jobs, plaid_gateway as gw, sentences
from .inference import kg as kgmod
from .inference.tokenizer import custom_split
from .inference.runner import gather_inputs
from .llm import LLM, llm
from .reference.paths import DATA_DIR
from .reference.util import load_json

class Example(BaseModel):
    target_sentence: str
    source_sentence: str
    description: str


class Description(BaseModel):
    description: str


class Info_Chunk(BaseModel):
    focus: str
    example: List[Example]
    description: str


class Sketch_Chunk(BaseModel):
    focus: str
    description: str
    examples: List[Example]


class Translation_Drill(BaseModel):
    target: str
    source: str

class Lesson(BaseModel):
    """Grammar lesson"""
    title: str
    introduction: str
    sections: List[Info_Chunk]
    conclusion: str
    translation_drills: List[Translation_Drill]


class Sketch(BaseModel):
    """Grammar sketch"""
    title: str
    introduction: str
    sections: List[Sketch_Chunk]


class Grammar_Parameter(BaseModel):
    parameter: str


class Grammar_Parameter_Selection(BaseModel):
    selection: list[Grammar_Parameter]


class Contribution(BaseModel):
    explanation: str
    examples: list[Example]


PARAMETER_SELECTOR_INSTRUCTIONS = """
    You are a grammar expert selecting from a provided list the grammatical parameters best suited to 
    answer a user's query. 
    
    INPUT:  
    - A user query
    - A list of grammatical parameters
    
    OUTPUT: 
    Return the subset of input parameters relevant to answering the user’s query. 
    
    EXAMPLE: 
    User query: “How does Arawak express aspect?”
    Parameters list: ["Is a morphological distinction between perfective and imperfective aspect available on verbs?", 
    “voice”, "The Perfect", "The Past Tense", "Perfective/Imperfective Aspect"]
    
    Expected output: ["Is a morphological distinction between perfective and imperfective aspect available on verbs?", 
    "Perfective/Imperfective Aspect"]    
    """

ALTERLINGUA_INSTRUCTIONS = """
    You are an agent answering a user's query about the grammar of a target language 
    based only on the material provided.
    
    INPUT: 
    - The user's query about the grammar of the language, which can contain instructions about how to 
        think about the query and structure an answer. If there is such a part to the query: Follow these instructions. 
    - A list of annotated sentences: Each item of the list includes 
        - the source sentence in English, 
        - the target sentence in the target language, 
        - a partial pseudo-gloss called "alterlingua", which adds to target words known information 
        about them when available. "IP" is Internal Particularization, internal information about the concept's
         adaptation to the expression need. "RP" is Relational Particularization, or how the concept connects 
         with others. 
        - comments.
        
    Example of input item: 
    {
      "source_english": "Well, we\u2019re walking down to the river, over there.",
      "target_raw": "'aita, t\u0113 pou nei m\u0101ua i te pae anavai, i '\u014d",
      "alterlingua": "'aita<> t\u0113<> pou<walking & PROCESSIVE PREDICATE> nei m\u0101ua<Ref_speaker_plus_person_excluding_addressee(IP: | RP:AGENT of walking)> i<river(IP: | RP:OBLIQUE ROLE DESTINATION of walking)> te<> pae<> anavai<river(IP: | RP:OBLIQUE ROLE DESTINATION of walking)> i '\u014d",
      "comment": "pou 'descendre' est employ\u00e9 pour indiquer le mouvement vers le bas (walking down)"
    }
    
    OUTPUT: 
    - A detailed answer to the user's question, 
    - A list of examples helping the user understand your answer. Example must come from the provided input. 
    Each example consists in a sentence in the target language, a sentence in the source language, and a brief 
    description of what is interesting in this example. 
    - When using a target word or sequence of words within an explanation sentence, surround it with "**"; for example "**'uru**" or "**'ia ora na**".
    
    Example of query: "Does Tahitian use an inclusive/exclusive distinction in pronouns? 
                       INSTRUCTIONS: Adhere to the following framework and thought process:
                       - State if the language uses inclusive vs exclusive forms
                       - Look for the existence of a dual or trial forms. If they exist, present the 
                       interaction between inclusive/exclusive and dual/trial."

    Example of output:
    {
    "Explanation": "Yes, Tahitian uses an inclusive/exclusive distinction in all pronouns.
    In addition, Tahitian also uses a dual, which combines with inclusive and exclusive forms
    to signify, for example, the speaker and the person next to the speaker, but no the person being addressed, 
    as in the following example.",
    "Examples": [
        {
        "source_sentence": "Well, we\u2019re walking down to the river, over there."
        "target_sentence": "'aita, t\u0113 pou nei m\u0101ua i te pae anavai, i '\u014d"
        "description": "In this sentence, m\u0101ua refers to the speaker and someone else. If 
        the speaker wanted to refer to himself and his interlocutor, he would have used tāua". 
        }
    ]
    }
    """

LESSON_INSTRUCTIONS = """ 
    You are an agent specialized in creating grammar teaching material for an endangered language.
    Students are speaking the source language.  
    You are provided with the user's query with optional instructions included, and materials from different sources. 
    Your job is to compile these sources and add your own input to create a grammar lesson about the query.
    You must follow any instructions included in the query, about how to think about, and formulate an answer.
    You output the grammar lesson following the specified schema. 
    
    COMPLY WITH THE FOLLOWING:
    - Do not add information from any other source or from your own knowledge. 
    - Add ALL relevant information from all the available sources.
    - Follow any instructions part of the query.
    - Adapt your output to the type of readers: The output must be in the language of readers, adapted to 
    the type of readers, and insist on contrasts between the endangered language and the language of the readers 
    when describing grammar. 
    - All the content of the lesson must come from the provided material. Don't invent anything, don't retrieve
    anything from other sources or general knowledge. 
    - In all examples, translate the source sentence from English to the reader's language. 
    - Avoid metalinguistic jargon. Use everyday words and expressions and periphrases, 
    except if the audience are linguists. 
    
    INPUT:
    - Name of the endangered language.
    - Query and optional instructions about how to create a lesson about it. 
    - Type of readers and language fo the readers.
    - List of grammatical parameters and their values in the endangered language, some with examples. 
    - Description coming from sentence analysis.
    - Description coming from a compilation of documents.
    - List of examples, each with its description.
    - List of sentence pairs, some with explicit connections between the concepts in the sentence and words in 
        the endangered language sentence, some with comments, some with a literal English back-translation.
    
    NOTE ON INPUTS: If there are contradictions between inputs, be explicit about it and cite the diverging sources.
        
    OUTPUT: Grammar lesson in the reader's language. The grammar lesson is structured as follows:
    - A title, derived from the user query
    - An introduction paragraph which includes: A summary of language-independent general grammar knowledge about this topic. 
    Then a short description of how this grammar topic is expressed in the 
    language of readers, with examples. Finally, a hint about how the endangered language grammar expresses this topic. 
    The objective of the introduction is to help readers understand the topic, as readers may not me familiar with grammar. 
    - A list of information chunks, which are paragraphs focusing on an aspect of the grammatical topic to cover. 
    Add as many information chunks as needed to cover the topic. Each information chunk includes a title, an explanation 
    of the focus, and several examples retrieved from the corpus (if possible 5). Each example is a sentence in the target language, 
    its translation in the reader's language, and a description of the example with the lens of the grammatical 
    topic studied.
    - A conclusion, which is what the students should absolutely remember. 
    - Drills: sentence pairs that illustrate the topic and that will be used to create exercises. Translate the source
    language in the reader's language if needed. Add ALL relevant examples retrieved from the input. 
    
    NOTE ON OUTPUTS: When using a target word or sequence of words within an explanation sentence, surround it with "**"; for example "**'uru**" or "**'ia ora na**".
    
    """

LESSON_REVIEW_INSTRUCTIONS = """
You are given:
- A grammar lesson about an endangered language, formatted as JSON.
- The target audience (e.g., children, beginner adult learners, linguists, teachers).
- The language of the readers, which matches the language used in the provided lesson.

The lesson includes:
- An introduction.
- Several sections, each focusing on a specific grammatical feature.
- A conclusion, which contains the key elements to remember.
- A list of examples.

Your task:
Adapt the content of the lesson EXCEPT EXAMPLES for the specified audience by:
1. Simplifying the language:
   - Replace or rephrase any technical linguistic terms or complex explanations that the audience would not understand.
   - Add explanations and analogies as needed for the audience to understand the lesson.
2. Preserving accuracy:
   - Ensure that all grammatical facts remain correct and faithful to the original.
   - Don't modify examples. 
   - Don't modify any content in the target, taught, language. 
   - Maintain the original structure and JSON format of the lesson.
   - Keep all examples exactly as they are provided. Do not change anything to examples.
NOTE ON OUTPUTS: When using a target word or sequence of words within an explanation sentence, surround it with "**"; for example "**'uru**" or "**'ia ora na**".
Output format:
Return the adapted lesson in the same JSON structure.
    """

SKETCH_INSTRUCTIONS = """
    You are an agent specialized in creating detailed grammar descriptions to document endangered languages.
    You are provided with a user query with optional instructions, and materials from different sources.
    Your job is to compile these sources to create a grammar sketch that will be used by linguists.

    COMPLY WITH THE FOLLOWING:
    - Do not add information from any other source or from your own knowledge, but use all the reasoning you can to
    perform deductions and inferences based on the sources.
    - If the query contains instruction about how to think about and formulate an answer, follow these instructions.
    - Add ALL relevant information from all the available sources. Be as detailed as possible.
    - The output must be in the language of the readers.
    - In all examples, translate the source sentence from English to the reader's language.

    INPUT:
    - Name of the endangered language.
    - User's query and optional instructions.
    - List of grammatical parameters and their values in the endangered language, some with examples.
    - Description coming from sentence analysis.
    - Description coming from a compilation of documents.
    - List of examples, each with its description.
    - List of sentence pairs, some with explicit connections between the concepts in the sentence and words in
        the endangered language sentence, and explanatory comments.

    NOTE ON INPUTS: If there are contradictions between inputs, be explicit about it and cite the diverging sources.

    OUTPUT: Grammar sketch in the reader's language. The grammar sketch is structured as follows:
    - A title, derived from the user query
    - An introduction paragraph that introduces the grammatical topic provides a robust and detailed overview of
     the behavior of the target language with regard to the grammatical topic at hand.
    - A list of sktech chunks: Each chunk is a focus on an aspect of the grammar topic provided. For example, if the grammar topic is
    "expressing tense", the chunks may focus on "past", "present", "future" and "general" for example. Each chunk is a
    section with information and examples. The list can be as long or as short as needed to describe the grammatical topic.
    Each sketch chunk can include up to 5 examples to illustrate how the target language expresses the grammar topic.
    Each example displays with the sentence in the target language, in the the source language, and an explanation of how this example illustrate the focus.
    - A conclusion, which is what the students should absolutely remember.
    
    NOTE ON OUTPUTS: When using target word(s) within an explanation sentence, surround them with "**"; for example "**'uru**" or "**'ia ora na**".
    
    """

# dig4el's file-search prompt (documents contribution); ``{indi_language}`` and ``{query}``
# are filled in.
DOCUMENTS_PROMPT = """
    You are an agent specialized in retrieving grammatical information about {indi_language} in the provided documents.
    to answer a user's query. Retrieve all relevant information from the documents and compile them into a detailed 
    answer to the user's query, with examples taken from the documents. 
    - Use only information from the documents. Do not invent any additional information or examples. If there are no relevant 
    information in the documents, just output "no relevant information about the query in the documents". 
    - If the query comes with instructions about how to formulate an answer, follow these instructions. 
    USER QUERY: {query}
"""

READERS_LANGUAGES = ["English", "Bislama", "Chinese", "French", "German", "Indonesian", "Japanese", "Russian",
                     "Spanish", "Swedish", "Tahitian"]
READERS_TYPES = ["Teenagers", "Adults", "Linguists"]
SKETCH_TOPICS = [
    "Simple verbal sentences", "Simple non-verbal sentences", "Agents and patients", "Marking system", "Nouns",
    "Personal Pronouns", "Verbs", "Adverbs", "Adjective", "Numerals", "Tense system", "Aspect system", "Negation",
    "Coordination", "Subordination", "References to things", "Expressing the position in time",
    "Expressing the position in space",
]


def lesson_seeds() -> dict[str, dict]:
    """dig4el's ``grammar_seeds.json``: standard lesson topics with guidance for the model."""
    return load_json(DATA_DIR / "grammar_seeds.json")


def seeded_query(topic: str, language_name: str) -> str:
    """The page's query string: a seeded topic carries its framework as instructions."""
    seed = lesson_seeds().get(topic)
    if seed:
        return (f"\n                TOPIC: {topic}\n                INSTRUCTIONS: \n"
                f"                Adhere to the following framework and thought process to explain how {topic} "
                f"is expressed in {language_name}:\n                {seed}\n                ")
    return f"TOPIC: {topic}"


# --------------------------------------------------------------------- agents


def select_parameters(L: LLM, query: str, parameters: list[str], model: str | None = None) -> list[str]:
    data = f"Query: {query} --- Parameters: {parameters}"
    out = L.chat_json([{"role": "system", "content": PARAMETER_SELECTOR_INSTRUCTIONS}, {"role": "user", "content": data}],
                      Grammar_Parameter_Selection, model=model, name="selection")
    return [d.parameter for d in out.selection]


def contribute_from_alterlingua(L: LLM, query: str, sentences_: list[dict], model: str | None = None) -> dict:
    data = f"Query: {query} --- Sentences: {sentences_}"
    out = L.chat_json([{"role": "system", "content": ALTERLINGUA_INSTRUCTIONS}, {"role": "user", "content": data}],
                      Contribution, model=model, name="contribution", max_tokens=8000)
    return out.model_dump()


def _aggregation_data(indi_language, source_language, query, readers, grammatical_params,
                      alterlingua_explanation, alterlingua_examples, doc_contribution, sentence_pairs) -> str:
    return f"""
    ENDANGERED LANGUAGE: {indi_language},
    
    
    READERS: {readers} speaking {source_language} language,
    
    
    QUERY: {query}
    
    
    GRAMMATICAL PARAMETERS: {grammatical_params},
    
    
    DESCRIPTION FROM SENTENCE ANALYSIS: {alterlingua_explanation}
    
    
    EXAMPLES FROM SENTENCE ANALYSIS: {alterlingua_examples},
    
    
    DESCRIPTION FROM DOCUMENTS: {doc_contribution},
    
    
    SENTENCE PAIRS: {sentence_pairs}
    """


def create_lesson(L: LLM, indi_language, source_language, query, readers_type, grammatical_params,
                  alterlingua_explanation, alterlingua_examples, doc_contribution, sentence_pairs,
                  model: str | None = None) -> dict:
    data = _aggregation_data(indi_language, source_language, query, readers_type, grammatical_params,
                             alterlingua_explanation, alterlingua_examples, doc_contribution, sentence_pairs)
    out = L.chat_json([{"role": "system", "content": LESSON_INSTRUCTIONS}, {"role": "user", "content": data}],
                      Lesson, model=model, name="lesson", max_tokens=16000)
    return out.model_dump()


def review_lesson(L: LLM, lesson: dict, source_language, readers_type, model: str | None = None) -> dict:
    data = f"""
    LESSON LANGUAGE = {source_language},
    READERS_TYPE = {readers_type},
    LESSON: {lesson}
    """
    out = L.chat_json([{"role": "system", "content": LESSON_REVIEW_INSTRUCTIONS}, {"role": "user", "content": data}],
                      Lesson, model=model, name="lesson", max_tokens=16000)
    return out.model_dump()


def create_sketch(L: LLM, indi_language, source_language, query, grammatical_params,
                  alterlingua_explanation, alterlingua_examples, doc_contribution, sentence_pairs,
                  model: str | None = None) -> dict:
    data = _aggregation_data(indi_language, source_language, query, "Linguists", grammatical_params,
                             alterlingua_explanation, alterlingua_examples, doc_contribution, sentence_pairs)
    out = L.chat_json([{"role": "system", "content": SKETCH_INSTRUCTIONS}, {"role": "user", "content": data}],
                      Sketch, model=model, name="sketch", max_tokens=16000)
    return out.model_dump()


# ------------------------------------------------------------ the CQ knowledge


def grammar_priors(run: db.InferenceRun) -> list[dict]:
    """dig4el's ``cq_knowledge["grammar_priors"]``: the retained parameters of the approved
    inference, a caretaker's override standing in for the winner."""
    out = []
    overrides = run.overrides or {}
    for p in (run.report or {}).get("parameters", []):
        ov = overrides.get(p["parameter"])
        if not p["retained"] and not ov:
            continue
        origin = {"known": "Known", "observed": "Observed", "inferred": "Inferred"}.get(p["origin"], p["origin"])
        winner = p["winner"]
        confidence = int(p["confidence"])  # the report stores a percentage
        if ov:
            winner = ov.get("name") or p["beliefs"].get(ov["code"], {}).get("name", winner)
            confidence = 100
        out.append({"Parameter": p["parameter"], "Origin": origin, "Winner": winner,
                    "Confidence": confidence, "Examples by value": {}})
    return out


def build_alterlingua(kg: dict, delimiters: list[str]) -> list[dict]:
    """dig4el's ``build_alterlingua_kg`` (concept ancestor level 0) followed by
    ``build_alterlingua_list_from_kg`` and ``extract_and_clean_cq_alterlingua``: each
    questionnaire sentence with its pseudo-gloss, cleaned for the model."""
    out = []
    for index, entry in kg.items():
        target_words = custom_split(entry["recording_data"]["translation"], delimiters)
        concept_words = entry["recording_data"].get("concept_words", {})
        augmented = []
        for word in target_words:
            associated = [c for c, ws in concept_words.items() if word in ws]
            if not associated:
                augmented.append(word + "<>")
                continue
            parts = []
            for concept in associated:
                ip, rp = kgmod.get_particularization_info(kg, index, concept)
                ip_display = "IP:" + "+".join(f"{k}={v}" for k, v in ip.items())
                rp_display = "RP:" + "+".join(f"{k} {v}" for k, v in rp.items())
                parts.append(f"{concept}({ip_display} | {rp_display})")
            augmented.append(word + "<" + " & ".join(parts) + ">")
        alterlingua = (" ".join(augmented)
                       .replace("(IP: | ", "(").replace("RP:)", ")").replace("()", "").replace("<>", ""))
        out.append({"source": entry["sentence_data"]["text"], "target": entry["recording_data"]["translation"],
                    "alterlingua": alterlingua, "comments": entry["recording_data"].get("comment", "")})
    return out


# ------------------------------------------------------------------- the job


@jobs.handler("generate")
def run_generation(job: db.Job, client: PlaidClient) -> None:
    p = job.payload
    language_id, fmt = p["language_id"], p["format"]
    readers_language, readers_type = p["readers_language"], p["readers_type"]
    model = p.get("model") or None
    L = llm()
    with db.session() as s:
        language = s.get(db.Language, language_id)
        _ = language.documents, language.corpora
        run = next((r for r in language.runs if r.approved), None)
        priors = grammar_priors(run) if run else []
        qs = gw.catalog.questionnaires()
        cq_names = [qs[r.questionnaire_uid].short_title if r.questionnaire_uid in qs else r.questionnaire_uid
                    for r in language.documents]
        pair_names = [f"{c.name} ({c.author})" for c in language.corpora]
        rows = s.query(db.SentenceAugmentation).filter_by(language_id=language_id).all()
    delimiters = language.delimiters or gw.catalog.DEFAULT_DELIMITERS
    use_cq, use_pairs, use_docs = p.get("use_cq", True), p.get("use_pairs", True), p.get("use_documents", True)
    bare_query = p["topic"]
    query = seeded_query(bare_query, language.name) if fmt == "lesson" else f"TOPIC: {bare_query}"
    trace: dict = {"parameters": [], "pseudo-gloss": {}, "documents": {"text": "", "sources": []}, "pairs": []}

    # --- conversational questionnaires: parameters and pseudo-gloss
    note = lambda text: _note(job.id, text)
    if use_cq and priors:
        note(f"Selecting relevant grammatical parameters among {len(priors)} available")
        selected = select_parameters(L, bare_query, [x["Parameter"] for x in priors], model=model)
        trace["parameters"] = selected
        params_blob = json.dumps([x for x in priors if x["Parameter"] in selected], ensure_ascii=False) or "No relevant grammatical parameter."
    else:
        params_blob = "No relevant grammatical parameter."
    if use_cq:
        note("Reading the questionnaire translations and their pseudo-glosses")
        kg, _inputs = gather_inputs(client, language)
        sentences_ = build_alterlingua(kg, delimiters)
        if sentences_:
            note("Generating contribution from CQ pseudo-gloss analysis. This is a long step, be patient!")
            contribution = contribute_from_alterlingua(L, query, sentences_, model=model)
            trace["pseudo-gloss"] = contribution
            alterlingua_explanation = contribution["explanation"]
            alterlingua_examples = json.dumps(contribution["examples"], ensure_ascii=False)
        else:
            alterlingua_explanation = "No description from sentence analysis."
            alterlingua_examples = "No available examples from sentence analysis."
    else:
        alterlingua_explanation = "No description from sentence analysis."
        alterlingua_examples = "No available examples from sentence analysis."

    # --- documents
    doc_contribution = "No available contribution from documents."
    if use_docs:
        try:
            from . import documents
            note("Generating contribution from documents")
            contribution = documents.contribute(L, language, query, model=model)
            if contribution:
                trace["documents"] = contribution
                doc_contribution = contribution["text"] or doc_contribution
        except ImportError:
            pass

    # --- sentence pairs
    pairs_blob = "No available sentence pairs."
    if use_pairs and rows:
        note(f"Retrieving a helpful selection of sentence pairs among {len(rows)}")
        hits = sentences.model_selection(rows, bare_query)
        links = _word_connections(client, language, [h.augmentation for h in hits])
        sps = []
        for h in hits:
            a = h.augmentation
            sps.append({
                language.name: a.target, "source": a.source, "grammatical_description": a.description,
                "concept-words_connections": links.get(a.token_id, {}), "comment": a.comment,
                "literal English back-translation": "", "gloss": "",
            })
        trace["pairs"] = [h.augmentation.token_id for h in hits]
        if sps:
            pairs_blob = json.dumps(sps, ensure_ascii=False)

    # --- aggregation
    note("Aggregating sources into the final output")
    if fmt == "lesson":
        output = create_lesson(L, language.name, readers_language, query, readers_type, params_blob,
                               alterlingua_explanation, alterlingua_examples, doc_contribution, pairs_blob,
                               model=model)
        if p.get("polish"):
            note("Post-processing lesson")
            output = review_lesson(L, output, readers_language, readers_type, model=model)
    else:
        output = create_sketch(L, language.name, readers_language, query, params_blob,
                               alterlingua_explanation, alterlingua_examples, doc_contribution, pairs_blob,
                               model=model)
    sources: dict = {}
    if use_cq:
        sources["cqs"] = cq_names
    if use_docs and trace["documents"].get("sources"):
        sources["documents"] = trace["documents"]["sources"]
    if use_pairs:
        sources["pairs"] = pair_names
    output["sources"] = sources
    output["date"] = datetime.now().strftime("%A, %-d %B %Y at %H:%M")
    with db.session() as s:
        row = db.GrammarOutput(language_id=language_id, job_id=job.id, format=fmt, topic=bare_query, query=query,
                               readers_language=readers_language, readers_type=readers_type,
                               model=model or L.model, output=output, trace=trace, created_by=job.created_by)
        s.add(row)
        s.commit()
        j = s.get(db.Job, job.id)
        j.payload = {**j.payload, "output_id": row.id}
        s.commit()


def _note(job_id: str, text: str) -> None:
    with db.session() as s:
        j = s.get(db.Job, job_id)
        j.progress = {**(j.progress or {}), "note": text}
        s.commit()


def _word_connections(client: PlaidClient, language: db.Language,
                      rows: list[db.SentenceAugmentation]) -> dict[str, dict[str, list[str]]]:
    """A corpus sentence's links, as dig4el's ``word connections``: meaning -> words."""
    layers = gw.Layers.from_config(language.layers)
    out: dict[str, dict[str, list[str]]] = {}
    for doc_id in {r.document_id for r in rows}:
        try:
            doc = gw.read_questionnaire_document(client, doc_id, layers)
        except gw.DocumentUnavailable:
            continue
        forms = {}
        for slot in doc.slots:
            form_of = {w["id"]: w["form"] for w in slot.words}
            forms[slot.token_id] = {sp["value"]: [form_of[t] for t in sp["tokens"] if t in form_of]
                                    for sp in slot.concepts}
        out.update(forms)
    return out
