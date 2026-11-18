(ns plaid.sql.query.exec-surface-slice-test
  "A token's surface is cut by PLAID_SLICE (exec.clj), which keeps each text
  for one statement, where SQLite's substr walked the text from its start for
  every token. The answers must be the ones substr gave: here every query is
  run both ways (the compiler's old SUBSTR put back with `with-redefs`) over
  texts with astral letters, a combining mark that has no precomposed form,
  zero-width tokens, two layers and two documents. And nothing a statement
  kept may outlive it on its connection: a text edited between two queries on
  one connection reads as edited."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [next.jdbc :as jdbc]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h :refer [id]]
            [plaid.sql.query.compile :as qc]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private hwair "𐍈") ; GOTHIC LETTER HWAIR, one code point, two UTF-16 units
(def ^:private grin "😀") ; U+1F600, one code point, two UTF-16 units
(def ^:private mark (str (char 0x301))) ; COMBINING ACUTE ACCENT
(def ^:private q-acute (str "q" mark)) ; no precomposed form: two code points in NFC too

(defn- build!
  "Two documents. d1 `𐍈 aq\u0301b 😀x. q\u0301` with words over each stretch, a
  zero-width word at each end and in the middle, and morphemes over the words
  (one splitting `aq\u0301b` before its mark). d2 `xx 😀 aq\u0301b`."
  []
  (let [pid   (h/create-test-project admin-request "SurfaceSlice")
        txtl  (id (h/create-text-layer admin-request pid "text"))
        words (id (h/create-token-layer admin-request txtl "words"))
        morph (id (h/create-token-layer admin-request txtl "morphemes"))
        doc-of (fn [dname body]
                 (let [doc (h/create-test-document admin-request pid dname)
                       tx (id (h/create-text admin-request txtl doc body))]
                   {:doc doc :text tx
                    :tok (fn [layer b e & [prec]] (str (id (h/create-token admin-request layer tx b e prec))))}))
        ;; 𐍈 = 0, space 1, a 2, q 3, mark 4, b 5, space 6, 😀 7, x 8, . 9, space 10, q 11, mark 12
        {d1 :doc t1 :text tok :tok} (doc-of "d1" (str hwair " a" q-acute "b " grin "x. " q-acute))
        _ [(tok words 0 0) (tok words 0 1) (tok words 2 6) (tok words 7 10) (tok words 11 13)
           (tok words 6 6) (tok words 13 13)
           (tok morph 2 4 1) (tok morph 4 6 2) (tok morph 7 8 1) (tok morph 8 9 2) (tok morph 9 9 3)]
        {d2 :doc tok2 :tok} (doc-of "d2" (str "xx " grin " a" q-acute "b"))
        _ [(tok2 words 0 2) (tok2 words 3 4) (tok2 words 5 9) (tok2 morph 5 7 1) (tok2 morph 7 9 2)]]
    {:pid pid :words words :morph morph :d1 d1 :d2 d2 :t1 t1}))

(defn- old-surface
  "The surface as the compiler read it until 2026-11-18."
  [st a]
  (let [tx (@#'qc/token-text-alias! st a)]
    [:substr (keyword (str (name tx) ".body"))
     [:+ (keyword (str (name a) ".begin")) [:inline 1]]
     [:- (keyword (str (name a) ".end_")) (keyword (str (name a) ".begin"))]]))

(defn- answer
  "What a query answers, as a comparable value: an aggregate's rows as a set
  of row vectors, any other result's rows in order."
  [q]
  (let [r (qe/run db "admin@example.com" q)]
    (dissoc (cond-> r (= :aggregate (:return r)) (update :results set)) :count)))

(defn- queries [{:keys [pid words morph d1]}]
  (let [scope {"project-ids" [pid]}
        q (fn [m] (assoc m "scope" scope))]
    {"every surface, by layer"
     (q {"where" [["token" "?t" {"layer" "?tl"}] ["token-layer" "?tl" {}]]
         "return" {"group" ["?tl" "?t.value"] "aggregates" [["count"]]}})
     "every surface with its token, ordered by it"
     (q {"find" ["?t"] "where" [["token" "?t" {"layer" words}]] "order-by" [["?t" "value"] ["?t" "begin"]]
         "limit" 100})
     "an astral word"
     (q {"find" ["?t"] "where" [["token" "?t" {"layer" words "value" (str grin "x.")}]]})
     "a word with a combining mark"
     (q {"find" ["?t"] "where" [["token" "?t" {"layer" words "value" ["" (str "a" q-acute "b") q-acute]}]]})
     "a regex over every script"
     (q {"where" [["token" "?t" {"layer" morph "value" {"regex" "^\\p{L}\\p{M}?$"}}]]
         "return" {"group" ["?t.value"] "aggregates" [["count"]]}})
     "a case-insensitive regex"
     (q {"find" ["?t"] "where" [["token" "?t" {"value" {"regex" "X" "flags" "i"}}]] "limit" 100})
     "a word and a morpheme of the same surface"
     (q {"where" [["token" "?w" {"layer" words "value" {"var" "?s"}}]
                  ["token" "?m" {"layer" morph "value" {"var" "?s"}}]]
         "return" {"group" ["?s"] "aggregates" [["count"]]}})
     "a surface not equal to another's"
     (q {"where" [["token" "?w" {"layer" words}] ["token" "?m" {"layer" morph}] ["within" "?m" "?w"]
                  ["!=" "?w.value" "?m.value"]]
         "return" {"group" ["?w.value" "?m.value"] "aggregates" [["count"]]}})
     "words without a morpheme of their own surface"
     (q {"where" [["token" "?w" {"layer" words "value" {"var" "?s"}}]
                  ["not" ["token" "?m" {"layer" morph "value" {"var" "?s"}}] ["within" "?m" "?w"]]]
         "return" {"group" ["?s"] "aggregates" [["count"]]}})
     "one document's surfaces"
     (q {"where" [["token" "?t" {"layer" words "doc" d1}]] "return" {"group" ["?t.value"] "aggregates" [["count"]]}})
     "a count"
     (q {"find" ["?t"] "where" [["token" "?t" {"value" {"regex" "q"}}]] "return" "count"})}))

(deftest the-slice-answers-what-substr-answered
  (let [fx (build!)
        qs (queries fx)
        now (into {} (map (fn [[k q]] [k (answer q)])) qs)]
    (testing "the queries see the texts at all"
      (is (seq (get-in now ["every surface, by layer" :results])))
      (is (= 1 (count (get-in now ["an astral word" :results]))))
      (is (= 6 (count (get-in now ["a word with a combining mark" :results])))
          "three zero-width words, two aq\u0301b and one q\u0301"))
    (let [used (atom 0)]
      (with-redefs [qc/token-surface-sql (fn [st a] (swap! used inc) (old-surface st a))]
        (doseq [[k q] qs]
          (testing k (is (= (answer q) (now k))))))
      (is (<= (count qs) @used) "every query read its surfaces with SUBSTR"))
    (testing "and when a statement keeps less than its texts, so one is read again"
      (with-redefs [qe/slice-keep-chars 4]
        (doseq [[k q] qs]
          (testing k (is (= (answer q) (now k)))))))))

(deftest the-surfaces-are-cut-by-code-point
  (let [{:keys [pid words morph]} (build!)
        surfaces (fn [layer]
                   (->> (qe/run db "admin@example.com"
                                {"scope" {"project-ids" [pid]}
                                 "where" [["token" "?t" {"layer" layer}]]
                                 "return" {"group" ["?t.value"] "aggregates" [["count"]]}})
                        :results (map first) set))]
    (is (= #{"" hwair (str "a" q-acute "b") (str grin "x.") q-acute "xx" grin} (surfaces words)))
    (is (= #{"aq" (str mark "b") grin "x" ""} (surfaces morph)))))

(deftest nothing-a-statement-kept-outlives-it
  (let [{:keys [pid words t1] :as fx} (build!)
        q {"scope" {"project-ids" [pid]}
           "where" [["token" "?t" {"layer" words "doc" (:d1 fx) "begin" 2}]]
           "return" {"group" ["?t.value"] "aggregates" [["count"]]}}]
    (with-open [conn (jdbc/get-connection db)]
      (testing "a first statement on the connection reads the text"
        (is (= [[(str "a" q-acute "b") 1]] (:results (qe/run conn "admin@example.com" q)))))
      (testing "the statement ended and the connection keeps no text"
        (is (= 0 (val (first (jdbc/execute-one! conn ["SELECT PLAID_HAS(?) AS k" (str t1)])))))
        (is (thrown? Exception (jdbc/execute-one! conn ["SELECT PLAID_SLICE(?, NULL, 0, 1) AS s" (str t1)]))
            "and cannot cut it without being given it again"))
      (testing "the text is edited between two statements on one connection"
        (jdbc/execute! conn ["UPDATE texts SET body = ? WHERE id = ?"
                             (str hwair " zz" grin "y " grin "x. " q-acute) (str t1)])
        (is (= [[(str "zz" grin "y") 1]] (:results (qe/run conn "admin@example.com" q))))))))
