"""The tool table the model sees, and the dispatch behind it.

Every tool an interlinear assistant may call is declared here once, beside the
function that implements it, and nowhere else. A tool that plans a change says
so in the first word of its description, which is what makes it one: there is
no second list to keep in step with this one.

This is the last module in the app to be imported: it reads every tool module,
so nothing here may be imported back by one of them.
"""

import copy
import inspect
import re
from typing import Any, Dict

from ..core import toolkit, webtools
from ..core.limits import MAX_SCOPE_DOCS, MAX_SENTENCES_PER_READ, OVERVIEW_DOCS
from ..core.plan import discard_plan as t_discard_plan, plan_status as t_plan_status
from ..core.tools import ToolError, fn, limit_arg

from .bulk import (t_copy_to_orthography, t_delete_entry, t_merge_entries, t_rename_document,
                   t_rename_entry, t_replace_in_field, t_respell_all, t_set_analysis_for_form,
                   t_set_field_for_form)
from .lines import t_analyze_sentence
from .lexicon import t_create_entry, t_make_sense_of, t_senses, t_set_entry_field
from .query import t_query, t_query_help
from ..core.history import (add_comment_on_values as t_add_comment, comments_on_values as t_comments,
                            recent_changes as t_recent_changes)
from .reads import (CONCORDANCE_LIMIT, ENTRY_EXAMPLES, MAX_FORMS_PER_CALL, READ_LEXICON_LIMIT,
                    t_analyses_of, t_check_consistency, t_concordance, t_lexicon_entry,
                    t_list_documents, t_project_overview,
                    t_read_document, t_read_lexicon, t_read_sentences, t_search)
