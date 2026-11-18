(ns plaid.sql.query.exec-link-precedent-split-test
  "igt's link precedent count, asked two ways. The way igt asked until
  2026-11-18 groups every linked token by its surface AND its morpheme form,
  so a morpheme's row splits by the word it sits in, and a large project
  passes the 100,000-group cap. The split way binds a word token in one `or`
  alternative and a morpheme token in the other, groups words by their value
  and morphemes by their form, and pads the key the alternative does not bind
  with null. Folded as igt folds the rows (a morpheme's form when it has one,
  the token's value otherwise), the two must give the same tally, here over
  words, morphemes, zero-width morphemes, a morpheme with no form or an empty
  one, and multi-word expressions."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h :refer [id]]
            [plaid.sql.project :as prj]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private provs
  [nil
   {"prov" "inferred" "provSource" "service:x"}
   {"prov" "inferred" "provSource" "service:x" "provConfirmed" true}
   {"prov" "contributed" "provSource" "user:ann@x.com"}])

(defn- build!
  "Two documents over one word layer and one morpheme layer (roles set as igt
  sets them), a lexicon with entries of three morph types, and links of every
  kind the count meets."
  []
  (let [pid   (h/create-test-project admin-request "PrecSplit")
        txtl  (id (h/create-text-layer admin-request pid "text"))
        words (id (h/create-token-layer admin-request txtl "words"))
        morph (id (h/create-token-layer admin-request txtl "morphemes"))
        _     (prj/assoc-editor-config-pair db :token_layers words "plaid" "role" "word" nil)
        _     (prj/assoc-editor-config-pair db :token_layers morph "plaid" "role" "morpheme" nil)
        vl    (id (h/create-vocab-layer admin-request pid "PrecSplit-lex"))
        _     (h/link-vocab-to-project admin-request pid vl)
        a     (id (h/create-vocab-item admin-request vl "a" {"morphType" "stem"}))
        b     (id (h/create-vocab-item admin-request vl "b" {"morphType" "suffix"}))
        c     (id (h/create-vocab-item admin-request vl "c"))
        p     (id (h/create-vocab-item admin-request vl "ee ff" {"morphType" "phrase"}))
        doc-of (fn [dname body]
                 (let [doc (h/create-test-document admin-request pid dname)
                       tx (id (h/create-text admin-request txtl doc body))
                       tok (fn [layer b e & [prec meta]]
                             (id (h/create-token admin-request layer tx b e prec meta)))]
                   {:doc doc :tok tok}))
        ;; "aa bb-cc dd. ee ff aa"
        {d1 :doc tok :tok} (doc-of "d1" "aa bb-cc dd. ee ff aa")
        w0 (tok words 0 2) w1 (tok words 3 8) w2 (tok words 9 12)
        w3 (tok words 13 15) w4 (tok words 16 18) w5 (tok words 19 21)
        ;; a morpheme spans its word, ordered by precedence, as igt writes
        ;; them, so its value is the WORD's text. Two are zero-width.
        m-aa (tok morph 0 2 1 {"form" "aa"})
        m-bb (tok morph 3 8 1 {"form" "bb"})
        m-cc (tok morph 3 8 2 {"form" "cc"})
        m-zero (tok morph 8 8 nil {"form" "∅"})
        m-noform (tok morph 15 15)
        m-empty (tok morph 13 15 1 {"form" ""})
        m-num (tok morph 16 18 1 {"form" 7})
        m-aa2 (tok morph 19 21 1 {"form" "aa"})
        ;; the second document repeats a form in another word
        {d2 :doc tok2 :tok} (doc-of "d2" "bb-xx aa")
        v0 (tok2 words 0 5) v1 (tok2 words 6 8)
        n-bb (tok2 morph 0 5 1 {"form" "bb"})
        n-xx (tok2 morph 0 5 2 {"form" "xx"})
        link! (fn [item toks prov]
                (let [r (if prov
                          (h/create-vocab-link admin-request item toks prov)
                          (h/create-vocab-link admin-request item toks))]
                  (assert (= 201 (:status r)) (pr-str [toks (:body r)]))))]
    (doseq [[item toks prov] [[a [w0] 1] [b [w0] 0] [a [w5] 1] [a [v1] 2]
                              [a [m-aa] 2] [a [m-aa2] 0] [b [m-bb] 0] [b [n-bb] 0] [c [m-cc] 1]
                              [c [m-zero] 0] [a [m-noform] 1] [b [m-empty] 0] [c [m-num] 2]
                              [c [n-xx] 0] [p [w2] 0]
                              ;; multi-word expressions, left out by the count
                              [p [w3 w4] 3] [p [v0 v1] 0]
                              [a [w1] 1]]]
      (link! item toks (provs prov)))
    {:pid pid :vl vl :d1 d1 :d2 d2}))

