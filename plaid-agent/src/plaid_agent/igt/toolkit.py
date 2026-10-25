"""The tool table the model sees, and the dispatch behind it.

Every tool an interlinear assistant may call is declared here once, beside the
function that implements it, and nowhere else. A tool that plans a change says
so in the first word of its description, which is what makes it one: there is
no second list to keep in step with this one.

This is the last module in the app to be imported: it reads every tool module,
so nothing here may be imported back by one of them.
"""

import inspect
from typing import Any, Dict

from ..core import toolkit, webtools
from ..core.limits import MAX_SCOPE_DOCS, MAX_SENTENCES_PER_READ, OVERVIEW_DOCS
from ..core.plan import discard_plan as t_discard_plan, plan_status as t_plan_status
from ..core.tools import fn, limit_arg

from .bulk import (t_copy_to_orthography, t_delete_entry, t_merge_entries, t_rename_document,
                   t_rename_entry, t_replace_in_field, t_respell_all, t_set_analysis_for_form,
                   t_set_field_for_form)
from .lexicon import t_create_entry, t_make_sense_of, t_senses, t_set_entry_field
from .query import t_query, t_query_help
from ..core.history import (add_comment_on_values as t_add_comment, comments_on_values as t_comments,
                            recent_changes as t_recent_changes)
from .reads import (CONCORDANCE_LIMIT, ENTRY_EXAMPLES, MAX_FORMS_PER_CALL, READ_LEXICON_LIMIT,
                    t_analyses_of, t_check_consistency, t_concordance, t_lexicon_entry,
                    t_list_documents, t_project_overview,
                    t_read_document, t_read_lexicon, t_read_sentences, t_search)
from .sandbox import t_code_help, t_run_code
from ..core.scope import among_documents
from .guide import t_app_guide
from .tagsets import t_tagsets
from .shape import (t_append_text, t_delete_word, t_merge_sentences, t_merge_words,
                    t_retype_sentence, t_split_sentence, t_split_word)
from .stats import (t_check_integrity, t_check_lexicon, t_corpus_stats, t_frequency_list,
                    t_sequence_search, t_worklist)
from .tools import (t_confirm, t_create_document, t_discard_analysis,
                    t_link_entry, t_link_phrase, t_respell,
                    t_restore_document, t_set_analysis, t_set_document_metadata, t_set_field,
                    t_set_morpheme, t_set_orthography, t_unlink_entry, t_unlink_phrase)

# Web tools are offered only where the operator configured a search backend
# (see core.tools.tools_for).
WEB_TOOLS = webtools.NAMES


# --- schema + dispatch ----------------------------------------------------------

_fn = fn
_SHARED = toolkit.shared_schemas(ref='sN, sN.wN, or sN.wN.mN.', comment_field=True, restore=True)


_DOC = {'type': 'string', 'description': 'Document id or exact name (see project_overview).'}
_DOCS = {'type': 'array', 'items': {'type': 'string'}}  # several documents in place of one (core/scope.py)
_GLOSS = {'type': 'string', 'description': 'Singles out one of several entries with the same form: a value one of '
                                           'its fields has (e.g. its gloss).'}
_ENTRY_FORM = {'type': 'string',
               'description': 'A headword, with an optional "#" and the number shown beside it. One segment '
                              'is a headword ("gam#2", the second spelled that way), two or more a sense '
                              '("kwatha#1.2", "gam#2.1.3"). A bare "kwatha" is the headword. read_lexicon '
                              'shows every number.'}
_ENTRY_ADDR = {'entry_form': _ENTRY_FORM,
               'lexicon': {'type': 'string', 'description': 'Lexicon name (needed only when the project has several).'},
               'entry_id': {'type': 'string'}}

_FIELDS = {'type': 'array', 'items': {'type': 'string'},
           'description': 'Show only these, e.g. ["Gloss", "Translation"]: field names, orthography names, '
                          '"segmentation" (seg= and types=), "links" (link=, mwe=, mlinks=). The baseline and the '
                          'references are always shown, and naming only sentence fields leaves out the word lines. '
                          'Leave it out to show everything.'}

_REFS = {'type': 'array', 'items': {'type': 'string'},
         'description': 'Positional references, e.g. ["s3.w2", "s3.w4"]. Words are sN.wN, morphemes sN.wN.mN, sentences sN.'}
