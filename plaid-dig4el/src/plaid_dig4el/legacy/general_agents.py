# Copyright (C) 2024 Sebastien CHRISTIAN, University of French Polynesia
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

import json
import os
import copy
import random
import pandas as pd
from ..reference import wals as wu, grambank as gu, bridge as gwu
import math
import pickle

# Reference tables come from plaid_dig4el.reference (loaded lazily).

# CLASSES
class LanguageParameter:
    def __init__(self, parameter_name, origin="wals", priors_language_pk_list = [], verbose=False):
        self.verbose = verbose
        self.name = parameter_name
        self.origin = origin
        self.entropy = 0
        self.weight = 0.3 # trust is used to weight outgoing messages and damp incoming
        self.priors_language_pk_list = priors_language_pk_list
        # a locked boolean is used for parameters with known value.
        self.locked = False
        if self.verbose:
            print("Language Parameter {} initialization, verbose is on.".format(self.name))
        # param pk
        if self.origin == "wals":
            if parameter_name in wu.parameter_pk_by_name:
                self.parameter_pk = str(wu.parameter_pk_by_name[parameter_name])
                if verbose:
                    print("WALS LanguageParameter {}: pk = {}".format(self.name, self.parameter_pk))
            else:
                self.parameter_pk = "none"
            # values
            if self.parameter_pk in wu.domain_elements_pk_by_parameter_pk:
                self.values = wu.domain_elements_pk_by_parameter_pk[self.parameter_pk]
                if verbose:
                    print("WALS LanguageParameter {}: values = {}".format(self.name, self.values))
            else:
                print("parameter origin is supposedly wals but {} not found in wals".format(parameter_name))
                self.values = []
        elif self.origin == "grambank":
            if parameter_name in gu.grambank_pid_by_pname:
                self.parameter_pk = str(gu.grambank_pid_by_pname[parameter_name])
                if verbose:
                    print("Grambank LanguageParameter {}: pk = {}".format(self.name, self.parameter_pk))
                # values
                if self.parameter_pk in gu.grambank_param_value_dict:
                    self.values = list(gu.grambank_param_value_dict[self.parameter_pk]["pvalues"].keys())
                    if verbose:
                        print("Grambank LanguageParameter {}: values = {}".format(self.name, self.values))
            else:
                print("parameter origin is supposedly grambank but {} not found in grambank_pid_by_pname".format(parameter_name))
                self.values = []
        elif self.origin == "dig4el":
            print("dig4el custom parameter {}".format(self.name))
            self.values = []
        else:
            print("Parameter {} origin undefined, values can't be set.".format(parameter_name))
            self.values = []

        # beliefs
        self.beliefs = {}
        self.beliefs_history = []
        self.observations_inbox = []
        self.message_inbox = {}

    def update_entropy(self):
        entropy = -sum(p * math.log(p) for p in self.beliefs.values() if p > 0)
        norm_factor = math.log(len(self.beliefs.keys()))
        self.entropy = entropy/norm_factor

    def update_weight_with_entropy(self):
        min_entropy = 0
        max_entropy = math.log(len(self.beliefs.keys()))
        weight = 1 - (self.entropy - min_entropy) / (max_entropy - min_entropy)
        weight = max(0.0, min(1.0, weight))  # Ensure weight is between 0 and 1
        self.weight =  weight

    def update_weight_from_observations(self):
        self.weight = max(self.beliefs.values())

    def get_winning_belief_code(self):
        return sorted(self.beliefs.keys(), key=self.beliefs.get, reverse=True)[0]

    def get_winning_belief_name(self):
        return gwu.get_pvalue_name_from_value_code(sorted(self.beliefs.keys(), key=self.beliefs.get, reverse=True)[0])

    def initialize_beliefs_with_grambank(self):
        pvalues = gu.grambank_param_value_dict[self.parameter_pk]["pvalues"].keys()
        self.beliefs = gu.compute_grambank_param_distribution(self.parameter_pk, self.priors_language_pk_list)
        self.beliefs_history.append(copy.deepcopy(self.beliefs))
        self.update_entropy()
        if self.verbose:
            print("LanguageParameter {}: Beliefs initialized with Grambank: {}".format(self.name, self.beliefs))

    def initialize_beliefs_with_wals(self):
        depks = wu.domain_elements_pk_by_parameter_pk[self.parameter_pk]
        # initialize with statistical priors
        self.beliefs = wu.compute_wals_param_distribution(self.parameter_pk, self.priors_language_pk_list)
        self.beliefs_history.append(copy.deepcopy(self.beliefs))
        self.update_entropy()
        if self.verbose:
            print("LanguageParameter {}: Beliefs initialized with WALS: {}".format(self.name, self.beliefs))

    def inject_peak_belief(self, depk, probability, locked=False):
        if self.verbose:
            print("LanguageParameter {}: Injecting peak belief {} in value {}.".format(self.name, probability, depk))
        p_yes = probability
        p_not = (1 - probability)/(len(self.values) - 1)
        beliefs = {}
        for value in self.values:
            if str(value) == str(depk):
                beliefs[str(value)] = p_yes
            else:
                beliefs[str(value)] = p_not
        self.beliefs = beliefs
        if locked:
            self.locked = True
        #print("updated belief after injection", self.beliefs)
        self.beliefs_history.append(copy.deepcopy(self.beliefs))
        self.update_entropy()
        # if self.verbose:
        #     print("LanguageParameter {}: beliefs_history updated by inject_peak_belief, length {}.".format(self.name, len(self.beliefs_history)))
        #     print(self.beliefs_history)


    # def update_beliefs_from_observations(self, influence_distribution = "uniform", observation_influence=0.9, autolock_threshold=0.9, verbose=False):
    #     """this function takes in the observation inbox a dict of observation counts of the values of the said parameter
    #     and uses it to update the corresponding uncertain variable.
    #     observations is of the form {value1: count1, value2: count2...}"""
    #     #TODO Implement non uniform influence distribution
    #     # check if the observations given include all the values
    #     if verbose:
    #         print("LanguageParameter {}: Updating current beliefs with {} observations".format(self.name, len(self.observations_inbox)))
    #     if verbose and self.locked:
    #         print("Language Parameter {}: value locked. Observations not taken into account.".format(self.name))
    #     else:
    #         for observations in self.observations_inbox:
    #             values_check = True
    #             for de_pk in self.beliefs.keys():
    #                 if de_pk not in observations.keys():
    #                     values_check = False
    #             if values_check:
    #                 priors = self.beliefs
    #                 if verbose:
    #                     print("LanguageParameter {}: Priors: {}".format(self.name, priors))
    #                 n_values = len(observations.keys())
    #                 if n_values > 1:
    #                     p_yes = observation_influence
    #                     p_not = (1 - p_yes)/(n_values - 1)
    #                 else:
    #                     print("there's just one value... can't update beliefs.")
    #                     return False
    #                 total_number_of_observations = 0
    #                 for de_pk in observations.keys():
    #                     total_number_of_observations += observations[de_pk]
    #
    #                 # multinomial factor used to account for hidden parameters
    #                 multinomial_factor_numerator = math.factorial(total_number_of_observations)
    #                 multinomial_factor_denominator = 1
    #                 for obs in observations.keys():
    #                     multinomial_factor_denominator = multinomial_factor_denominator * math.factorial(observations[obs])
    #                 multinomial_factor = multinomial_factor_numerator / multinomial_factor_denominator
    #                 # likelihoods, probabilities of observing these observations given that the true value is X
    #                 # P(Observations | X = xi)
    #                 likelihoods = {}
    #                 for de_pk in observations.keys():
    #                     # assuming this de_pk is the true value, compute the probability of making these observations
    #                     likelihoods[de_pk] = multinomial_factor
    #                     for observation_key in observations.keys():
    #                         if observation_key == de_pk:
    #                             likelihoods[de_pk] = likelihoods[de_pk] * math.pow(p_yes, observations[observation_key])
    #                         else:
    #                             likelihoods[de_pk] = likelihoods[de_pk] * math.pow(p_not, observations[observation_key])
    #                 if verbose:
    #                     print("LanguageParameter {}: Likelihoods: {}".format(self.name, likelihoods))
    #                 # update of current beliefs (priors)
    #                 # normalization factor
    #                 normalization_factor = 0
    #                 for de_pk in observations:
    #                     normalization_factor += likelihoods[de_pk]*priors[de_pk]
    #                 # updating beliefs
    #                 posteriors = {}
    #                 for de_pk in observations:
    #                     posteriors[de_pk] = likelihoods[de_pk] * priors[de_pk] / normalization_factor
    #                 self.beliefs = posteriors
    #                 self.beliefs_history.append(copy.deepcopy(self.beliefs))
    #                 if verbose:
    #                     print("LanguageParameter {}: posteriors: {}".format(self.name, posteriors))
    #                     print("LanguageParameter {}: beliefs_history updated by observations, length {}.".format(self.name, len(self.beliefs_history)))
    #                     print(self.beliefs_history)
    #                 # AUTOLOCK
    #                 for belief in self.beliefs:
    #                     if self.beliefs[belief] > autolock_threshold:
    #                         self.locked = True
    #                         if self.verbose:
    #                             print("LanguageParameter {}: lock is on. Belief {} at {}, above threshold {}.".format(self.name,
    #                                                                                                            belief,
    #                                                                                                            self.beliefs[
    #                                                                                                                belief],
    #                                                                                                           autolock_threshold
    #                                                                                                            ))
    #         self.observations_inbox = []
    #         self.beliefs_history.append(copy.deepcopy(self.beliefs))
    #         self.update_entropy()

    # SAME AS COMMENTED BUT WITH LOG COMPUTATION TO DEAL WITH SMALL NUMBERS

    import math
    import copy

    def update_beliefs_from_observations(
            self,
            influence_distribution="uniform",
            observation_influence=0.9,
            autolock_threshold=0.9,
            verbose=False
    ):
        """
        Takes from observations_inbox dicts of observation counts for the values
        of this parameter and updates the corresponding uncertain variable.

        Each observation dict is of the form:
            {value1: count1, value2: count2, ...}

        Current implementation uses a symmetric observation model:
        - if the true value is v, observing v has probability p_yes
        - observing any other value has probability p_not
        """

        # TODO: implement non-uniform influence distributions
        if influence_distribution != "uniform":
            raise NotImplementedError("Only 'uniform' influence_distribution is currently implemented.")

        if verbose:
            print(
                "LanguageParameter {}: Updating current beliefs with {} observations".format(
                    self.name, len(self.observations_inbox)
                )
            )

        if self.locked:
            if verbose:
                print(
                    "Language Parameter {}: value locked. Observations not taken into account.".format(
                        self.name
                    )
                )
            return False

        for observations in self.observations_inbox:
            # Check that observations include all values present in beliefs
            values_check = all(de_pk in observations for de_pk in self.beliefs)

            if not values_check:
                if verbose:
                    print(
                        "LanguageParameter {}: observation keys do not match belief keys. "
                        "Skipping observations: {}".format(self.name, observations)
                    )
                continue

            priors = self.beliefs

            if verbose:
                print("LanguageParameter {}: Priors: {}".format(self.name, priors))

            n_values = len(observations)
            if n_values <= 1:
                if verbose:
                    print("LanguageParameter {}: only one value... can't update beliefs.".format(self.name))
                return False

            p_yes = observation_influence
            p_not = (1 - p_yes) / (n_values - 1)

            # Basic sanity checks
            if not (0.0 < p_yes < 1.0):
                raise ValueError(
                    "observation_influence must be strictly between 0 and 1, got {}".format(p_yes)
                )
            if not (0.0 < p_not < 1.0):
                raise ValueError(
                    "Derived p_not must be strictly between 0 and 1, got {}".format(p_not)
                )

            total_number_of_observations = sum(observations.values())

            if total_number_of_observations == 0:
                if verbose:
                    print(
                        "LanguageParameter {}: total number of observations is 0. "
                        "Skipping update.".format(self.name)
                    )
                continue

            # ------------------------------------------------------------------
            # LOG-SPACE MULTINOMIAL FACTOR
            # log(n! / (n1! n2! ... nm!)) = lgamma(n+1) - sum(lgamma(nk+1))
            # ------------------------------------------------------------------
            log_multinomial_factor = math.lgamma(total_number_of_observations + 1)
            for obs_count in observations.values():
                log_multinomial_factor -= math.lgamma(obs_count + 1)

            # ------------------------------------------------------------------
            # LOG LIKELIHOODS: log P(Observations | X = xi)
            # ------------------------------------------------------------------
            log_likelihoods = {}
            for hypothesized_true_value in observations.keys():
                log_likelihood = log_multinomial_factor

                for observed_value, count in observations.items():
                    if count == 0:
                        continue

                    if observed_value == hypothesized_true_value:
                        p = p_yes
                    else:
                        p = p_not

                    log_likelihood += count * math.log(p)

                log_likelihoods[hypothesized_true_value] = log_likelihood

            if verbose:
                print(
                    "LanguageParameter {}: Log-likelihoods: {}".format(
                        self.name, log_likelihoods
                    )
                )

            # ------------------------------------------------------------------
            # LOG POSTERIOR SCORES: log P(O|X=xi) + log P(X=xi)
            # ------------------------------------------------------------------
            log_scores = {}
            for de_pk in observations.keys():
                prior = priors[de_pk]

                if prior <= 0:
                    # impossible under current prior
                    log_scores[de_pk] = float("-inf")
                else:
                    log_scores[de_pk] = log_likelihoods[de_pk] + math.log(prior)

            if verbose:
                print(
                    "LanguageParameter {}: Log-scores: {}".format(
                        self.name, log_scores
                    )
                )

            # If all priors were zero or numerically impossible, skip safely
            finite_scores = [score for score in log_scores.values() if score != float("-inf")]
            if not finite_scores:
                if verbose:
                    print(
                        "LanguageParameter {}: all posterior scores are impossible. "
                        "Skipping update.".format(self.name)
                    )
                continue

            # ------------------------------------------------------------------
            # STABLE NORMALIZATION WITH LOG-SUM-EXP
            # posterior_i = exp(log_score_i - max_log_score) / sum_j exp(...)
            # ------------------------------------------------------------------
            max_log_score = max(finite_scores)

            exp_scores = {}
            for de_pk, score in log_scores.items():
                if score == float("-inf"):
                    exp_scores[de_pk] = 0.0
                else:
                    exp_scores[de_pk] = math.exp(score - max_log_score)

            normalization_factor = sum(exp_scores.values())

            if normalization_factor == 0:
                if verbose:
                    print(
                        "LanguageParameter {}: normalization factor is 0 after log-sum-exp. "
                        "Skipping update.".format(self.name)
                    )
                continue

            posteriors = {}
            for de_pk in observations.keys():
                posteriors[de_pk] = exp_scores[de_pk] / normalization_factor

            self.beliefs = posteriors
            self.beliefs_history.append(copy.deepcopy(self.beliefs))

            if verbose:
                print("LanguageParameter {}: Posteriors: {}".format(self.name, posteriors))
                print(
                    "LanguageParameter {}: beliefs_history updated by observations, length {}.".format(
                        self.name, len(self.beliefs_history)
                    )
                )
                print(self.beliefs_history)

            # AUTOLOCK
            for belief in self.beliefs:
                if self.beliefs[belief] > autolock_threshold:
                    self.locked = True
                    if self.verbose:
                        print(
                            "LanguageParameter {}: lock is on. Belief {} at {}, above threshold {}.".format(
                                self.name,
                                belief,
                                self.beliefs[belief],
                                autolock_threshold
                            )
                        )
                    break

        self.observations_inbox = []
        self.beliefs_history.append(copy.deepcopy(self.beliefs))
        self.update_entropy()
        return True

