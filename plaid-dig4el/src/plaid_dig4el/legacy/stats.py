"""dig4el's ``libs/stats.py`` (Sebastien Christian, AGPL-3.0): the word statistics its
transcription pages show, copied verbatim; ``custom_split`` is the shared tokenizer."""

from __future__ import annotations

import math
from collections import Counter, defaultdict

from ..inference.tokenizer import custom_split  # noqa: F401  (the same function dig4el's module defined)


def calculate_entropy(prob_dict):
    entropy = 0.0
    for prob in prob_dict.values():
        if prob > 0:
            entropy -= prob * math.log2(prob)
    return entropy

DEFAULT_DELIMITERS = [".", ",", ":", ";", "?", "!", "(", ")", " "]


def build_blind_word_stats_from_knowledge_graph(knowledge_graph, delimiters):
    """ takes a knowledge graph, returns a dictionary of all the words with their frequency and the list of the
    10 most frequent preceding and following words with the corresponding probability of transition.
    When a word comes first in a sentence, the preceding word is "START". When a word comes last in a sentence,
    the following word is "END"."""

    word_stats = {}
    sentence_list = []
    for entry in knowledge_graph:
        target_sentence = knowledge_graph[entry]["recording_data"]["translation"]
        sentence_list.append(target_sentence)

    word_data = defaultdict(lambda: {
        'frequency': 0,
        'preceding': Counter(),
        'following': Counter()
    })

    for sentence in sentence_list:
        words = custom_split(sentence, delimiters)
        words = [word for word in words if word]  # Remove empty tokens
        words = [word.split("_")[0] for word in words]  # Remove the multiple occurrence marker
        for i, word in enumerate(words):
            word_data[word]['frequency'] += 1
            if i > 0:
                word_data[word]['preceding'][words[i - 1]] += 1
            else:
                word_data[word]['preceding'][""] += 1  # No preceding word

            if i < len(words) - 1:
                word_data[word]['following'][words[i + 1]] += 1
            else:
                word_data[word]['following'][""] += 1  # No following word

    word_statistics = {}
    for word, data in word_data.items():
        total_preceding = sum(data['preceding'].values())
        total_following = sum(data['following'].values())

        preceding_probs = {w: count / total_preceding for w, count in data['preceding'].items()}
        following_probs = {w: count / total_following for w, count in data['following'].items()}

        # word_statistics[word] = {
        #     'word': word,
        #     'frequency': data['frequency'],
        #     'preceding': dict(data['preceding'].most_common(10)),
        #     'preceding_prob': dict(sorted(preceding_probs.items(), key=lambda item: item[1], reverse=True)[:10]),
        #     'following': dict(data['following'].most_common(10)),
        #     'following_prob': dict(sorted(following_probs.items(), key=lambda item: item[1], reverse=True)[:10])
        # }

        word_statistics[word] = {
            'word': word,
            'frequency': data['frequency'],
            'preceding': dict(data['preceding']),
            'preceding_prob': dict(sorted(preceding_probs.items(), key=lambda item: item[1], reverse=True)),
            'following': dict(data['following']),
            'following_prob': dict(sorted(following_probs.items(), key=lambda item: item[1], reverse=True))
        }
    return word_statistics


def compute_average_blind_entropy(word_statistics):
    total_entropy = 0.0
    word_count = 0

    for stats in word_statistics.values():
        # Calculate entropy for preceding and following probabilities
        preceding_entropy = calculate_entropy(stats['preceding_prob'])
        following_entropy = calculate_entropy(stats['following_prob'])
        # Average entropy for the current word
        word_entropy = (preceding_entropy + following_entropy) / 2
        total_entropy += word_entropy
        word_count += 1

    # Average entropy for the language
    average_entropy = total_entropy / word_count if word_count > 0 else 0
    return average_entropy