_MORPHEMES = {'type': 'array', 'items': {'type': 'object', 'properties': {
    'form': {'type': 'string'}, 'type': {'type': 'string'},
    'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}}, 'required': ['form']}}

TOOLS = [
    _fn('project_overview',
        'The project: its annotation fields by scope (Word / Morpheme / Sentence), orthographies, lexicons, and the '
        f'list of documents, the first {OVERVIEW_DOCS} by name (list_documents pages and filters the rest). '
        'Call this first.', {}, []),
    _fn('list_documents',
        'The documents by name, a page at a time, optionally filtered by a substring of the name or of any '
        'document metadata value (pattern), and/or by a whole metadata value (metadata_field + value; an empty '
        'value lists documents lacking it).',
        {'pattern': {'type': 'string'}, 'metadata_field': {'type': 'string'}, 'value': {'type': 'string'},
         'limit': limit_arg('list_documents', 'Documents to show'),
         'offset': {'type': 'integer'}}, []),
    _fn('read_document',
        'Read a document as compact interlinear text: baseline sentences, sentence fields, and one line per word '
        'with its segmentation, glosses, word fields, orthographies, and lexicon links. Up to '
        f'{MAX_SENTENCES_PER_READ} sentences per '
        'call, fewer when they are long: the header says which were shown and where to continue. WHEN YOU ALREADY '
        'KNOW WHICH SENTENCES YOU NEED (a search told you, or an earlier read did), name them in `sentences` and get '
        'them all in ONE call. Several documents at once: read_sentences. Where a project has many fields, name '
        'the ones you need in `fields` and more sentences fit in a call.',
        {'document': _DOC,
         'sentences': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Just these sentences, e.g. ["s3","s8"]. A reference like "s3.w2" names its '
                                      'sentence. Overrides the range below.'},
         'from_sentence': {'type': ['integer', 'string'],
                           'description': 'First sentence to show: 3 or "s3" (default 1).'},
         'to_sentence': {'type': ['integer', 'string'],
                         'description': 'Last sentence to show: 8 or "s8".'},
         'fields': _FIELDS},
        ['document']),
    _fn('read_sentences',
        'Read chosen sentences of SEVERAL documents in one call, e.g. the hits of a search, each document under '
        'its own header as read_document prints it. Up to '
        f'{MAX_SENTENCES_PER_READ} sentences per call, fewer when they are long: what did not fit is listed at '
        'the end.',
        {'items': {'type': 'array', 'description': 'e.g. [{"document":"Text 1","sentences":["s3","s8"]}, '
                                                   '{"document":"Text 2","sentences":["s1"]}].',
                   'items': {'type': 'object', 'properties': {
                       'document': _DOC, 'sentences': {'type': 'array', 'items': {'type': 'string'}}},
                       'required': ['document', 'sentences']}},
         'fields': _FIELDS},
        ['items']),
    _fn('search',
        'Find words, morphemes, field values, or lexicon entries matching a pattern (case-insensitive substring, '
        'or a regex). Returns positional references with each hit\'s word line and sentence. Scans every '
        'document unless one is named. (For items LACKING a value use worklist; for aligned context use concordance.) '
        'Every value a field holds, with counts, is frequency_list\'s job, not one search per value.',
        {'pattern': {'type': 'string'},
         'where': {'type': 'string', 'description': '"baseline" (word forms, default), "morpheme" (morpheme forms), '
                                                    '"lexicon" (entries), or a field name (e.g. "Gloss", "Translation").'},
         'document': _DOC,
         'regex': {'type': 'boolean', 'description': 'Treat pattern as a regular expression.'}, 'case_sensitive': {'type': 'boolean', 'description': 'Match case too (off by default: "ar" finds "Ar").'},
         'limit': limit_arg('search', 'Max hits to return'), 'documents': _DOCS},
        ['pattern']),
    _fn('read_lexicon',
        'List lexicon entries (form, morph type, and their fields such as gloss), optionally filtered by a '
        'substring pattern over the whole entry line. Senses are drawn under their entry with the number '
        'they are shown with.',
        {'lexicon': {'type': 'string', 'description': 'Lexicon name (needed only when the project has several).'},
         'pattern': {'type': 'string'},
         'limit': {'type': 'integer', 'description': f'Max entries (default {READ_LEXICON_LIMIT}).'}},
        []),
    _fn('set_field',
        'PLAN: set a field\'s value on words, morphemes, or sentences (the references must match the field\'s '
        'scope). Empty value clears it. Several fields at once: values={field: value}, each on the refs of its scope '
        '(refs ["s3.w1", "s3.w1.m1"] for a word and its morpheme). Nothing is written until the user approves.',
        {'document': _DOC, 'refs': _REFS, 'field': {'type': 'string'}, 'value': {'type': 'string'},
         'values': {'type': 'object', 'additionalProperties': {'type': 'string'}}},
        ['document', 'refs']),
    _fn('set_analysis',
        'PLAN: replace a word\'s morpheme segmentation and morpheme-level fields. Morphemes are given in order; '
        'each has a form, an optional type (stem, root, prefix, suffix, infix, enclitic, proclitic, ...), and '
        'fields mapping morpheme field names to values, e.g. [{"form":"kitab","type":"stem","fields":{"Gloss":"book"}}, '
        '{"form":"lar","type":"suffix","fields":{"Gloss":"PL"}}]. REPLACES the word\'s whole chain: every existing '
        'morpheme field value on it, human-made ones included, is dropped. To change one morpheme\'s value keep the '
        'chain and use set_field with sN.wN.mN; to change one morpheme\'s form or type, set_morpheme. Several words '
        'at once: analyses=[{"ref":"s3.w1","morphemes":[...]}, ...] (one call per sentence, not per word). Once '
        'it is planned, sN.wN.mN of that word names a morpheme of the PLANNED analysis in set_field, set_morpheme, '
        'link_entry and unlink_entry, so its new morphemes can be glossed, retyped or linked in the same plan.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'},
         'morphemes': _MORPHEMES,
         'analyses': {'type': 'array', 'description': 'Several words at once: [{ref, morphemes}, ...].',
                      'items': {'type': 'object', 'properties': {'ref': {'type': 'string'}, 'morphemes': _MORPHEMES},
                                'required': ['ref', 'morphemes']}}},
        ['document']),
    _fn('set_morpheme',
        'PLAN: change one morpheme\'s stored form and/or type in place, keeping the chain and every value on it '
        '(e.g. make sN.wN.m2 an enclitic). type "" clears the type. A linked morpheme goes by its entry\'s type: '
        'set that with set_entry_field (field "morphType").',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The morpheme, sN.wN.mN.'},
         'form': {'type': 'string'}, 'type': {'type': 'string'}}, ['document', 'ref']),
    _fn('set_orthography',
        'PLAN: set an orthography value (an alternative transcription tier, not the baseline) on words.',
        {'document': _DOC, 'refs': _REFS, 'orthography': {'type': 'string'}, 'value': {'type': 'string'}},
        ['document', 'refs', 'orthography', 'value']),
    _fn('respell',
        'PLAN: change the BASELINE spelling of one word (its analysis, glosses, and links are kept; a lone '
        'morpheme form spelt like the word follows it unless morpheme_forms=false). For an alternative '
        'transcription tier use set_orthography.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'}, 'new_text': {'type': 'string'},
         'morpheme_forms': {'type': 'boolean'}},
        ['document', 'ref', 'new_text']),
    _fn('link_entry',
        'PLAN: link words or morphemes to a lexicon entry, by the entry\'s form ("ама", or "ама#2" for homograph 2), '
        'or entry_id (also the id returned by create_entry). Replaces the item\'s own link; a multi-word expression '
        'the word belongs to is separate and stays (link_phrase / unlink_phrase for those). For a word whose '
        'analysis this plan changes (set_analysis, set_analysis_for_form), sN.wN.mN is a morpheme of the PLANNED '
        'analysis, so segmenting a word and linking its new morphemes is one plan. If that analysis changes again, '
        'a link to a morpheme it no longer has at that place is dropped.',
        {'document': _DOC, 'refs': _REFS, 'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
        ['document', 'refs']),
    _fn('unlink_entry', 'PLAN: remove the own lexicon link of words or morphemes (not a multi-word expression: '
                        'unlink_phrase). For a word whose analysis this plan changes, sN.wN.mN is a morpheme of the '
                        'PLANNED analysis, as in link_entry.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('link_phrase',
        'PLAN: link two or more words of one sentence to ONE lexicon entry as a multi-word expression (an idiom, a '
        'compound written apart, a phrasal verb; reads show it as mwe=entry (w2+w3)). The words keep their own '
        'links. A new phrase entry is created with create_entry (type "phrase") and linked here in the same plan.',
        {'document': _DOC, 'refs': _REFS, 'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
        ['document', 'refs']),
    _fn('unlink_phrase',
        'PLAN: remove a multi-word expression (the link its member words share); their own links stay. refs: '
        'any member word (several where a word sits in more than one expression).',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('create_entry',
        'PLAN: add a lexicon entry. fields maps entry field names (e.g. "gloss", "pos") to values; type is the '
        'morph type (stem, suffix, enclitic, ...); a form written with markers (-s, ka-, =ri) is stored without '
        'them, and takes their type when no type is given. The returned entry_id can be used by link_entry in the same '
        'plan. Use senses for a sense of an existing entry.',
        {'form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}, 'type': {'type': 'string'}},
        ['form']),
    _fn('set_entry_field',
        'PLAN: set a field (e.g. gloss) on a lexicon entry. A field that holds a reference to another entry '
        '(project_overview marks them) takes that entry\'s form or id, not free text; passing an empty value '
        'clears it, and a field holding several appends. Where an entry sits, its examples and its headword are '
        'not fields: use senses, make_sense_of or rename_entry.',
        {'field': {'type': 'string'}, 'value': {'type': 'string'}, 'entry_form': _ENTRY_FORM,
         'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
        ['field', 'value']),
    _fn('concordance',
        'Every occurrence of a morpheme form (default), word form, or field value (whole-form match, case-insensitive; '
        'regex=true for partial matches), with aligned context: the '
        'word\'s segmentation and morpheme glosses with the hit in [brackets], the neighbouring words, and a '
        'tally of the distinct word patterns the hit appears in. Use this for morphotactic and distributional '
        'questions (what precedes/follows X, does X vary by context) instead of reading whole documents.',
        {'pattern': {'type': 'string'},
         'where': {'type': 'string', 'description': '"morpheme" (default), "baseline" (word forms), or a Word/Morpheme field name.'},
         'document': _DOC, 'regex': {'type': 'boolean'}, 'case_sensitive': {'type': 'boolean', 'description': 'Match case too (off by default: "ar" finds "Ar").'},
         'limit': {'type': 'integer', 'description': f'Max occurrences to list (default {CONCORDANCE_LIMIT}). The value, word and neighbour tallies cover every occurrence.'},
         'documents': _DOCS},
        ['pattern']),
    _fn('analyses_of',
        'How a form has been analyzed so far, as a word (segmentation, glosses, links) and as a morpheme (type, '
        'glosses, link, position in the word): each distinct analysis with its count and example references. '
        'Check this before proposing an analysis, and follow the majority unless there is reason not to. Pass '
        f'forms (a list, up to {MAX_FORMS_PER_CALL}) to check every word of a sentence in one call. value: also list the references '
        'of the occurrences holding that field value (e.g. a minority gloss).',
        {'form': {'type': 'string'}, 'forms': {'type': 'array', 'items': {'type': 'string'}}, 'document': _DOC,
         'documents': _DOCS, 'value': {'type': 'string'}}, []),
    _fn('lexicon_entry',
        'One lexicon entry in full: all its fields, how many words and morphemes link to it (an entry with senses '
        'counts their links too, and each sense\'s own), and example occurrences. It also says where the entry '
        'sits, the senses under it, what refers to it, and its '
        'promoted usage examples with their numbers.',
        {'entry_form': _ENTRY_FORM, 'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'},
         'entry_gloss': _GLOSS, 'examples': {'type': 'integer', 'description': f'Example occurrences to show (default {ENTRY_EXAMPLES}).'}},
        []),
    _fn('check_consistency',
        'A consistency report for a field: values that are case/spelling variants of one another, forms that carry '
        'several different values, and items annotated but not linked to the lexicon (or linked but empty).',
        {'field': {'type': 'string'}, 'document': _DOC, 'documents': _DOCS}, ['field']),
    _SHARED['recent_changes'],
    _SHARED['comments'],
    _fn('add_comment',
        'PLAN: post a comment under the user\'s name on a document (no ref), a sentence, a word, a morpheme, or, '
        'with field, on one of their values. Comments are notes to people; they change no annotation.',
        {'document': _DOC, 'body': {'type': 'string'}, 'ref': {'type': 'string', 'description': 'sN, sN.wN, or sN.wN.mN.'},
         'field': {'type': 'string'}}, ['document', 'body']),
    _fn('restore_document',
        'PLAN: put a document back as it was at a moment in its history (as_of, an instant recent_changes prints), '
        'every layer at once, in one operation the user can undo the same way. The plan lists what would change. '
        'Maintainers only, and a plan of its own.',
        {'document': _DOC, 'as_of': {'type': 'string', 'description': 'ISO-8601 instant, e.g. 2026-09-05T18:45:49Z.'}},
        ['document', 'as_of']),
    _SHARED['plan_status'],
    _fn('set_document_metadata',
        'PLAN: set one of the project\'s document metadata fields (see project_overview) on a document.',
        {'document': _DOC, 'field': {'type': 'string'}, 'value': {'type': 'string'}}, ['document', 'field', 'value']),
    _fn('create_document',
        'PLAN: create a new document from raw text, one sentence per line; words are tokenized like the editor does. '
        'metadata maps document metadata field names to values.',
        {'name': {'type': 'string'}, 'text': {'type': 'string'},
         'metadata': {'type': 'object', 'additionalProperties': {'type': 'string'}}},
        ['name', 'text']),
    _SHARED['discard_plan'],
    _fn('confirm',
        'PLAN: mark annotations awaiting review as verified, after checking them: machine-made ones (other services, '
        'earlier assistant plans; ~ in reads) and contributors\' work (^ in reads); see worklist kind="unverified" / '
        '"contributed". refs: sentences, words, or morphemes (a sentence covers its words); field: only that '
        'field\'s values; no refs: the whole document. Give `documents` instead of `document` to cover '
        f'several at once: a list of names, or ["all"] for every document with something waiting (up to {MAX_SCOPE_DOCS}).',
        {'document': _DOC, 'refs': _REFS, 'field': {'type': 'string'},
         'documents': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Several documents, by id or name; or ["all"].'}}, []),
    _fn('discard_analysis',
        'PLAN: delete the unverified machine-made analysis of words (their machine links, values, and morphemes); '
        'human-made, contributed, and verified pieces stay. refs: words or sentences.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('make_sense_of',
        'PLAN: move an entry, with everything under it, to sit as a sense of another entry of the same lexicon.',
        {'under_form': {'type': 'string', 'description': 'The entry it should sit under.'},
         'under_id': {'type': 'string'}, **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        []),
    # The sense tree, behind one schema and its manual (R35).
    _fn('senses',
        'PLAN: an entry\'s place in the sense tree: add, move or free a sense, order homographs, add or drop a '
        'usage example. Call with action "help" first.',
        {'action': {'type': 'string',
                    'enum': ['help', 'add', 'move', 'free', 'order_homographs', 'promote_example',
                             'remove_example']},
         **_ENTRY_ADDR, 'entry_gloss': _GLOSS, 'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}},
         'form': {'type': 'string'}, 'type': {'type': 'string'}, 'number': {'type': 'string'},
         'order': {'type': 'array', 'items': {'type': 'string'}}, 'document': _DOC, 'ref': {'type': 'string'},
         'index': {'type': 'integer'}},
        ['action']),
]

_IMPL = {
    'project_overview': t_project_overview, 'read_document': t_read_document, 'search': t_search,
    'read_sentences': t_read_sentences,
    'list_documents': t_list_documents,
    'read_lexicon': t_read_lexicon,
    'set_field': t_set_field, 'set_analysis': t_set_analysis, 'set_morpheme': t_set_morpheme,
    'set_orthography': t_set_orthography,
    'respell': t_respell, 'link_entry': t_link_entry, 'unlink_entry': t_unlink_entry,
    'link_phrase': t_link_phrase, 'unlink_phrase': t_unlink_phrase,
    'create_entry': t_create_entry, 'set_entry_field': t_set_entry_field, 'discard_plan': t_discard_plan,
    'concordance': t_concordance, 'analyses_of': t_analyses_of, 'lexicon_entry': t_lexicon_entry,
    'check_consistency': t_check_consistency, 'recent_changes': t_recent_changes, 'plan_status': t_plan_status,
    'comments': t_comments, 'add_comment': t_add_comment, 'restore_document': t_restore_document,
    'set_document_metadata': t_set_document_metadata, 'create_document': t_create_document,
    'confirm': t_confirm, 'discard_analysis': t_discard_analysis,
    'make_sense_of': t_make_sense_of, 'senses': t_senses,
}



def entry_form_named_form(fn, args: Dict[str, Any]) -> Dict[str, Any]:
    """``form`` read as ``entry_form`` by a tool that names an entry and takes
    no form of its own. analyses_of and concordance call it form, so a model
    asking about an entry reaches for the same word: lexicon_entry(form="kai")
    was refused six times on the prod copy (R1-EXTRACT). The name is resolved
    exactly as entry_form is, homographs and all, so nothing is guessed."""
    if not isinstance(args, dict) or 'form' not in args or 'entry_form' in args:
        return args
    params = inspect.signature(fn).parameters
    if 'entry_form' not in params or 'form' in params:
        return args
    out = dict(args)
    out['entry_form'] = out.pop('form')
    return out


_WHERE = {'type': 'object', 'additionalProperties': {'type': 'string'},
          'description': 'Only where the word meets these conditions, as one sequence_search step takes them, '
                         'e.g. {"form": "di"}.'}

_ENTRY = {'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'},
          'entry_gloss': _GLOSS}

TOOLS += [
    _fn('corpus_stats',
        'Totals and coverage: documents, sentences, words, distinct forms, hapax, type/token ratio, morphemes, the '
        'share of words analysed and linked, every field\'s fill rate, and minutes transcribed and recorded where '
        'there is a time alignment. by="document" gives a per-document '
        'table (with metadata columns); by=<metadata field> (e.g. "Genre") breaks the corpus down by that field.',
        {'document': _DOC, 'documents': _DOCS, 'by': {'type': 'string'}}, []),
    _fn('frequency_list',
        'Ranked counts with document dispersion for wordforms (default), morpheme forms, or a field\'s values.',
        {'what': {'type': 'string', 'description': '"wordform" (default), "morpheme", or a field name.'},
         'document': _DOC, 'documents': _DOCS, 'limit': limit_arg('frequency_list', 'Rows'),
         'min_count': {'type': 'integer'}, 'where': _WHERE,
         'ngram': {'type': 'integer', 'description': '2 counts adjacent word pairs (forms, or a word field\'s '
                                                     'values, e.g. POS for word order), 3 triples.'}}, []),
    _fn('worklist',
        'The unfinished work, grouped by form and ordered by frequency: kind="unlinked" (no lexicon link), '
        '"unglossed" (no value in `field`, default the first morpheme field), "unanalyzed" (no analysis at all), '
        '"unverified" (annotations awaiting review: machine-made and unconfirmed, or a contributor\'s), or '
        '"contributed" (contributors\' unreviewed work only; user= narrows to one person). Use this to decide what '
        'to do next. Across the project each form shows a few examples; NAME A DOCUMENT and it lists every '
        'reference instead, which is the list to plan from and saves reading the document to find them.',
        {'kind': {'type': 'string', 'enum': ['unlinked', 'unglossed', 'unanalyzed', 'unverified', 'contributed']},
         'field': {'type': 'string'},
         'level': {'type': 'string', 'enum': ['word', 'morpheme'], 'description': 'For unlinked: which level to list (default morpheme when there is a morpheme layer). For unglossed the field\'s scope decides.'},
         'user': {'type': 'string', 'description': 'For contributed: only this contributor (their user id, an email).'},
         'document': _DOC, 'documents': _DOCS, 'limit': limit_arg('worklist', 'Rows to show')}, []),
    _fn('check_lexicon',
        'Lexicon hygiene report, worst first with counts. section: "unused" (entries never linked), "fields" (missing '
        'gloss/pos), "homographs" (same form; groups with the same gloss first), "near" (forms one character apart), '
        '"glosses" (lexicon gloss disagrees with the corpus), "spread" (one corpus gloss over several entries), '
        '"stale" (link form no longer contains the entry form), "single" (attested in one document), "refs" (an '
        'entry whose sense or reference points at an entry that is gone), or "all" (default, each section '
        'capped).',
        {'lexicon': {'type': 'string'}, 'section': {'type': 'string'}}, []),
    _fn('check_integrity',
        'Data-shape report: segmentations that do not add up to the word, duplicate and empty sentences, non-NFC '
        'text, mixed apostrophe characters, and unusual characters in the baseline. Reads every document; on a large '
        'project name one.',
        {'document': _DOC, 'documents': _DOCS}, []),
    _fn('sequence_search',
        'Sentences containing a sequence of words, each described by conditions on its form, morphemes, morph type, '
        'or field values, e.g. [{"POS":"v"},{"POS":"n"}] or [{"Gloss":"ERG"},{"form":"ava"}]; conditions match whole '
        'values (regex=true for patterns). A name a word field and a morpheme field share matches either. adjacent=false lets other words come between, in order. Counts are '
        'sentences (first match per sentence). For constituent-order and construction questions.',
        {'sequence': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': {'type': 'string'}}},
         'adjacent': {'type': 'boolean'}, 'document': _DOC, 'documents': _DOCS, 'regex': {'type': 'boolean'},
         'limit': {'type': 'integer'}}, ['sequence']),
    _fn('replace_in_field',
        'PLAN: substitute inside every value of a field, project-wide or in one document: substring by default, '
        'whole=true for exact values, regex=true for patterns with backreferences (\\1). Case counts unless '
        'case_sensitive=false. field="morpheme form" rewrites stored morpheme forms instead of a field. One call '
        'plans every change; the result lists every distinct change it makes (old value → new value), check them '
        'before you describe the plan.',
        {'field': {'type': 'string'}, 'pattern': {'type': 'string'}, 'replacement': {'type': 'string'},
         'regex': {'type': 'boolean'}, 'case_sensitive': {'type': 'boolean', 'description': 'On by default: "PROS" does not find "pros". false to ignore case.'}, 'whole': {'type': 'boolean', 'description': 'Match the whole value only.'}, 'document': _DOC,
         'where': _WHERE},
        ['field', 'pattern', 'replacement']),
    _fn('respell_all',
        'PLAN: change the baseline spelling of every word matching a pattern (an orthography change), keeping each '
        'word\'s analysis, glosses, and links. The same replacement is carried into the stored morpheme forms of '
        'those words (morpheme_forms=false to leave them). Lexicon headwords are left as they are unless lexicon=true '
        '(then the pattern is applied to every entry, not only linked ones: ask the user first, a lexicon can be '
        'shared). Patterns apply within words only.',
        {'pattern': {'type': 'string'}, 'replacement': {'type': 'string'}, 'regex': {'type': 'boolean'}, 'case_sensitive': {'type': 'boolean', 'description': 'Match case too (off by default: "ar" finds "Ar").'},
         'whole': {'type': 'boolean', 'description': 'Match the whole word only.'}, 'document': _DOC, 'morpheme_forms': {'type': 'boolean'},
         'lexicon': {'type': 'boolean'}}, ['pattern', 'replacement']),
    _fn('copy_to_orthography',
        'PLAN: fill an orthography for every word that lacks a value, from the baseline or another orthography.',
        {'orthography': {'type': 'string'}, 'source': {'type': 'string'}, 'document': _DOC,
         'overwrite': {'type': 'boolean'}}, ['orthography']),
    _fn('set_field_for_form',
        'PLAN: set a field value on every occurrence of a form: a morpheme form for a morpheme field, a word form for '
        'a word field (e.g. Gloss (Morpheme) = "OBL" on every morpheme "ди"). only_empty=true (default) fills gaps '
        'and leaves existing values alone; false overwrites them.',
        {'form': {'type': 'string'}, 'field': {'type': 'string'}, 'value': {'type': 'string'},
         'only_empty': {'type': 'boolean'}, 'document': _DOC, 'where': _WHERE}, ['form', 'field', 'value']),
    _fn('set_analysis_for_form',
        'PLAN: apply one analysis (same shape as set_analysis\'s morphemes) to every occurrence of a word form; '
        'skip_analyzed=true leaves already-analysed words alone.',
        {'form': {'type': 'string'},
         'morphemes': {'type': 'array', 'items': {'type': 'object', 'properties': {
             'form': {'type': 'string'}, 'type': {'type': 'string'},
             'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}}, 'required': ['form']}},
         'document': _DOC, 'skip_analyzed': {'type': 'boolean'}}, ['form', 'morphemes']),
    _fn('merge_entries',
        'PLAN: fold one lexicon entry into another (links move to the kept entry, the other is deleted).',
        {'keep_form': {'type': 'string'}, 'remove_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'keep_id': {'type': 'string'}, 'remove_id': {'type': 'string'},
         'keep_gloss': _GLOSS, 'remove_gloss': _GLOSS}, []),
    _fn('delete_entry', 'PLAN: delete a lexicon entry and its links; the words and morphemes stay, unlinked.',
        _ENTRY, []),
    _fn('rename_entry', 'PLAN: change a lexicon entry\'s headword form.',
        {'new_form': {'type': 'string'}, **_ENTRY}, ['new_form']),
    _fn('rename_document', 'PLAN: rename a document.',
        {'document': _DOC, 'new_name': {'type': 'string'}}, ['document', 'new_name']),
]
_IMPL.update({
    'corpus_stats': t_corpus_stats, 'frequency_list': t_frequency_list, 'worklist': t_worklist,
    'check_lexicon': t_check_lexicon, 'check_integrity': t_check_integrity, 'sequence_search': t_sequence_search,
    'replace_in_field': t_replace_in_field, 'respell_all': t_respell_all, 'copy_to_orthography': t_copy_to_orthography,
    'set_analysis_for_form': t_set_analysis_for_form, 'set_field_for_form': t_set_field_for_form, 'merge_entries': t_merge_entries, 'delete_entry': t_delete_entry,
    'rename_entry': t_rename_entry, 'rename_document': t_rename_document,
})
TOOLS += [
    _fn('split_word',
        'PLAN: split one word token into two. at: the left part ("Ali") or the number of characters in it. The '
        'word\'s morpheme analysis is deleted (re-analyse both parts after); its values and link stay on the left part.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'},
         'at': {'type': 'string', 'description': 'The left part, or its length.'}}, ['document', 'ref', 'at']),
    _fn('merge_words',
        'PLAN: merge adjacent words of one sentence into one token. Their morpheme analyses are deleted; word '
        'values are combined losslessly (distinct values joined with " | "); one lexicon link is kept. The text is '
        'unchanged, so the merged word keeps the space between them ("ado thee"). To write them together, respell '
        'the merged word.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('delete_word',
        'PLAN: delete word tokens. The text is unchanged (use respell to change spelling); the words\' analyses, '
        'values, and links go with them.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('split_sentence',
        'PLAN: split a sentence so that word before_word starts a new sentence. Words and their analyses are '
        'untouched; sentence values (translation) stay with the first part.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The sentence, sN.'},
         'before_word': {'type': 'integer', 'description': 'Number of the word that starts the new sentence (2 or more).'}},
        ['document', 'ref', 'before_word']),
    _fn('merge_sentences',
        'PLAN: merge a sentence into the one before it. Sentence values are combined losslessly.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The later sentence, sN (N ≥ 2).'}},
        ['document', 'ref']),
    _fn('append_text',
        'PLAN: add text at the end of a document, one sentence per line, tokenized into words like the editor.',
        {'document': _DOC, 'text': {'type': 'string'}}, ['document', 'text']),
    _fn('retype_sentence',
        'PLAN: replace the baseline text of one sentence (fix a transcript: insert, remove, or respell words). '
        'A word that is edited or typed over keeps its analysis (gloss, morphemes, links) under its new '
        'spelling, a word removed entirely loses it, and new words start unanalyzed. When a retyped word is a '
        'different word, its old analysis is wrong: tell the user, and once the retype is applied, plan its new '
        'analysis. The sentence\'s own fields stay. Newlines in the new text split it into several sentences.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The sentence, sN.'}, 'text': {'type': 'string'}},
        ['document', 'ref', 'text']),
]
_IMPL.update({'split_word': t_split_word, 'merge_words': t_merge_words, 'delete_word': t_delete_word,
              'split_sentence': t_split_sentence, 'merge_sentences': t_merge_sentences,
              'append_text': t_append_text, 'retype_sentence': t_retype_sentence})