# ************************************************************************

class GeneralAgent:
    """ A general agent looks at a set of parameters independently of constructions.
    by default, all parameters a general agent observe are considered as nodes of a non-directed,
    fully connected graph."""
    def __init__(self, name, parameter_names=[],
                 language_stat_filter={},
                 active_wals_cpt=None,
                 verbose=False):
        self.verbose = verbose
        if self.verbose:
            print("General Agent {} initialization, verbose is {}.".format(name, verbose))
        self.name = name
        self.language_stat_filters = language_stat_filter
        # the different parameters the general agent is focusing on
        self.parameter_names = parameter_names
        self.language_parameters = {}
        self.graph = {}
        self.active_wals_cpt = active_wals_cpt if active_wals_cpt is not None else wu.cpt
        # make index and column labels strings.
        self.active_wals_cpt.index = self.active_wals_cpt.index.astype(str)
        self.active_wals_cpt.columns = self.active_wals_cpt.columns.astype(str)

        # create language_pks_used_for_statistics
        self.wals_languages_used_for_statistics = self.initialize_wals_list_of_language_pks_used_for_statistics()
        self.grambank_languages_used_for_statistics = self.initialize_grambank_list_of_language_pks_used_for_statistics()

        # create and initialize instances of LanguageParameters objects
        for parameter_name in self.parameter_names:
            if parameter_name in wu.parameter_pk_by_name:
                # This is a WALS parameter
                new_language_parameter = LanguageParameter(parameter_name, origin="wals", priors_language_pk_list=self.wals_languages_used_for_statistics, verbose=self.verbose)
                self.language_parameters[parameter_name] = new_language_parameter
                new_language_parameter.initialize_beliefs_with_wals()
            elif parameter_name in gu.grambank_pid_by_pname:
                # This is a Grambank parameter
                new_language_parameter = LanguageParameter(parameter_name, origin="grambank", priors_language_pk_list=self.grambank_languages_used_for_statistics, verbose=self.verbose)
                self.language_parameters[parameter_name] = new_language_parameter
                new_language_parameter.initialize_beliefs_with_grambank()
            else:
                new_language_parameter = LanguageParameter(parameter_name, origin="dig4el",
                                                           priors_language_pk_list=[],
                                                           verbose=self.verbose)
                self.language_parameters[parameter_name] = new_language_parameter
                new_language_parameter.initialize_beliefs_with_grambank()
        if self.verbose:
            print("General Agent {}: {} instances of LanguageParameter objects initialized.".format(self.name, len(self.language_parameters)))

        # initialize graph
        self.graph_name = "ga_graph_"
        for p in self.language_parameters:
            self.graph_name += p[-3:] + "_"
        self.initialize_graph()

    def get_beliefs(self):
        beliefs = {}
        for lpn in self.language_parameters.keys():
            beliefs[lpn] = self.language_parameters[lpn].beliefs
        return beliefs

    def get_displayable_beliefs(self):
        beliefs = {}
        for lpn in self.language_parameters.keys():
            beliefs[lpn] = {gwu.get_pvalue_name_from_value_code(vcode):proba for vcode, proba in self.language_parameters[lpn].beliefs.items()}
        return beliefs

    def put_beliefs(self, beliefs):
        for lpn in self.language_parameters.keys():
                self.language_parameters[lpn].beliefs = beliefs[lpn]

    def reset_beliefs_history(self):
        for lp_name, lp in self.language_parameters.items():
            lp.beliefs_history = []

    def reset_language_parameters_beliefs_with_wals(self):
        for lp_name, lp in self.language_parameters.items():
            lp.beliefs_history = []
            lp.initialize_beliefs_with_wals()

    def initialize_graph(self, alternate_graph={}):
        """ creates the graph between parameters supporting interactions.
        By default, the graph is fully connected. The alternate_graph param can pass another graph to use.
        The graph is represented by a dict of nodes. Each Pi node's value is a dict of other Pj nodes it is connected
        to, each of these nodes with the value (Pj given Pi) matrix."""
        if self.verbose:
            print("General Agent: initializing graph.")
        if alternate_graph != {}:
            self.graph = alternate_graph
        else:
            for lpn1 in self.language_parameters.keys():
                self.graph[lpn1] = {}
                for lpn2 in self.language_parameters.keys():
                    # add edge and compute only if both wals or grambank
                    if lpn1 in wu.parameter_pk_by_name.keys() and lpn2 in wu.parameter_pk_by_name.keys() and lpn2 != lpn1:
                        cp_matrix = wu.extract_wals_cp_matrix_from_general_data(
                            self.language_parameters[lpn2].parameter_pk,
                            self.language_parameters[lpn1].parameter_pk,
                            active_wals_cpt=self.active_wals_cpt
                        )
                        self.graph[lpn1][lpn2] = cp_matrix
                    elif lpn1 in gu.grambank_pid_by_pname.keys() and lpn2 in gu.grambank_pid_by_pname.keys() and lpn2 != lpn1:
                        cp_matrix = gu.compute_grambank_cp_matrix_from_general_data(
                            self.language_parameters[lpn2].parameter_pk,
                            self.language_parameters[lpn1].parameter_pk
                        )
                        self.graph[lpn1][lpn2] = cp_matrix

                    # grambank base node to wals node, value is wals given grambank
                    elif lpn1 in gu.grambank_pid_by_pname.keys() and lpn2 in wu.parameter_pk_by_name.keys():
                        cp_matrix = gwu.compute_wals_given_grambank_cp(self.language_parameters[lpn2].parameter_pk,
                                                                       self.language_parameters[lpn1].parameter_pk)
                        if cp_matrix is not None:
                            self.graph[lpn1][lpn2] = cp_matrix

                    # wals given grambank
                    elif lpn1 in wu.parameter_pk_by_name.keys() and lpn2 in gu.grambank_pid_by_pname.keys():
                        cp_matrix = gwu.compute_grambank_given_wals_cp(self.language_parameters[lpn2].parameter_pk,
                                                                       self.language_parameters[lpn1].parameter_pk)
                        if cp_matrix is not None:
                            self.graph[lpn1][lpn2] = cp_matrix
        if self.verbose:
            print("Agent {}: Graph initialized.".format(self.name))

    def initialize_grambank_list_of_language_pks_used_for_statistics(self):
        language_pks_used_for_statistics = []
        # TODO: Handle language family filter
        language_pks_used_for_statistics = list(gu.grambank_language_by_lid.keys())
        if self.verbose:
            print("Agent {}: {} grambank languages used for statistics.".format(self.name,
                                                                       len(language_pks_used_for_statistics)))
        return language_pks_used_for_statistics

    def initialize_wals_list_of_language_pks_used_for_statistics(self):
        language_pks_used_for_statistics = []
        if self.language_stat_filters != {}:
            if "family" in self.language_stat_filters.keys():
                for f in self.language_stat_filters["family"]:
                    print("family filter active with {}".format(f))
                    if wu.get_language_pks_by_family(f) is not None:
                        language_pks_used_for_statistics += wu.get_language_pks_by_family(f)
            if "subfamily" in self.language_stat_filters.keys():
                for f in self.language_stat_filters["subfamily"]:
                    language_pks_used_for_statistics +=  wu.get_language_pks_by_subfamily(f)
            if "genus" in self.language_stat_filters.keys():
                for f in self.language_stat_filters["genus"]:
                    language_pks_used_for_statistics += wu.get_language_pks_by_genus(f)
            if "macroarea" in self.language_stat_filters.keys():
                for f in self.language_stat_filters["macroarea"]:
                    language_pks_used_for_statistics += wu.get_language_pks_by_macroarea(f)
            if "exclusion_list" in self.language_stat_filters.keys():
                language_pks_used_for_statistics = [item for item in list(wu.language_by_pk.keys())
                                                    if item not in self.language_stat_filters["exclusion_list"]]

            language_pks_used_for_statistics = list(set(language_pks_used_for_statistics))
        else:
            language_pks_used_for_statistics = list(wu.language_by_pk.keys())
        #print("{} languages used for statistics".format(len(language_pks_used_for_statistics)))
        if self.verbose:
            print("Agent {}: {} wals languages used for statistics.".format(self.name, len(language_pks_used_for_statistics)))
        return language_pks_used_for_statistics

    def run_belief_update_from_observations(self):
        path = self.create_random_propagation_path()
        # update each parameter's beliefs from observations and neighbors messages
        for p_name in path:
            self.language_parameters[p_name].update_beliefs_from_observations()

    def run_belief_update_cycle(self, path_type="random"):
        path = self.create_path(path_type=path_type)
        # run messaging round
        self.run_message_round()
        # update each parameter's beliefs from observations and neighbors messages
        for p_name in path:
            self.update_beliefs_from_messages_received(p_name)

    def run_message_round(self, path_type="random"):
        messages = {}
        path = self.create_path(path_type=path_type)
        for sender_name in path:
            for recipient_name in self.graph[sender_name].keys():
                message = self.generate_message(sender_name, recipient_name)
                self.language_parameters[recipient_name].message_inbox[sender_name] = message
                messages[sender_name + "->" + recipient_name] = message
                # if self.verbose:
                #     print("Message {}->{}: {}".format(sender_name, recipient_name, message))

    def create_random_propagation_path(self):
        """ List of parameters indicating the order in which the belief propagation is executed."""
        path = self.parameter_names.copy()
        random.shuffle(path)
        if self.verbose:
            print("General Agent {}: Random belief propagation path is {}".format(self.name, path))
        return path

    def create_path(self, path_type="random"):
        path = []
        if path_type == "random":
            path = self.parameter_names.copy()
            random.shuffle(path)
            return path
        elif path_type == "decreasing_beliefs":
            p = {pname:max(self.language_parameters[pname].beliefs.values()) for pname in self.language_parameters.keys()}
            path = list(sorted(p.keys(), key=p.get, reverse=True))
            return path
        elif path_type == "increasing_beliefs":
            p = {pname:max(self.language_parameters[pname].beliefs.values()) for pname in self.language_parameters.keys()}
            path = list(sorted(p.keys(), key=p.get, reverse=False))
            return path

    def add_observations(self, parameter_name, observations):
        """ add observations to a LanguageParameter observation inbox.
        Observations are {'depk':number of occurrences}
        example:
        observations = {'387': 0, '386': 0, '388': 0, '385': 8, '383': 2, '384': 0, '389': 0}
        gawo.add_observations("Order of Subject, Object and Verb", observations)"""
        if self.verbose:
            print("Agent {}: adding observation {} to LanguageParameter {}.".format(self.name, observations, parameter_name))
        if parameter_name in self.language_parameters.keys():
            self.language_parameters[parameter_name].observations_inbox.append(observations)

    def update_beliefs_from_messages_received(self, parameter_name, damping_factor=0.5, verbose=False):
        """
        Updates the beliefs of a parameter based on messages received from neighbors,
        incorporating a damping factor.

        Parameters:
        - parameter_name: Name of the parameter (node) to update.
        - damping_factor: Damping factor alpha (default is 0.5).

        Returns:
        - None (the function updates the beliefs in place).
        """
        if verbose:
            print("Agent {}: update_beliefs_from_messages_received({})".format(self.name, parameter_name))
            print("Initial belief: {}".format(self.language_parameters[parameter_name].beliefs))
        # Retrieve the parameter object
        P = self.language_parameters[parameter_name]

        # Update beliefs only if the parameter is not locked
        if not P.locked:

            # Get the messages from neighbors
            message_inbox = P.message_inbox  # {neighbor_name: message_dict}

            # Initialize variables
            x_i_values = P.beliefs.keys()
            computed_beliefs = {}

            for x_i in x_i_values:
                # Start with current belief as the prior
                prior_belief = P.beliefs.get(x_i, 1.0 / len(x_i_values))  # Default to uniform if missing
                belief = prior_belief  # Use the current belief as the starting point

                # Multiply by messages from all neighbors
                for neighbor_name, message in message_inbox.items():
                    m_neighbor_to_P = message  # {x_i: probability}
                    m_value = m_neighbor_to_P.get(x_i, 1.0)  # Default to 1.0 if message value is missing
                    belief *= m_value

                computed_beliefs[x_i] = belief

            # Normalize the computed beliefs
            total_belief = sum(computed_beliefs.values())
            if total_belief > 0:
                for x_i in x_i_values:
                    computed_beliefs[x_i] /= total_belief
            else:
                # Handle zero total by assigning uniform probabilities
                num_values = len(x_i_values)
                if num_values > 0:
                    uniform_prob = 1.0 / num_values
                    for x_i in x_i_values:
                        computed_beliefs[x_i] = uniform_prob

            # Apply the damping factor
            damped_beliefs = {}
            for x_i in x_i_values:
                old_belief = P.beliefs.get(x_i, 1.0 / len(x_i_values))  # Default to uniform if missing
                new_belief = computed_beliefs[x_i]
                damped_belief = damping_factor * old_belief + (1 - damping_factor) * new_belief
                damped_beliefs[x_i] = damped_belief

            # Normalize the damped beliefs
            total_damped_belief = sum(damped_beliefs.values())
            if total_damped_belief > 0:
                for x_i in x_i_values:
                    damped_beliefs[x_i] /= total_damped_belief
            else:
                # Handle zero total by assigning uniform probabilities
                num_values = len(x_i_values)
                if num_values > 0:
                    uniform_prob = 1.0 / num_values
                    for x_i in x_i_values:
                        damped_beliefs[x_i] = uniform_prob

            # Update the beliefs in the parameter object
            P.beliefs = damped_beliefs
            P.beliefs_history.append(copy.deepcopy(P.beliefs))
            P.update_entropy()
            if verbose:
                print(
                    "Agent {}: belief of parameter {} updated with damping factor {}".format(self.name, parameter_name,
                                                                                             damping_factor))
                print("New belief: {}".format(self.language_parameters[parameter_name].beliefs))

        else:
            if verbose:
                print("Agent {}: parameter {} is locked and will not be updated by messages.".format(self.name,
                                                                                                     parameter_name))

    def generate_message(self, Pi_name, Pj_name, verbose=False):
        """
        Generates the message from parameter Pi to parameter Pj using belief propagation,
        incorporating a weighting parameter for the sender node Pi.

        Parameters:
        - Pi_name: Name of the sender parameter (node).
        - Pj_name: Name of the recipient parameter (node).

        Returns:
        - A dictionary representing the message {pj_value_code: probability}.
        """
        if verbose:
            print("Agent {}: Generate message {} ---> {}".format(self.name, Pi_name, Pj_name))

        # Retrieve the parameter objects
        Pi = self.language_parameters[Pi_name]
        Pj = self.language_parameters[Pj_name]

        # Get the potential function between Pi and Pj
        cp_matrix_Pj_given_Pi = self.graph[Pi_name][Pj_name]  # DataFrame with rows x_j, columns x_i

        # Get the local beliefs at node Pi
        phi_i = Pi.beliefs  # {x_i: probability}

        # Get neighbors of Pi excluding Pj
        neighbors_i = self.graph[Pi_name].keys()
        neighbors_except_j = [k for k in neighbors_i if k != Pj_name]

        # Initialize the product of incoming messages for each x_i
        x_i_values = phi_i.keys()  # Possible values of Pi
        product_messages = {x_i: 1.0 for x_i in x_i_values}

        # Multiply messages from all neighbors except Pj
        for neighbor_name in neighbors_except_j:
            # Get the message from neighbor to Pi
            m_neighbor_to_Pi = Pi.message_inbox.get(neighbor_name, {})
            for x_i in x_i_values:
                # Get the message value, defaulting to 1.0 if not present
                m_value = m_neighbor_to_Pi.get(x_i, 1.0)
                product_messages[x_i] *= m_value

        # Compute the message from Pi to Pj
        x_j_values = Pj.beliefs.keys()  # Possible values of Pj
        message_Pi_to_Pj = {x_j: 0.0 for x_j in x_j_values}

        for x_j in x_j_values:
            total = 0.0
            for x_i in x_i_values:
                # Retrieve values
                phi_i_xi = phi_i.get(x_i, 0.0)
                psi_ij = cp_matrix_Pj_given_Pi.at[x_j, x_i]  # Potential value between x_i and x_j
                prod_msg_xi = product_messages.get(x_i, 1.0)
                # Compute the term
                term = phi_i_xi * psi_ij * prod_msg_xi
                total += term
            message_Pi_to_Pj[x_j] = total

        # **Incorporate the weighting parameter**
        # Retrieve the weight of node Pi
        weight_Pi = Pi.weight  # Assuming that Pi has an attribute 'weight'

        # Multiply the entire message by the weight
        for x_j in x_j_values:
            message_Pi_to_Pj[x_j] *= weight_Pi

        # Normalize the message
        total_message = sum(message_Pi_to_Pj.values())
        if total_message > 0:
            for x_j in x_j_values:
                message_Pi_to_Pj[x_j] /= total_message
        else:
            # Handle zero total by assigning uniform probabilities or keeping zeros
            num_values = len(x_j_values)
            if num_values > 0:
                uniform_prob = 1.0 / num_values
                for x_j in x_j_values:
                    message_Pi_to_Pj[x_j] = uniform_prob

        if verbose:
            print("Agent {}: Generated message {} ---> {}: {}".format(self.name, Pi_name, Pj_name, message_Pi_to_Pj))
        # Return the computed message
        return message_Pi_to_Pj




