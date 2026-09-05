"""dig4el's ``libs/knowledge_graph_utils.py`` exploration helpers (Sebastien Christian,
AGPL-3.0), copied verbatim with imports rewired: which words express which concept
values, which concepts a word was connected to, and the words that distinguish one
value of a feature from the others."""

from __future__ import annotations

from ..inference.tokenizer import custom_split
from . import graphs_utils


def get_value_loc_dict(knowledge_graph, concept_kson, selected_f, delimiters):


    value_loc_dict = {}
    value_count_dict = {}
    #available_f = ["INTENT", "PREDICATE", "EVENT TENSE", "POLARITY", "PERSONAL DEICTIC", "ASPECT"]
    f_values = graphs_utils.get_leaves_from_node(concept_kson, selected_f)
    # stats on values and their locations in the knowledge graph: value_loc_dict
    if selected_f in ["INTENT", "PREDICATE"]:
        f = selected_f.lower()
        for v in f_values:
            value_loc_dict[v] = []
        value_loc_dict["neutral"] = []
        for entry_key in knowledge_graph:
            if f in knowledge_graph[entry_key]["sentence_data"].keys():
                local_value_list = knowledge_graph[entry_key]["sentence_data"][f]
                for local_value in local_value_list:
                    if local_value in value_loc_dict:
                        value_loc_dict[local_value].append(entry_key)
                    else:
                        print("Stats on values: Unknown value {} in entry {}".format(local_value, entry_key))
            else:
                print("{} absent of entry {} in knowledge graph".format(f, entry_key))
        for item in value_loc_dict:
            value_count_dict[item] = len(value_loc_dict[item])

    elif selected_f in ["PERSONAL DEICTIC"]:
        print("Selected {}".format(selected_f))
        for v in f_values:
            value_loc_dict[v + " AGENT"] = []
            value_loc_dict[v + " PATIENT"] = []
            value_loc_dict[v + " POSSESSOR"] = []
            value_loc_dict[v + " OTHER"] = []
        for entry_key in knowledge_graph:
            for graph_key in knowledge_graph[entry_key]["sentence_data"]["graph"]:
                if "value" in knowledge_graph[entry_key]["sentence_data"]["graph"][graph_key]:
                    if knowledge_graph[entry_key]["sentence_data"]["graph"][graph_key][
                        "value"] in f_values:
                        local_value = \
                        knowledge_graph[entry_key]["sentence_data"]["graph"][graph_key]["value"]
                        # semantic role
                        if "AGENT" in \
                                knowledge_graph[entry_key]["sentence_data"]["graph"][graph_key][
                                    "path"]:
                            value_loc_dict[local_value + " AGENT"].append(entry_key)
                        elif "PATIENT" in \
                                knowledge_graph[entry_key]["sentence_data"]["graph"][graph_key][
                                    "path"]:
                            value_loc_dict[local_value + " PATIENT"].append(entry_key)
                        elif "POSSESSOR" in \
                                knowledge_graph[entry_key]["sentence_data"]["graph"][graph_key][
                                    "path"]:
                            value_loc_dict[local_value + " POSSESSOR"].append(entry_key)
                        else:
                            value_loc_dict[local_value + " OTHER"].append(entry_key)
        for item in value_loc_dict:
            value_count_dict[item] = len(value_loc_dict[item])

    else:
        print("Selected {}".format(selected_f))
        for v in f_values:
            value_loc_dict[v] = []
        value_loc_dict["neutral"] = []
        for entry_key in knowledge_graph:
            for graph_key in knowledge_graph[entry_key]["sentence_data"]["graph"]:
                if selected_f in graph_key:
                    if "value" in knowledge_graph[entry_key]["sentence_data"]["graph"][graph_key]:
                        if knowledge_graph[entry_key]["sentence_data"]["graph"][graph_key][
                            "value"] in f_values:
                            (value_loc_dict[
                                 knowledge_graph[entry_key]["sentence_data"]["graph"][graph_key][
                                     "value"]]
                             .append((entry_key)))
                        else:
                            value_loc_dict["neutral"].append(entry_key)
    return value_loc_dict


def get_concepts_associated_to_word_by_human(knowledge_graph, word, language):
    """ build a dict with all the concepts connected to a word in the target language
    the dict is word: {'concept':"", 'count':n}"""
    word_concept_connection_dict = {}
    entries_with_word = get_sentences_with_word(knowledge_graph, word, language)
    #print("{} entries with word {}".format(len(entries_with_word), word))
    for entry in entries_with_word:
        found_one = False
        for c in knowledge_graph[entry]["recording_data"]["concept_words"]:
            if knowledge_graph[entry]["recording_data"]["concept_words"][c] == word:
                found_one = True
                if c in word_concept_connection_dict:
                    word_concept_connection_dict[c]["count"] += 1
                    word_concept_connection_dict[c]["entry_list"].append(entry)
                else:
                    word_concept_connection_dict[c] = {"concept": c, "count": 1, "entry_list": [entry]}
        if not found_one:
            if "none" in word_concept_connection_dict:
                word_concept_connection_dict["none"]["count"] +=1
                word_concept_connection_dict["none"]["entry_list"].append(entry)
            else:
                word_concept_connection_dict["none"] = {"concept": "none", "count": 1, "entry_list": [entry]}
    return word_concept_connection_dict