TOOLS += [_SHARED['query_help'], _SHARED['query']]
_IMPL.update({'query_help': t_query_help, 'query': t_query})

# One schema for every tagset action, its instructions behind action "help":
# most conversations never set a tagset up.
TOOLS += [_fn('tagsets',
              'PLAN: set up tagsets (the value lists fields are held to): create, change, close, seed from the '
              'values in use, assign to fields. Call with action "help" first.',
              {'action': {'type': 'string', 'enum': ['help', 'check', 'edit', 'assign']},
               'tagset': {'type': 'string'}, 'field': {'type': 'string'}, 'lexicon': {'type': 'string'},
               'changes': {'type': 'object'}}, ['action'])]
_IMPL['tagsets'] = t_tagsets

# The app's user guide behind one short schema: most conversations never ask
# how the app is used (guide.py).
TOOLS += [_fn('app_guide',
              'The app\'s user guide, for "how do I ..." questions. No topic lists its parts.',
              {'topic': {'type': 'string'}}, [])]
_IMPL['app_guide'] = t_app_guide

_IMPL.update({'run_code': t_run_code, 'code_help': t_code_help})

# Every read that takes a document takes several in its place (core/scope.py).
SCOPED_READS = ('search', 'concordance', 'analyses_of', 'check_consistency', 'corpus_stats', 'frequency_list',
                'worklist', 'check_integrity', 'sequence_search')
_IMPL.update({name: among_documents(_IMPL[name]) for name in SCOPED_READS})
TOOLS, WRITE_TOOLS, tools_for, call_tool = toolkit.build(
    TOOLS, _IMPL, manual='interlinear text: how this project glosses, segments and translates',
    web='this corpus and its lexicons', code='the texts and lexicons',
    code_functions=', lexicon(), recording()', rewrite=entry_form_named_form)
