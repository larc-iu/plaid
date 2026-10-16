(ns plaid.rest-api.v1.token-counts-test
  "POST /api/v1/query/token-counts: per document, how many tokens of a layer have
  a surface the regex matches, the same tokens the query language's :value regex
  finds, and only on layers the caller can read."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request user1-request]]
            [plaid.test-helpers :as h :refer [id]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; plaid-igt's word pattern: a token holding something other than punctuation,
;; a pictograph or ∅ (igtConfig.js wordValueSpec).
(def ^:private word-pattern
  {:regex "[^\\p{P}\\p{S}]|[\\p{IsExtended_Pictographic}\\x{2205}]"})

(defn- corpus! [pname body]
  (let [pid (h/create-test-project admin-request pname)
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        doc (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc body))
        cps (vec (.toArray (.codePoints ^String body)))
        ;; a token over every run of non-space code points
        runs (loop [k 0 out []]
               (cond
                 (>= k (count cps)) out
                 (Character/isWhitespace (int (cps k))) (recur (inc k) out)
                 :else (let [e (loop [e k] (if (and (< e (count cps)) (not (Character/isWhitespace (int (cps e))))) (recur (inc e)) e))]
                         (recur e (conj out [k e])))))]
    (doseq [[b e] runs] (h/create-token admin-request tokl text b e))
    {:pid pid :tokl (str tokl) :doc (str doc) :text (str text) :tokens (count runs)}))

(defn- counts [req layers value]
  (api-call req {:method :post :path "/api/v1/query/token-counts"
                 :body {:layers layers :value value}}))

(defn- ql-count [layer value]
  (-> (api-call admin-request
                {:method :post :path "/api/v1/query"
                 :body {:where [["token" "?t" {"layer" layer "value" value}]]
                        :return {:group [] :aggregates [["count"]]}}})
      :body :results ffirst))

(deftest counts-what-the-query-language-finds
  (let [{:keys [tokl doc tokens]} (corpus! "P1" "Ana ... 𝒙 ¿Qué ?! → © 😀 ∅ « runs »")
        resp (counts admin-request [tokl] word-pattern)]
    (fix/assert-status 200 resp)
    (is (= 12 tokens))
    (is (= [[tokl doc 7]] (-> resp :body :results)))
    (testing "the same count as a query's :value regex on the tokens"
      (is (= 7 (ql-count tokl word-pattern))))
    (testing "a flag and a document with no match"
      (is (= [[tokl doc 1]] (-> (counts admin-request [tokl] {:regex "^ana$" :flags "i"}) :body :results)))
      (is (= [[tokl doc 0]] (-> (counts admin-request [tokl] {:regex "zzz"}) :body :results))))))

(deftest a-long-document-counts-fast
  (let [body (apply str (repeat 20000 "Ana runs, «Ben» said... "))
        pid (h/create-test-project admin-request "Long")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        doc (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc body))
        unit [[0 3] [4 8] [8 9] [10 11] [11 14] [14 15] [16 20] [20 23]]
        len 24
        specs (for [i (range 20000) [b e] unit]
                {:token-layer-id tokl :text text :begin (+ (* i len) b) :end (+ (* i len) e)})]
    (doseq [part (partition-all 500 specs)]
      (let [r (api-call admin-request {:method :post :path "/api/v1/tokens/bulk" :body (vec part)})]
        (is (= 201 (:status r)) (pr-str (:body r)))))
    (let [t0 (System/nanoTime)
          resp (counts admin-request [(str tokl)] word-pattern)
          ms (/ (- (System/nanoTime) t0) 1e6)]
      (fix/assert-status 200 resp)
      ;; Ana runs Ben said: 4 words of 8 tokens a unit
      (is (= [[(str tokl) (str doc) 80000]] (-> resp :body :results)))
      (is (< ms 5000) (str "took " ms " ms")))))

(deftest only-layers-the-caller-can-read
  (let [{:keys [tokl]} (corpus! "Private" "Ana runs.")]
    (testing "another user's layer is left out"
      (is (= [] (-> (counts user1-request [tokl] word-pattern) :body :results))))
    (testing "a bad request is a 400"
      (fix/assert-status 400 (counts admin-request [tokl] {:regex "("}))
      (fix/assert-status 400 (counts admin-request "x" word-pattern)))))

(deftest a-count-follows-every-change
  (let [{:keys [tokl doc text]} (corpus! "P2" "Ana runs")
        words #(-> (counts admin-request [tokl] word-pattern) :body :results)]
    (is (= [[tokl doc 2]] (words)))
    (testing "text typed over a word, which keeps its place and its offsets"
      (fix/assert-status 200 (api-call admin-request
                                       {:method :patch :path (str "/api/v1/texts/" text)
                                        :body {:edits [{:type "delete" :index 0 :value 3}
                                                       {:type "insert" :index 0 :value "..."}]}}))
      (is (= [[tokl doc 1]] (words))))
    (testing "a token made"
      (h/create-token admin-request tokl text 4 6)
      (is (= [[tokl doc 2]] (words))))))

(deftest a-count-read-inside-a-rolled-back-batch-is-not-kept
  ;; REV7-CORE-1: the batch moves "word" onto "." (the version goes up by one
  ;; inside the transaction), reads the count there, then fails and rolls
  ;; back. A later write that lands on the same version and token count must
  ;; not be served the count the rolled-back batch read.
  (let [pid (h/create-test-project admin-request "P3")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (str (id (h/create-token-layer admin-request txtl "words")))
        doc (str (h/create-test-document admin-request pid "d1"))
        text (id (h/create-text admin-request txtl doc "word . more"))
        word (id (h/create-token admin-request tokl text 0 4))
        _ (h/create-token admin-request tokl text 7 11)
        punct {:regex "^\\p{P}+$"}
        punct-count #(-> (counts admin-request [tokl] punct) :body :results)]
    (is (= [[tokl doc 0]] (punct-count)))
    (let [resp (api-call admin-request
                         {:method :post :path "/api/v1/batch"
                          :body [{:path (str "/api/v1/tokens/" word) :method "patch" :body {:begin 5 :end 6}}
                                 {:path "/api/v1/query/token-counts" :method "post"
                                  :body {:layers [tokl] :value punct}}
                                 {:path "/api/v1/tokens/01a145d5-de24-7000-8ec3-000000000000" :method "delete"}]})]
      (is (= 404 (:status resp))))
    (fix/assert-status 200 (api-call admin-request {:method :patch :path (str "/api/v1/documents/" doc)
                                                    :body {:name "d1 renamed"}}))
    (is (= [[tokl doc 0]] (punct-count)))))