def get_diff_word_statistics_with_value_loc_dict(knowledge_graph, value_loc_dict, v_focus, total_target_word_count, delimiters):
    v_focus_sentences = value_loc_dict[v_focus]
    v_not_focus_sentences = []
    for v in value_loc_dict:
        if v != v_focus:
            v_not_focus_sentences += value_loc_dict[v]

    v_focus_words = []
    v_not_focus_words = []
    for v_focus_sentence in v_focus_sentences:
        v_focus_words += custom_split(
            knowledge_graph[v_focus_sentence]["recording_data"]["translation"],
            delimiters)
    for v_not_focus_sentence in v_not_focus_sentences:
        v_not_focus_words += custom_split(
            knowledge_graph[v_not_focus_sentence]["recording_data"]["translation"],
            delimiters)
    v_focus_words_count = {}
    for word in v_focus_words:
        if word in v_focus_words_count:
            v_focus_words_count[word] += 1
        else:
            v_focus_words_count[word] = 1
    v_not_focus_words_count = {}
    for word in v_not_focus_words:
        if word in v_not_focus_words_count:
            v_not_focus_words_count[word] += 1
        else:
            v_not_focus_words_count[word] = 1

    v_focus_word_frequency = {}
    for word in v_focus_words_count:
        v_focus_word_frequency[word] = v_focus_words_count[word] * 1000 / total_target_word_count
    v_not_focus_word_frequency = {}
    for word in v_not_focus_words_count:
        v_not_focus_word_frequency[word] = v_not_focus_words_count[word] * 1000 / total_target_word_count

    # diff frequencies between v and not v
    v_focus_word_diff_frequency_v_not_v = {}
    for word in v_focus_word_frequency:
        if word in v_not_focus_word_frequency:
            v_focus_word_diff_frequency_v_not_v[word] = v_focus_word_frequency[word] - v_not_focus_word_frequency[word]
        else:
            v_focus_word_diff_frequency_v_not_v[word] = v_focus_word_frequency[word]
    return v_focus_word_diff_frequency_v_not_v


def get_sentences_with_and_without_value(knowledge_graph, concept):
    sentences_with_value = []
    sentences_without_value = []
    for entry in knowledge_graph:
        for item in knowledge_graph[entry]["sentence_data"]["graph"]:
            if knowledge_graph[entry]["sentence_data"]["graph"][item]["value"] == concept:
                sentences_with_value.append(knowledge_graph[entry]["recording_data"]["translation"])
            else:
                sentences_without_value.append(knowledge_graph[entry]["recording_data"]["translation"])
    return sentences_with_value, sentences_without_value


def get_sentences_with_word(knowledge_graph, word, delimiters):
    sentences_with_word = []
    for entry in knowledge_graph:
        words = custom_split(knowledge_graph[entry]["recording_data"]["translation"], delimiters)
        if word in words:
            sentences_with_word.append(entry)
    return sentences_with_word


def build_concept_dict(kg):
    cdict = {}
    # create dict with concepts and their particularizations
    for entry, content in kg.items():
        for concept in content["sentence_data"]["concept"]:
            if concept not in cdict.keys():
                cdict[concept] = []
            details = {
                "pivot_sentence": content["sentence_data"]["text"],
                "target_sentence": content["recording_data"]["translation"],
                "comment": content.get("recording_data", "").get("comment", ""),
                "target_words":
                    content.get("recording_data", "none").get("concept_words", "none").get(concept, "none").split("_")[
                        0],
                "particularization":
                    {
                "enunciation": {"speaker gender": content["speaker_gender"]},
                "intent": {"intent": "&".join(content["sentence_data"]["intent"])
                           },
                "predicate": {"predicate": content["sentence_data"]["predicate"][0]},
                "internal_particularization": {},
                "relational_particularization": {}
                },
                "kg_entry": entry,
                "signature": get_kg_entry_signature(kg, entry)
            }
            if "alternate_pivot" in content["recording_data"].keys():
                if content["recording_data"]["alternate_pivot"] != "":
                    details["alternate_pivot"] = concept["recording_data"]["alternate_pivot"]
            else:
                print("From build_concept_dict: Alternate pivot missing from recording_data in kg")
                details["alternate_pivot"] = ""
            for k, v in content["sentence_data"]["graph"].items():
                if concept in k and v["value"] != "":
                    for ipk in IPKS:
                        if ipk in k:
                            details["particularization"]["internal_particularization"][ipk] = v["value"]
                    for rpk in RPKS:
                        if rpk in k:
                            details["particularization"]["relational_particularization"][rpk] = v["value"]
                if v["value"] == concept:
                    for ipk in IPKS:
                        if ipk in k:
                            details["particularization"]["internal_particularization"][ipk] = v["value"]
                    for rpk in RPKS:
                        if rpk in k:
                            details["particularization"]["relational_particularization"][rpk] = v["value"]
            cdict[concept].append(details)
    return cdict


def target_word_to_concept_dict(knowledge_graph):
    """
    Returns a dict of target_word:[concepts] and concept:[target_words]
    """
    tw_to_concept_dict = {}
    concept_dict = build_concept_dict(knowledge_graph)
    for concept, details in concept_dict.items():
        if details["target_words"] != "":
            tw_to_concept_dict[details["target_words"]] = {
                "concept": concept,
                "particularization": details["particularization"],
                "pivot_sentence": details["pivot_sentence"],
                "target_sentence": details["target_sentence"]
            }
    return tw_to_concept_dict
