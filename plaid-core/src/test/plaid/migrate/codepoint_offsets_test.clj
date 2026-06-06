(ns plaid.migrate.codepoint-offsets-test
  "Astral-text (code point >= U+10000) coverage for the code-point offset model:
  REST `:token/value` agrees with query `?t.value`, bounds are code-point based,
  and the UTF-16 -> code-point data migration converts legacy rows idempotently.

  Fixture string is \"😀 cat\": 😀 = U+1F600 is ONE code point but TWO UTF-16
  units, so the token \"cat\" is [2,5] in code points and would be [3,6] in
  UTF-16."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.common :as psc]
            [plaid.sql.text :as txt]
            [plaid.sql.query.exec :as qe]
            [plaid.migrate.codepoint-offsets :as cpm]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private admin-id "admin@example.com") ;; users.id doubles as the email
(defn- id [r] (-> r :body :id))
(defn- result-ids [r] (set (map (comp str first) (:results r))))

(defn- build-astral!
  "Project CpProj with token layer 'words' over the text \"😀 cat\"."
  []
  (let [pid  (h/create-test-project admin-request "CpProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "😀 cat"))]
    {:pid pid :txtl txtl :tokl tokl :doc doc :text text}))

(deftest rest-and-query-agree-on-astral-surface
  (let [{:keys [tokl text]} (build-astral!)
        tok (id (h/create-token admin-request tokl text 2 5))] ;; code-point offsets
    (testing "REST :token/value is the code-point surface"
      (is (= "cat" (-> (h/get-token admin-request tok) :body :token/value))))
    (testing "query {value \"cat\"} matches; a UTF-16-style mis-slice does not"
      (is (= #{(str tok)}
             (result-ids (qe/run db admin-id
                                 {"find" ["?t"]
                                  "where" [["token" "?t" {"layer" "CpProj/words" "value" "cat"}]]}))))
      (is (empty? (:results (qe/run db admin-id
                                    {"find" ["?t"]
                                     "where" [["token" "?t" {"layer" "CpProj/words" "value" "at"}]]})))))
    (testing "?t.value dot-path agrees with the REST surface"
      (is (= #{(str tok)}
             (result-ids (qe/run db admin-id
                                 {"find" ["?t"]
                                  "where" [["token" "?t" {"layer" "CpProj/words"}]
                                           ["=" "?t.value" "cat"]]})))))))

(deftest astral-bounds-are-code-point
  (let [{:keys [tokl text]} (build-astral!)]
    (testing "offsets within the code-point length (5) are accepted"
      (is (some? (id (h/create-token admin-request tokl text 0 5))))) ;; whole "😀 cat"
    (testing "end past the code-point length is a clean 400 (NOT the UTF-16 length 6)"
      (is (= 400 (:status (h/create-token admin-request tokl text 0 6)))))))

(deftest migration-converts-utf16-to-codepoints
  (let [{:keys [text tokl]} (build-astral!)
        tok (id (h/create-token admin-request tokl text 2 5))] ;; correct cp offsets
    ;; Simulate LEGACY data: rewrite the row to UTF-16 offsets (3,6), bypassing
    ;; the (now code-point) API validation.
    (psc/execute! db {:update :tokens :set {:begin 3 :end_ 6} :where [:= :id tok]})
    (testing "detect reports the astral text + its tokens as pending"
      (let [d (cpm/detect db)]
        (is (= 1 (:pending-texts d)))
        (is (= 1 (:pending-tokens d)))
        (is (some #(= (str text) (str (:id %))) (:astral-texts d)))))
    (testing "convert rewrites UTF-16 offsets back to code points; surface correct"
      (let [r (cpm/convert-text! db text admin-id)
            row (psc/fetch-by-id db :tokens tok)]
        (is (not (:skipped r)))
        (is (= [2 5] [(:begin row) (:end_ row)]))
        (is (= "cat" (-> (h/get-token admin-request tok) :body :token/value)))))
    (testing "idempotent: re-run is a skip and leaves offsets unchanged"
      (is (:skipped (cpm/convert-text! db text admin-id)))
      (let [row (psc/fetch-by-id db :tokens tok)]
        (is (= [2 5] [(:begin row) (:end_ row)]))))))

(deftest update-body-astral-roundtrip
  ;; The body-edit path diffs old->new and reindexes tokens. Offsets are code
  ;; points, but the diff core is UTF-16 — update-body converts at the boundary.
  (let [{:keys [tokl text]} (build-astral!)              ; body "😀 cat"
        tok (id (h/create-token admin-request tokl text 2 5))] ; "cat" cp [2,5]
    (testing "insert before the astral char: body exact, token shifts in code points, surface intact"
      (is (:success (txt/update-body db text "X😀 cat" admin-id)))
      (is (= "X😀 cat" (:body (psc/fetch-by-id db :texts text))))
      (is (= "cat" (-> (h/get-token admin-request tok) :body :token/value)))
      (let [row (psc/fetch-by-id db :tokens tok)]
        (is (= [3 6] [(:begin row) (:end_ row)]))))))

(deftest update-body-astral-to-astral-no-corruption
  ;; Regression: changing one astral char to another that shares a surrogate
  ;; half (😀 U+1F600 -> 😁 U+1F601, both high surrogate D83D) previously
  ;; corrupted the body through the diff path (dangling surrogate + dropped char).
  (let [pid  (h/create-test-project admin-request "CpProj2")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "hello😀world"))
        tok  (id (h/create-token admin-request tokl text 6 11))] ; "world" cp [6,11]
    (is (:success (txt/update-body db text "hello😁world" admin-id)))
    (is (= "hello😁world" (:body (psc/fetch-by-id db :texts text)))
        "body must reconstruct exactly, not corrupt")
    (is (= "world" (-> (h/get-token admin-request tok) :body :token/value)))
    (let [row (psc/fetch-by-id db :tokens tok)]
      (is (= [6 11] [(:begin row) (:end_ row)])))))

(deftest update-body-astral-interior-delete
  ;; End-to-end regression: deleting an INTERIOR astral char from a run that
  ;; shares a surrogate half must delete that char's token and shift the next
  ;; one — not leave a token pointing at the wrong char / collapsed to zero-width.
  (let [pid  (h/create-test-project admin-request "CpProj3")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "😀😁😂"))
        ta   (id (h/create-token admin-request tokl text 0 1))
        tb   (id (h/create-token admin-request tokl text 1 2))
        tc   (id (h/create-token admin-request tokl text 2 3))]
    (is (:success (txt/update-body db text "😀😂" admin-id)))
    (is (= "😀😂" (:body (psc/fetch-by-id db :texts text))) "body not corrupted")
    (is (nil? (psc/fetch-by-id db :tokens tb)) "middle char's token deleted")
    (let [ra (psc/fetch-by-id db :tokens ta)
          tc-row (psc/fetch-by-id db :tokens tc)]
      (is (= [0 1] [(:begin ra) (:end_ ra)]) "😀 token unchanged")
      (is (= [1 2] [(:begin tc-row) (:end_ tc-row)]) "😂 token shifted left one code point"))
    (is (= "😂" (-> (h/get-token admin-request tc) :body :token/value)))))

(deftest ensure-converted-sets-completion-sentinel
  ;; On a db with no pending astral text, the startup hook records the global
  ;; completion marker so future boots short-circuit the corpus scan.
  (cpm/ensure-converted! db)
  (is (seq (psc/q db {:select [:id] :from :data_migrations
                      :where [:= :id "codepoint-offsets:complete"]}))
      "completion sentinel recorded")
  ;; Idempotent: a second call fast-paths and must not throw.
  (is (nil? (cpm/ensure-converted! db))))

(deftest bmp-text-is-not-touched
  (let [pid  (h/create-test-project admin-request "BmpProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "aa bb"))
        tok  (id (h/create-token admin-request tokl text 0 2))]
    (is (false? (cpm/astral? "aa bb")))
    (is (not (some #(= (str text) (str %)) (cpm/astral-text-ids db))))
    (testing "run! over a BMP-only db converts nothing"
      (is (= 0 (:converted (cpm/run! db admin-id)))))
    (let [row (psc/fetch-by-id db :tokens tok)]
      (is (= [0 2] [(:begin row) (:end_ row)])))))