(def ^:private role-and-rest
  ["?tl.config.plaid.role" "?v.metadata.morphType" "?l.metadata.prov" "?l.metadata.provConfirmed"])

(defn- in-doc [doc] (if doc {"layer" "?tl" "doc" doc} {"layer" "?tl"}))

(defn- one-token-only [t]
  [["not" ["link-token" "?l" "?t2"] ["precedes*" t "?t2"]]
   ["not" ["link-token" "?l" "?t2"] ["precedes*" "?t2" t]]])

(defn- joint-query
  "igt's link precedent query as it was: one token var, grouped by its value
  AND its morpheme form."
  [{:keys [pid vl]} doc]
  {"scope" {"project-ids" [pid]}
   "where" (into [["vocab" "?v" {"layer" vl}]
                  ["link-item" "?l" "?v"]
                  ["link-token" "?l" "?t"]
                  ["token" "?t" (in-doc doc)]
                  ["token-layer" "?tl" {}]]
                 (one-token-only "?t"))
   "return" {"group" (into ["?v" "?t.value" "?t.metadata.form"] role-and-rest)
             "aggregates" [["count"]]}})

(defn- split-query
  "The same count with a word alternative (no morpheme form, or an empty one:
  grouped by its value) and a morpheme alternative (a form of at least one
  character: grouped by it, no surface read). The two are each other's
  negation, so every token is in exactly one."
  [{:keys [pid vl]} doc]
  (let [has-form {"metadata" {"form" {"regex" "[\\s\\S]"}}}
        alt (fn [t form-clause]
              (into [["link-token" "?l" t] ["token" t (in-doc doc)] form-clause] (one-token-only t)))]
    {"scope" {"project-ids" [pid]}
     "where" [["vocab" "?v" {"layer" vl}]
              ["link-item" "?l" "?v"]
              ["token-layer" "?tl" {}]
              ["or"
               (alt "?w" ["not" ["token" "?w" has-form]])
               (alt "?m" ["token" "?m" has-form])]]
     "return" {"group" (into ["?v" "?w.value" "?m.metadata.form"] role-and-rest)
               "aggregates" [["count"]]}}))

(defn- fold
  "As plaid-igt's foldLinkRows reads a row: the morpheme form when it is there
  and not empty, the token's value otherwise."
  [rows]
  (reduce (fn [m [item value mform role mtype prov confirmed n]]
            (let [form (if (and (some? mform) (not= "" mform)) (str mform) (str (or value "")))]
              (update m [(str item) role form mtype prov confirmed] (fnil + 0) n)))
          {} rows))

(deftest the-split-count-folds-to-the-joint-count
  (let [fx (build!)]
    (doseq [[label doc] [["project" nil] ["document d1" (:d1 fx)] ["document d2" (:d2 fx)]]]
      (testing label
        (let [joint (qe/run db "admin@example.com" (joint-query fx doc))
              split (qe/run db "admin@example.com" (split-query fx doc))]
          (is (seq (:results joint)))
          (is (= (fold (:results joint)) (fold (:results split))))
          (is (= (:columns joint) ["v" "t_value" "t_metadata_form" "tl_config_plaid_role"
                                   "v_metadata_morphType" "l_metadata_prov" "l_metadata_provConfirmed" "count"]))
          (is (= 8 (count (:columns split))))
          (testing "a morpheme row reads no surface, a word row no form"
            (is (every? (fn [[_ value mform]] (not (and (some? value) (some? mform)))) (:results split))))
          (testing "a form in two words is one group, not one per word"
            (if doc
              (is (<= (count (:results split)) (count (:results joint))))
              (is (< (count (:results split)) (count (:results joint)))
                  "b's bb in bb-cc and in bb-xx"))))))
    (testing "the counts themselves, project-wide"
      (let [t (fold (:results (qe/run db "admin@example.com" (split-query fx nil))))
            n (fn [role form] (reduce + (keep (fn [[[_ r f] k]] (when (and (= r role) (= f form)) k)) t)))]
        (is (= 4 (n "word" "aa")) "w0 twice, w5 and v1")
        (is (= 2 (n "morpheme" "aa")))
        (is (= 2 (n "morpheme" "bb")) "one in each document")
        (is (= 1 (n "morpheme" "∅")))
        (is (= 1 (n "morpheme" "")) "a morpheme with no form reads its (empty) surface")
        (is (= 1 (n "morpheme" "ee")) "a morpheme with an empty form reads its surface")
        (is (= 1 (n "morpheme" "7")))
        (is (= 1 (n "word" "dd.")) "a phrase entry's one-word link is still counted")
        (is (= 1 (n "word" "bb-cc")))
        (is (zero? (n "word" "ee")) "a multi-word expression is left out")))))