from .sandbox import t_code_help, t_run_code
from ..core.replace import REPLACEMENT_HELP
from ..core.scope import among_documents
from .guide import t_app_guide
from .tagsets import t_tagsets
from .jobcard import t_propose_job
from .jobread import t_read_job
from .shape import (t_append_text, t_delete_sentence, t_delete_word, t_merge_sentences, t_merge_words,
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
_REGEX_REPLACEMENT = {'type': 'string', 'description': REPLACEMENT_HELP}
_DOCS = {'type': 'array', 'items': {'type': 'string'}}  # several documents in place of one (core/scope.py)
_GLOSS = {'type': 'string', 'description': 'Singles out one of several entries with the same form: a value one of '
                                           'its fields has (e.g. its gloss).'}
_ENTRY_FORM = {'type': 'string',
               'description': 'A headword, with an optional "#" and the number shown beside it. One segment '
                              'is a headword ("gam#2", the second spelled that way), two or more a sense '
                              '("kwatha#1.2", "gam#2.1.3"). A bare "kwatha" is the headword. read_lexicon '
                              'shows every number. A number names only an entry that exists: name one this plan '
                              'adds by the entry_id it was given.'}
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
# The baseline is the user's own transcription. Said where a tool rewrites
# it, where the prompt said it on every call of every turn and these tools
# were called once in 182 recorded runs (FABLE-REVIEW 2026-11-12).
_BASELINE = (' The baseline is the user\'s own transcription: plan this only for a change to the text they asked '
             'for, never to tidy it for an analysis (the project already ignores punctuation when it tokenizes).')

_MORPHEMES = {'type': 'array', 'items': {'type': 'object', 'properties': {
    'form': {'type': 'string'}, 'type': {'type': 'string'},
    'equals': {'type': 'boolean', 'description': 'A "=" before this morpheme (true) or not (false). '
               'Left out, a "=" the word has there now is kept.'},
    'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}}, 'required': ['form']}}

TOOLS = [
    _fn('project_overview',
        'The project: its annotation fields by scope (Word / Morpheme / Sentence), orthographies, lexicons, and the '
        f'list of documents, the first {OVERVIEW_DOCS} by name (list_documents pages and filters the rest). '
        'Your instructions already give the fields, tagsets, orthographies and lexicons: this adds how full each '
        'field is and the documents.', {}, []),
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
        'scope). Empty value clears it. One value on every occurrence of a form, in one call: set_field_for_form. A substitution inside every '
        'value of a field: replace_in_field.',
        {'document': _DOC, 'refs': _REFS, 'field': {'type': 'string'}, 'value': {'type': 'string'},
         'values': {'type': 'object', 'additionalProperties': {'type': 'string'},
                    'description': 'Field name to value, in place of field and value, each set on the refs of its '
                                   'scope. A value of its own on each ref takes one call per ref.'}},
        ['document', 'refs']),
    _fn('set_analysis',
        'PLAN: replace a word\'s morpheme segmentation and morpheme-level fields. Morphemes are given in order; '
        'each has a form, an optional type (stem, root, prefix, suffix, infix, enclitic, proclitic, ...), and '
        'fields mapping morpheme field names to values, e.g. [{"form":"kitab","type":"stem","fields":{"Gloss":"book"}}, '
        '{"form":"lar","type":"suffix","fields":{"Gloss":"PL"}}]. Morphemes as many as the word holds, of the same '
        'forms, joints and types: only the values given that differ are written, and every other value and link stays. Otherwise '
        'it REPLACES the word\'s whole chain: every existing morpheme field value on it, human-made ones included, '
        'is dropped. To change one morpheme\'s form or type, set_morpheme. One word '
        'per call: a sentence or a run of its words takes analyze_sentence. Once '
        'it is planned, sN.wN.mN of that word names a morpheme of the PLANNED analysis in set_field, set_morpheme, '
        'link_entry and unlink_entry, so its new morphemes can be glossed, retyped or linked in the same plan. '
        'One analysis on every occurrence of a word form, in one call: set_analysis_for_form.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'},
         'morphemes': _MORPHEMES},
        ['document', 'ref', 'morphemes']),
    _fn('analyze_sentence',
        'PLAN: segment and gloss sentences word by word. Each sentence is {ref, words}, words one "FORMS GLOSS" '
        'item per word of the ref, in order: morphemes apart by "-" or "=", one space before the gloss, e.g. '
        '{"ref": "s4", "words": ["na-ku-ja PRS-INF-come", "le=o today=DEF"]}. Each glossed morpheme is linked '
        'to the one entry with that form and gloss; the answer lists those with several or none. help: true '
        'for the rest (other fields, words left as they are, new_entries).',
        {'document': _DOC,
         'sentences': {'type': 'array', 'items': {'type': 'object', 'properties': {
             'ref': {'type': 'string', 'description': 'A sentence, "s4", or a run of its words, "s4.w3-w5".'},
             'words': {'type': 'array', 'items': {'type': 'string'}},
             'columns': {'type': 'array', 'items': {'type': 'string'}}}, 'required': ['ref', 'words']}},
         'new_entries': {'type': 'boolean', 'description': 'Only when the instructions or the user ask for new '
                                                           'entries: create one for each form and gloss no entry '
                                                           'has, and link it.'},
         'lexicon': {'type': 'string', 'description': 'Lexicon for new entries (needed only when the project '
                                                      'has several).'},
         'help': {'type': 'boolean'}},
        ['document', 'sentences']),
    _fn('set_morpheme',
        'PLAN: change one morpheme\'s stored form and/or type in place, keeping the chain and every value on it '
        '(e.g. make sN.wN.m2 an enclitic). type "" clears the type. A linked morpheme goes by its entry\'s type: '
        'set that with set_entry_field (field "morphType").',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The morpheme, sN.wN.mN.'},
         'form': {'type': 'string'}, 'type': {'type': 'string'}}, ['document', 'ref']),
    _fn('set_orthography',
        'PLAN: set an orthography value (an alternative transcription tier, not the baseline) on words. Every '
        'word lacking one, from the baseline or another orthography, in one call: copy_to_orthography.',
        {'document': _DOC, 'refs': _REFS, 'orthography': {'type': 'string'}, 'value': {'type': 'string'}},
        ['document', 'refs', 'orthography', 'value']),
    _fn('respell',
        'PLAN: change the BASELINE spelling of one word (its analysis, glosses, and links are kept; a lone '
        'morpheme form spelt like the word follows it unless morpheme_forms=false). For an alternative '
        'transcription tier use set_orthography. Every word matching a pattern, in one call: respell_all.'
        + _BASELINE,
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
        'plan. Use senses for a sense of an existing entry. Many entries from a table go in through Bulk Add on the lexicon\'s page as they are, not through '
        'this, and are tidied after with the lexicon tools.',
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
    'set_field': t_set_field, 'set_analysis': t_set_analysis, 'analyze_sentence': t_analyze_sentence,
    'set_morpheme': t_set_morpheme,
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
        'whole=true for exact values, regex=true for a pattern with groups. Case counts unless '
        'case_sensitive=false. field="morpheme form" rewrites stored morpheme forms instead of a field. The result '
        'lists every distinct change (old value → new value): check them before you describe the plan. Texts '
        'only: offer a lexicon entry with the old value in your reply.',
        {'field': {'type': 'string'}, 'pattern': {'type': 'string'}, 'replacement': _REGEX_REPLACEMENT,
         'regex': {'type': 'boolean'}, 'case_sensitive': {'type': 'boolean', 'description': 'On by default: "PROS" does not find "pros". false to ignore case.'}, 'whole': {'type': 'boolean', 'description': 'Match the whole value only.'}, 'document': _DOC,
         'where': _WHERE},
        ['field', 'pattern', 'replacement']),
    _fn('respell_all',
        'PLAN: change the baseline spelling of every word matching a pattern (an orthography change), keeping each '
        'word\'s analysis, glosses, and links. The same replacement is carried into the stored morpheme forms of '
        'those words (morpheme_forms=false to leave them). Lexicon headwords are left as they are unless lexicon=true '
        '(then the pattern is applied to every entry, not only linked ones: ask the user first, a lexicon can be '
        'shared). Patterns apply within words only.' + _BASELINE,
        {'pattern': {'type': 'string'}, 'replacement': _REGEX_REPLACEMENT, 'regex': {'type': 'boolean'}, 'case_sensitive': {'type': 'boolean', 'description': 'Match case too (off by default: "ar" finds "Ar").'},
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
    _fn('delete_sentence',
        'PLAN: delete whole sentences: their text, words, analyses, links and translation.' + _BASELINE,
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('append_text',
        'PLAN: add text at the end of a document, one sentence per line, tokenized into words like the editor.',
        {'document': _DOC, 'text': {'type': 'string'}}, ['document', 'text']),
    _fn('retype_sentence',
        'PLAN: replace the baseline text of one sentence (fix a transcript: insert, remove, or respell words). '
        'A word edited with a letter of it left keeps its analysis (gloss, morphemes, links) under its new '
        'spelling, a word all of whose letters change or go loses it, and new words start unanalyzed. When a '
        'respelled word is a '
        'different word, its old analysis is wrong: tell the user, and once the retype is applied, plan its new '
        'analysis. The sentence\'s own fields stay. Newlines in the new text split it into several sentences.'
        + _BASELINE,
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The sentence, sN.'}, 'text': {'type': 'string'}},
        ['document', 'ref', 'text']),
]
_IMPL.update({'split_word': t_split_word, 'merge_words': t_merge_words, 'delete_word': t_delete_word,
              'split_sentence': t_split_sentence, 'merge_sentences': t_merge_sentences,
              'delete_sentence': t_delete_sentence,
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

# Drafting an unattended job with the user, behind one short schema and its
# manual: few conversations end in a job (jobcard.py).
TOOLS += [_fn('propose_job',
              'Draft an unattended job for the user to start: the documents and the brief its model follows. '
              'Writes nothing. Call with action "help" first.',
              {'action': {'type': 'string', 'enum': ['help', 'draft']},
               'documents': {'type': 'array', 'items': {'type': 'string'},
                             'description': 'Names or ids, or ["all"].'},
               'brief': {'type': 'string'}}, ['action'])]
_IMPL['propose_job'] = t_propose_job

# What an assistant job did, from its record, behind one short schema: few
# conversations are about a job (jobread.py).
TOOLS += [_fn('read_job',
              'Read an assistant job of this project: no job lists the jobs, a job gives its summary and its '
              'report\'s sections, a section gives that section\'s rows. section "help" says what each holds.',
              {'job': {'type': 'string', 'description': 'The job\'s id.'},
               'section': {'type': 'string'},
               'document': {'type': 'string', 'description': 'Narrows a section to one document, by name or id.'},
               'page': {'type': 'integer'}}, [])]
_IMPL['read_job'] = t_read_job

_IMPL.update({'run_code': t_run_code, 'code_help': t_code_help})

# Every read that takes a document takes several in its place (core/scope.py).
SCOPED_READS = ('search', 'concordance', 'analyses_of', 'check_consistency', 'corpus_stats', 'frequency_list',
                'worklist', 'check_integrity', 'sequence_search')
_IMPL.update({name: among_documents(_IMPL[name]) for name in SCOPED_READS})
# Each project-wide tool comes straight after the one-item tool it does in
# bulk, which is where a model choosing among them reads. set_field_for_form
# was 47th of 65, far from set_field, and in 182 recorded runs it was never
# called: four runs of the task written for it typed 49 references into
# set_field instead (FABLE-REVIEW 2026-11-12).
TOOLS = toolkit.follow(TOOLS, {'set_field_for_form': 'set_field', 'replace_in_field': 'set_field_for_form',
                               'set_analysis_for_form': 'set_analysis', 'copy_to_orthography': 'set_orthography',
                               'respell_all': 'respell'})

TOOLS, WRITE_TOOLS, tools_for, call_tool = toolkit.build(
    TOOLS, _IMPL, manual='interlinear text: how this project glosses, segments and translates',
    web='this corpus and its lexicons', code='the texts and lexicons',
    code_functions=', lexicon(), recording()', rewrite=entry_form_named_form)


# --- the unattended job's tools -------------------------------------------------
# A job is the assistant, unattended (the owner's rulings 12 and 14 of
# 2026-11-13): a piece of a job is offered the assistant's own tools, the
# code tool included, as the chat offers them, and the worker applies what
# it stages by the apply rule (igt/jobapply.py). The planning context is
# offered the reads and code, and plan_work.

#: Tools no job context is offered: drafting a job, and reading jobs, are the
#: chat's business (REV-JG-13).
JOB_LEFT_OUT = ('propose_job', 'read_job')
#: Tools the planning context is not offered besides: it stages nothing, so
#: reading or dropping a staged plan means nothing there (REV-JG-22).
PLAN_LEFT_OUT = ('discard_plan', 'plan_status')

#: The last word of a planning context (``plan_work``).
PLAN_WORK = _fn(
    'plan_work',
    'End the planning: how the job\'s work is cut into pieces, what every piece is told, and optionally which '
    'documents and in what order. pieces: "sentences" (stretches of a few sentences, each its own context), '
    '"document" (one context per document) or "selection" (one context for all the documents). '
    'fills: what the job fills, each named as the message lists it under What a job can fill (segmentation, a '
    'field, an orthography), or [] when it fills nothing, such as a check or a summary. Pieces are shown what of '
    'it is empty. '
    'skip_filled_sentences: with "sentences", true skips every sentence in which nothing the job fills is empty. '
    'edits_text: true when the instructions ask for the text itself to change: words or sentences retyped, '
    'respelled, split, merged, inserted or deleted. '
    'piece_instructions: what every piece is told, as decisions, added to the instructions. documents: names or '
    'ids, a subset of the job\'s documents in the order to work them. Left out, all of them in the job\'s order.',
    {'pieces': {'type': 'string', 'enum': ['sentences', 'document', 'selection']},
     'fills': {'type': 'array', 'items': {'type': 'string'}},
     'skip_filled_sentences': {'type': 'boolean'},
     'edits_text': {'type': 'boolean'},
     'piece_instructions': {'type': 'string'},
     'documents': {'type': 'array', 'items': {'type': 'string'}}}, ['pieces', 'fills'])


def t_plan_work(ws, pieces: str = None, piece_instructions: str = '', documents=None, fills=None,
                skip_filled_sentences: bool = False, edits_text: bool = False) -> str:
    """Check the planning context's plan and keep it on the workspace
    (``ws.plan_work``): a piece size of the menu, what the job fills
    (``fills``, required, names of :func:`targets.fillable`, kept as target
    ids, an empty list for a job that fills nothing, said in the answer:
    :data:`PLAN_FILLS_NOTHING`), whether stretches walk only the sentences where something it
    fills is empty (``skip_filled_sentences``, kept as ``only_empty``, the key
    the job page reads), whether its pieces may change the
    text (``edits_text``, kept only when true: a plan without it, the
    default plan too, offers no tool that changes the text, the owner's
    ruling of 2026-11-15), instructions within their cap, a
    subset of the job's documents named once each. A plan that skips every
    sentence of the documents it works is kept, and its answer says so
    (:data:`PLAN_WORKS_NOTHING`), so the planner may plan again."""
    from ..core.job import composed
    from ..core.limits import JOB_PIECE_INSTRUCTIONS_MAX_CHARS
    if pieces not in ('sentences', 'document', 'selection'):
        raise ToolError('pieces: give "sentences", "document" or "selection".', kind='invalid-argument')
    # Control characters but the line break and the tab mean nothing in
    # instructions, and each would cost six characters where the plan is kept.
    # Composed first, as core measures it (REV-L2-2).
    text = composed(''.join(c for c in str(piece_instructions or '') if c in '\n\t' or ord(c) >= 32)).strip()
    # Longer instructions are cut, never refused: a planner refused for
    # them asked again with the same ones until its calls ran out (BRIEF PF).
    given = len(text)
    text, whole = whole_sentences(text, JOB_PIECE_INSTRUCTIONS_MAX_CHARS)
    known = list(getattr(ws, 'job_documents', None) or [])
    order = None
    if documents:
        if isinstance(documents, str):
            documents = [documents]
        by = {}
        for d in known:
            by.setdefault(d['id'], d['id'])
            by.setdefault(str(d['name']).casefold(), d['id'])
        order, unknown = [], []
        for name in documents:
            got = by.get(str(name)) or by.get(str(name).casefold())
            if got is None:
                unknown.append(str(name))
            elif got not in order:
                order.append(got)
        if unknown:
            raise ToolError('documents: not documents of this job: ' + ', '.join(f'"{u}"' for u in unknown[:5])
                            + '. Leave them out of documents, or leave documents out for every document.',
                            kind='invalid-argument')
    from . import targets as tg
    if fills is None:
        # Required (REV-DF-D-1): a planner that leaves it out would make a
        # job that fills nothing and says nothing.
        raise ToolError('fills: say what the job fills, each named as listed under What a job can fill: '
                        + ', '.join(t.name for t in tg.fillable(ws.project)) + '. Give [] when it fills nothing, '
                        'such as a check or a summary.', kind='invalid-argument')
    if isinstance(fills, str):
        fills = [fills]
    chosen, unknown = tg.named(ws.project, fills)
    if unknown:
        raise ToolError('fills: not something a job on this project can fill: '
                        + ', '.join(f'"{u}"' for u in unknown[:5]) + '. Name each as listed under What a job can '
                        'fill: ' + ', '.join(t.name for t in tg.fillable(ws.project)) + '.', kind='invalid-argument')
    skip = skip_filled_sentences is True and pieces == 'sentences'
    # Kept only when true: the plan's row holds the largest plan at its cap.
    ws.plan_work = {'pieces': pieces, 'piece_instructions': text, 'documents': order,
                    'fills': [t.id for t in chosen],
                    **({'only_empty': True} if skip else {}),
                    **({'edits_text': True} if edits_text is True else {}),
                    **({'instructions_cut': given} if len(text) < given else {})}
    out = ['The plan is kept.']
    if len(text) < given:
        kept = (f'kept up to their last whole sentence within it, {len(text):,} characters' if whole
                else f'cut at {len(text):,} characters, inside a sentence')
        out.append(f'piece_instructions were {given:,} characters, past the most, '
                   f'{JOB_PIECE_INSTRUCTIONS_MAX_CHARS:,}: they are {kept}. Pieces already have the guidelines and '
                   'the instructions.')
    worked = [d for d in known if order is None or d['id'] in order]
    said = len(out)
    if not chosen:
        # Said in one line, as the plan is kept: a planner that meant the job
        # to fill something plans again (REV-DF-D-1).
        out.append(PLAN_FILLS_NOTHING + (' ' + PLAN_FILLS_NOTHING_SENTENCES if pieces == 'sentences' else ''))
    if skip and sum(d.get('sentences', 0) for d in worked) \
            and not any((d.get('empty') or {}).get(t.id) for d in worked for t in chosen):
        # A fixed rule on the planning context's own counts: the walk would
        # take no sentence of any document the plan works (BRIEF OE).
        out.append(PLAN_WORKS_NOTHING)
    out.append('Call plan_work again to change it, or end now with a one-line reply.' if len(out) > said
               else 'End now with a one-line reply.')
    return ' '.join(out)


#: plan_work's answer to a plan whose walk takes no sentence: nothing it
#: fills is empty in any document it works (or it fills nothing).
PLAN_WORKS_NOTHING = 'This plan works no sentence: nothing it fills is empty in its documents.'
#: plan_work's answer to a plan whose fills are empty (a check, a summary),
#: and what it adds for a plan in sentences.
PLAN_FILLS_NOTHING = ('This plan fills nothing: its pieces are shown nothing as empty, and the report lists nothing '
                      'as left blank.')
PLAN_FILLS_NOTHING_SENTENCES = 'Its pieces are offered only set_field and reads.'


#: What ends a sentence when a space or the end follows it: the full stop,
#: the question and exclamation marks, the danda, the Arabic question mark.
SENTENCE_ENDS = '.!?\u0964\u061f'
#: What ends a sentence whatever follows it: a line break, the ideographic
#: full stop (no space after it in Chinese or Japanese).
SENTENCE_BREAKS = '\n\u3002'


def whole_sentences(text: str, limit: int):
    """``(text, True)`` when it is at most ``limit`` characters, else
    ``text`` cut after the last sentence end within ``limit``
    (:data:`SENTENCE_ENDS` followed by a space or the end, or
    :data:`SENTENCE_BREAKS`), True, and at ``limit``, False, when there is
    none (REV-L2-7: the answer says which)."""
    if len(text) <= limit:
        return text, True
    end = max((i + 1 for i in range(limit) if text[i] in SENTENCE_BREAKS
               or (text[i] in SENTENCE_ENDS and (i + 1 == len(text) or text[i + 1].isspace()))), default=None)
    return (text[:end].strip(), True) if end is not None else (text[:limit].strip(), False)


#: The tools that change the text or which words and sentences it has,
#: offered to a piece only when the job's plan says its instructions ask for
#: that (plan_work's ``edits_text``). Morpheme segmentation is no text edit.
#: Whatever stages such a change otherwise (code, a rule) is refused by the
#: job's workspace (``jobapply.edits_text``).
TEXT_TOOLS = ('append_text', 'retype_sentence', 'split_sentence', 'merge_sentences', 'delete_sentence', 'split_word',
              'merge_words', 'delete_word', 'respell', 'respell_all', 'restore_document')


#: What every piece of a plan in sentences is offered whatever its plan
#: fills: the field tool and two reads.
SENTENCES_ALWAYS = ('set_field', 'read_lexicon', 'analyses_of')
#: Offered when segmentation is a target.
SENTENCES_SEGMENTATION = ('analyze_sentence', 'set_analysis')
#: Offered when a target is linked to the lexicon.
SENTENCES_LEXICON = ('link_entry', 'create_entry')
#: Offered when an orthography is a target.
SENTENCES_ORTHOGRAPHY = ('set_orthography',)
#: Offered when the plan edits the text (``TEXT_TOOLS`` decides).
SENTENCES_TEXT = ('retype_sentence', 'split_sentence', 'merge_sentences', 'delete_sentence')


def sentences_piece_tools(targets) -> tuple:
    """The tools a piece of a plan in sentences is offered, from what the
    plan fills (the owner's steer of 2026-11-15: never a fixed glossing
    list): :data:`SENTENCES_ALWAYS`, the analysis tools when segmentation is a
    target, the entry tools when a target is linked to the lexicon, and the
    sentence text tools (offered only when the plan edits the text). The
    toolkit has no other path to the rest, on purpose (BRIEF-EV)."""
    from .targets import SEGMENTATION
    out = SENTENCES_ALWAYS
    if any(t.id == SEGMENTATION for t in targets):
        out += SENTENCES_SEGMENTATION
    if any(t.lexicon for t in targets):
        out += SENTENCES_LEXICON
    if any(t.orthography is not None for t in targets):
        out += SENTENCES_ORTHOGRAPHY
    return out + SENTENCES_TEXT


def job_piece_tools(ws, plan_only: bool = False) -> list:
    """The schemas a piece of a job offers: the assistant's own, as the chat
    offers them on this workspace (code where the sandbox is, the web where
    it is set up), less :data:`JOB_LEFT_OUT`, less :data:`TEXT_TOOLS` unless
    the plan edits the text (``ws.edits_text``), and for a piece of a plan in
    sentences (``ws.in_sentences``) only :func:`sentences_piece_tools` of what
    its plan fills (``ws.fills``). Once
    the piece has been told to decide (``plan_only``), the plan tools alone."""
    left_out = JOB_LEFT_OUT if getattr(ws, 'edits_text', False) else JOB_LEFT_OUT + TEXT_TOOLS
    tools = [t for t in tools_for(ws) if t['function']['name'] not in left_out]
    if getattr(ws, 'in_sentences', False):
        allowed = sentences_piece_tools(getattr(ws, 'fills', ()))
        tools = [_without_check_first(t) for t in tools if t['function']['name'] in allowed]
        tools = _offered_only(tools)
    if plan_only:
        tools = [t for t in tools if t['function']['name'] in WRITE_TOOLS]
    return tools


def job_piece_call(ws, name: str, args: Dict[str, Any]) -> str:
    """One call of a piece's model: a tool its list offers, run as the chat
    runs it, and a refusal for any other. A piece in sentences reads no
    sentence of an answer naming a tool it is not offered (REV-DAY-P-8)."""
    from ..core.tools import refused
    if name not in {t['function']['name'] for t in job_piece_tools(ws, plan_only=ws.decide_now)}:
        return refused('that tool is not one of this job\'s: call one of those listed.', 'invalid-argument')
    out = call_tool(ws, name, args)
    if getattr(ws, 'in_sentences', False) and isinstance(out, str):
        offered = {t['function']['name'] for t in job_piece_tools(ws)}
        kept = _without_names(out, _TOOL_NAMES - offered, underscored=True)
        if kept != out:
            out = type(out)(kept) if type(out) is str else _same_kind(out, kept)
    return out


def _same_kind(out, text: str):
    """``text`` as an answer of ``out``'s kind (a refusal stays one)."""
    from ..core.tools import Refusal
    if isinstance(out, Refusal):
        r = Refusal(text)
        r.kind = out.kind
        return r
    return type(out)(text)


#: Every tool name the assistant has (what a piece may be told of only when
#: it is offered it).
_TOOL_NAMES = frozenset(t['function']['name'] for t in TOOLS)


def _without_names(text: str, names, underscored: bool = False) -> str:
    """``text`` less every parenthesis, then every sentence, that names one
    of ``names`` (a whole word). ``underscored``, for an answer whose data
    may hold plain words: a name holding an underscore anywhere, and a
    one-word name (search, senses) only where the answers name a tool, after
    "use", "call" or "with", or before "action", "tool" or "(" (DF1 open
    point 6): a form or a gloss "search" in the data stays. Line breaks are
    kept."""
    names = set(names)
    if not names or not any(n in text for n in names):
        return text
    if underscored:
        long = sorted(map(re.escape, (n for n in names if '_' in n)), key=len, reverse=True)
        short = sorted(map(re.escape, (n for n in names if '_' not in n)), key=len, reverse=True)
        alts = []
        if long:
            alts.append(r'(?<![A-Za-z0-9_])(?:' + '|'.join(long) + r')(?![A-Za-z0-9_])')
        if short:
            one = '(?:' + '|'.join(short) + ')'
            alts.append(r'(?:(?<=\b[Uu]se )|(?<=\b[Cc]all )|(?<=\b[Ww]ith ))' + one + r'(?![A-Za-z0-9_])')
            alts.append(r'(?<![A-Za-z0-9_])' + one + r'(?= action\b| tool\b|\()')
        if not alts:
            return text
        pattern = re.compile('|'.join(alts))
    else:
        pattern = re.compile(r'(?<![A-Za-z0-9_])(' + '|'.join(sorted(map(re.escape, names), key=len, reverse=True))
                             + r')(?![A-Za-z0-9_])')
    text = re.sub(r' ?\([^()\n]*\)', lambda m: '' if pattern.search(m.group(0)) else m.group(0), text)
    lines = []
    for line in text.split('\n'):
        if not pattern.search(line):
            lines.append(line)
            continue
        parts = re.split(r'(?<=[.!?:])\s+(?=[A-Z"(])', line)
        lines.append(' '.join(p for p in parts if not pattern.search(p)).rstrip())
    return '\n'.join(lines)


def _offered_only(tools: list) -> list:
    """``tools`` with every description less what names a tool none of
    them is, nor an argument of one (REV-DAY-P-8: a sentences piece was told
    of set_morpheme, unlink_entry, set_field_for_form, project_overview)."""
    offered = {t['function']['name'] for t in tools}
    arguments = {a for t in tools for a in (t['function'].get('parameters') or {}).get('properties') or {}}
    stray = _TOOL_NAMES - offered - arguments

    def clean(x):
        if isinstance(x, dict):
            return {k: (_without_names(v, stray) if k == 'description' and isinstance(v, str) else clean(v))
                    for k, v in x.items()}
        if isinstance(x, list):
            return [clean(v) for v in x]
        return x
    return [clean(t) for t in tools]


#: The sentence of analyses_of's description the planning context does not
#: read: plans copied it into every piece's instructions ("check analyses_of
#: first and follow the majority", 42 of the night's 60 plans), and a piece
#: in sentences is handed those analyses (BRIEF-EV).
CHECK_FIRST = 'Check this before proposing an analysis, and follow the majority unless there is reason not to. '


def _without_check_first(t: Dict[str, Any]) -> Dict[str, Any]:
    if t['function']['name'] != 'analyses_of':
        return t
    return {**t, 'function': {**t['function'], 'description': t['function']['description'].replace(CHECK_FIRST, '')}}


def job_plan_tools(ws, plan_only: bool = False) -> list:
    """The schemas the planning context offers: the assistant's reads and
    code (no tool that stages a change), and plan_work, analyses_of without
    :data:`CHECK_FIRST`. Once told to decide, plan_work alone."""
    if plan_only:
        return [PLAN_WORK]
    reads = [_without_check_first(t) for t in tools_for(ws) if t['function']['name'] not in WRITE_TOOLS
             and t['function']['name'] not in JOB_LEFT_OUT + PLAN_LEFT_OUT]
    return reads + [PLAN_WORK]


def job_plan_call(ws, name: str, args: Dict[str, Any]) -> str:
    from ..core.tools import refused, run_tool
    offered = {t['function']['name'] for t in job_plan_tools(ws, plan_only=ws.decide_now)}
    if name not in offered:
        return refused('that tool is not one of this context\'s: call one of those listed.', 'invalid-argument')
    if name == 'plan_work':
        # An argument it does not take is named, with the fix (BRIEF PF).
        unknown = [a for a in (args or {}) if a not in PLAN_WORK['function']['parameters']['properties']]
        if unknown:
            return refused(f'plan_work takes no {", ".join(unknown)}. Call it again without '
                           f'{"it" if len(unknown) == 1 else "them"}. It takes '
                           f'{", ".join(PLAN_WORK["function"]["parameters"]["properties"])}.', 'invalid-argument')
        return run_tool(ws, name, t_plan_work, args, schema=PLAN_WORK['function']['parameters'], reading=True)
    return call_tool(ws, name, args)
