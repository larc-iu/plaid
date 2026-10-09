(ns plaid.sql.query.exec-literal-rules-test
  "How a query's literals compare, through the real executor: marks typed in
  another canonical order, list members, regex on stored arrays, the null
  literal, the doc slot, strings and numbers on typed columns, metadata keys
  typed decomposed."
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.common :as psc]
            [plaid.sql.query.exec :as qe]
            [plaid.util.canonical :as canonical]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))
(defn- ids [r] (set (map (comp str first) (:results r))))
(defn- run [q] (qe/run db "admin@example.com" q))
(defn- refusal
  "The message of the 400 `q` answers, or a failure when it answers rows."
  [q]
  (try (run q) (is false (str "expected a 400 for " (pr-str q)))
       (catch clojure.lang.ExceptionInfo e
         (is (= 400 (:code (ex-data e))) (ex-message e))
         (ex-message e))))

;; Arabic beh with fatha and shadda: NFC puts fatha (class 30) before shadda
;; (class 33), keyboards type shadda first. Thai vowel below (class 103)
;; before the tone mark (class 107) in NFC, typed tone first.
(def ^:private arab-nfc "\u0628\u064e\u0651")
(def ^:private arab-typed "\u0628\u0651\u064e")
(def ^:private thai-nfc "\u0e15\u0e38\u0e48\u0e19")
(def ^:private thai-typed "\u0e15\u0e48\u0e38\u0e19")

(defn- build!
  "Three words over `aa bb 3.0`, a span on each, two vocabulary entries,
  metadata on the spans. The second span's value, the second entry's form
  and a metadata value are written straight to the database in keyboard
  order, as a core before composing stored them."
  []
  (let [pid  (h/create-test-project admin-request "Lit")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "gloss"))
        doc  (h/create-test-document admin-request pid "Doc 1")
        text (id (h/create-text admin-request txtl doc "aa bb 3.0"))
        vl   (id (h/create-vocab-layer admin-request "Lex"))
        _    (h/link-vocab-to-project admin-request pid vl)
        t1   (id (h/create-token admin-request tokl text 0 2))
        t2   (id (h/create-token admin-request tokl text 3 5))
        t3   (id (h/create-token admin-request tokl text 6 9))
        s1   (id (h/create-span admin-request sl [t1] arab-nfc {"tags" ["caf\u00e9" "a/b"] "k" nil
                                                                "f\u00f3rm" thai-nfc}))
        s2   (id (h/create-span admin-request sl [t2] "legacy" {"f\u00f3rm" thai-nfc}))
        s3   (id (h/create-span admin-request sl [t3] "?PL"))
        v1   (id (h/create-vocab-item admin-request vl thai-nfc))
        v2   (id (h/create-vocab-item admin-request vl "placeholder"))
        v3   (id (h/create-vocab-item admin-request vl "3.0"))]
    (psc/execute! db {:update :spans :set {:value (json/write-str arab-typed)} :where [:= :id (str s2)]})
    (psc/execute! db {:update :vocab_items :set {:form thai-typed} :where [:= :id (str v2)]})
    (psc/execute! db {:update :entity_metadata :set {:value (json/write-str thai-typed)}
                      :where [:and [:= :entity_id (str s2)] [:= :key "f\u00f3rm"]]})
    {:pid pid :doc doc :tokl tokl :sl sl :t1 t1 :t2 t2 :t3 t3 :s1 s1 :s2 s2 :s3 s3 :v1 v1 :v2 v2 :v3 v3}))

(deftest only-spelling-sees-marks-that-reorder
  (is (not (canonical/only-spelling? arab-nfc)))
  (is (not (canonical/only-spelling? thai-nfc)))
  (is (not (canonical/only-spelling? arab-typed)))
  (is (canonical/only-spelling? "\u0628\u064e") "one mark has one order")
  (is (canonical/only-spelling? "\u0e15\u0e38\u0e19"))
  (is (canonical/only-spelling? "abc"))
  (is (canonical/only-spelling? "\u0915\u093e\u0930") "Devanagari vowel signs have class 0"))

(deftest a-literal-in-canonical-order-finds-the-row-typed-in-keyboard-order
  (let [{:keys [s1 s2 v1 v2]} (build!)
        both-s #{(str s1) (str s2)}
        both-v #{(str v1) (str v2)}]
    (doseq [lit [arab-nfc arab-typed]]
      (testing (str "span value " (pr-str lit))
        (is (= both-s (ids (run {"find" ["?s"] "where" [["span" "?s" {"value" lit}]]}))))
        (is (= both-s (ids (run {"find" ["?s"] "where" [["span" "?s" {"value" [lit "x"]}]]}))))
        (is (= both-s (ids (run {"find" ["?s"] "where" [["span" "?s"] ["=" "?s.value" lit]]}))))
        (is (= both-s (ids (run {"find" ["?s"] "where" [["span" "?s"] ["in" "?s.value" [lit]]]}))))
        (is (= #{} (ids (run {"find" ["?s"] "where" [["span" "?s" {"value" {"regex" "^x"}}]
                                                     ["!=" "?s.value" lit] ["=" "?s.value" lit]]}))))))
    (doseq [lit [thai-nfc thai-typed]]
      (testing (str "vocab form and metadata " (pr-str lit))
        (is (= both-v (ids (run {"find" ["?v"] "where" [["vocab" "?v" {"form" lit}]]}))))
        (is (= both-v (ids (run {"find" ["?v"] "where" [["vocab" "?v"] ["in" "?v.form" [lit]]]}))))
        (is (= both-s (ids (run {"find" ["?s"] "where" [["span" "?s" {"metadata" {"f\u00f3rm" lit}}]]}))))
        (is (= both-s (ids (run {"find" ["?s"] "where" [["span" "?s"] ["=" "?s.metadata.f\u00f3rm" lit]]}))))))
    (testing "bindings"
      (is (= both-s (ids (run {"find" ["?s"] "where" [["span" "?s" {"value" "?x"}]]
                               "bindings" {"?x" arab-nfc}})))))))

(deftest every-list-member-is-a-literal
  (let [{:keys [s1 s2 s3 v2 doc]} (build!)]
    (testing "a {literal} member is the literal"
      (is (= #{(str doc)} (ids (run {"find" ["?d"] "where" [["document" "?d" {"name" [{"literal" "Doc 1"}]}]]}))))
      (is (= #{(str s3)} (ids (run {"find" ["?s"] "where" [["span" "?s" {"value" [{"literal" "?PL"} "zz"]}]]}))))
      (is (= #{(str s3)} (ids (run {"find" ["?s"] "where" [["span" "?s"] ["in" "?s.value" [{"literal" "?PL"}]]]}))))
      (is (= #{(str s1)} (ids (run {"find" ["?s"] "where" [["span" "?s" {"metadata" {"k" [{"literal" nil}]}}]]})))))
    (testing "a regex member is a 400 naming one regex"
      (doseq [q [{"find" ["?v"] "where" [["vocab" "?v" {"form" [{"regex" "^p"}]}]]}
                 {"find" ["?s"] "where" [["span" "?s" {"value" [{"regex" "^leg"}]}]]}
                 {"find" ["?s"] "where" [["span" "?s" {"metadata" {"tags" [{"regex" "caf"}]}}]]}
                 {"find" ["?s"] "where" [["span" "?s" {"metadata" {"tags" {"literal" [{"regex" "caf"}]}}}]]}
                 {"find" ["?s"] "where" [["span" "?s"] ["in" "?s.value" [{"regex" "x"}]]]}
                 {"find" ["?d"] "where" [["document" "?d" {"name" [{"regex" "D"}]}]]}
                 {"find" ["?t"] "where" [["text" "?t" {"body" [{"regex" "x"}]}]]}]]
        (is (str/includes? (refusal q) "one regex"))))
    (testing "a nested list is a 400"
      (is (str/includes? (refusal {"find" ["?s"] "where" [["span" "?s" {"value" [["legacy"]]}]]})
                         "outer list")))
    (testing "another map is a 400"
      (is (str/includes? (refusal {"find" ["?s"] "where" [["span" "?s" {"value" [{"x" 1}]}]]})
                         "may only hold")))
    (testing "a null member: matched on a JSON value, refused elsewhere"
      (is (= #{(str s1)} (ids (run {"find" ["?s"] "where" [["span" "?s" {"metadata" {"k" [nil "zz"]}}]]}))))
      (refusal {"find" ["?v"] "where" [["vocab" "?v" {"form" [nil]}]]}))
    (is (some? v2))
    (is (some? s2))))

(deftest a-regex-reads-the-letters-of-a-stored-array
  (let [{:keys [s1]} (build!)]
    (is (= "[\"caf\u00e9\",\"a/b\"]"
           (:value (psc/q1 db {:select [:value] :from [:entity_metadata]
                               :where [:and [:= :entity_id (str s1)] [:= :key "tags"]]})))
        "stored with no escapes")
    (is (= #{(str s1)} (ids (run {"find" ["?s"] "where" [["span" "?s" {"metadata" {"tags" {"regex" "caf\u00e9"}}}]]}))))
    (is (= #{(str s1)} (ids (run {"find" ["?s"] "where" [["span" "?s" {"metadata" {"tags" {"regex" "cafe\u0301"}}}]]}))))
    (is (= #{(str s1)} (ids (run {"find" ["?s"] "where" [["span" "?s"] ["~" "?s.metadata.tags" "\"a/b\""]]}))))
    (is (= #{(str s1)} (ids (run {"find" ["?s"] "where" [["span" "?s"] ["~" "?s.metadata.tags" "caf\u00e9"]]}))))))

(deftest write-json-writes-characters-as-themselves
  (is (= "[\"caf\u00e9\",\"a/b\",\"\u2028\"]" (psc/write-json ["caf\u00e9" "a/b" "\u2028"])))
  (is (= "\"a\\u0000b\\n\"" (psc/write-json "a\u0000b\n")) "control characters keep their escapes")
  (is (= "\"x\\ud800y\uD801\uDC00\"" (psc/write-json (str "x" (char 0xD800) "y\uD801\uDC00")))
      "an unpaired surrogate is escaped, a pair is not")
  (is (= (str "x" (char 0xD800) "y") (json/read-str (psc/write-json (str "x" (char 0xD800) "y"))))))

(deftest a-literal-null-means-a-bare-null
  (let [{:keys [s1]} (build!)]
    (is (= #{(str s1)} (ids (run {"find" ["?s"] "where" [["span" "?s" {"metadata" {"k" nil}}]]}))))
    (is (= #{(str s1)} (ids (run {"find" ["?s"] "where" [["span" "?s" {"metadata" {"k" {"literal" nil}}}]]}))))
    (is (= #{(str s1)} (ids (run {"find" ["?s"] "where" [["span" "?s" {"metadata" {"k" {"literal" [nil]}}}]]}))))
    (testing "in a predicate, as a bare null, a 400"
      (refusal {"find" ["?s"] "where" [["span" "?s"] ["=" "?s.metadata.k" {"literal" nil}]]})
      (refusal {"find" ["?s"] "where" [["span" "?s"] ["=" "?s.metadata.k" nil]]}))))

(deftest the-doc-slot-takes-an-id-a-list-of-ids-or-a-value-variable
  (let [{:keys [doc s1 s2 s3]} (build!)
        all-s #{(str s1) (str s2) (str s3)}]
    (is (str/includes? (refusal {"find" ["?s" "?d"] "where" [["span" "?s" {"doc" "?d"}] ["document" "?d"]]})
                       "[\"=\", \"?dv\", \"?d\"]"))
    (is (str/includes? (refusal {"find" ["?s"] "where" [["span" "?s" {"doc" "Doc 1"}]]}) "name"))
    (refusal {"find" ["?s"] "where" [["span" "?s" {"doc" ["Doc 1"]}]]})
    (refusal {"find" ["?s"] "where" [["span" "?s" {"doc" 3}]]})
    (refusal {"find" ["?d"] "where" [["document" "?d" {"id" "Doc 1"}]]})
    (is (= all-s (ids (run {"find" ["?s"] "where" [["span" "?s" {"doc" (str doc)}]]}))))
    (is (= all-s (ids (run {"find" ["?s"] "where" [["span" "?s" {"doc" [(str doc)]}]]}))))
    (is (= #{(str doc)} (ids (run {"find" ["?d"] "where" [["document" "?d" {"id" (str doc)}]]}))))
    (is (= all-s (ids (run {"find" ["?s"] "where" [["span" "?s" {"doc" {"var" "?dv"}}]
                                                   ["document" "?d"] ["=" "?dv" "?d"]]}))))))

(deftest a-string-never-equals-a-number-on-a-typed-column
  (let [{:keys [tokl t1 t2 t3 v3]} (build!)
        tok (fn [& where] (ids (run {"find" ["?t"] "where" (into [["token" "?t" {"layer" tokl}]] where)})))
        all-t #{(str t1) (str t2) (str t3)}]
    (testing "begin, an integer column"
      (is (= #{(str t2)} (ids (run {"find" ["?t"] "where" [["token" "?t" {"begin" 3}]]}))))
      (is (= #{} (ids (run {"find" ["?t"] "where" [["token" "?t" {"begin" "3"}]]}))))
      (is (= #{(str t2)} (ids (run {"find" ["?t"] "where" [["token" "?t" {"begin" ["3" 3]}]]}))))
      (is (= #{} (tok ["=" "?t.begin" "3"])))
      (is (= all-t (tok ["!=" "?t.begin" "3"])))
      (is (= #{(str t2)} (tok ["=" "?t.begin" 3])))
      (is (= #{(str t2)} (tok ["=" "?t.begin" 3.0])))
      (is (= #{} (tok ["in" "?t.begin" ["3"]])))
      (is (= all-t (tok ["<" "?t.begin" "0"])) "a number sorts before any text, as on a JSON value"))
    (testing "form, a text column"
      (is (= #{(str v3)} (ids (run {"find" ["?v"] "where" [["vocab" "?v" {"form" "3.0"}]]}))))
      (is (= #{} (ids (run {"find" ["?v"] "where" [["vocab" "?v" {"form" 3.0}]]}))))
      (is (= #{} (ids (run {"find" ["?v"] "where" [["vocab" "?v"] ["=" "?v.form" 3.0]]}))))
      (is (= #{} (ids (run {"find" ["?v"] "where" [["vocab" "?v"] ["=" "?v.form" 3]]})))))
    (testing "two columns of different types"
      (is (= #{} (ids (run {"find" ["?t" "?v"] "where" [["token" "?t" {"layer" tokl}] ["vocab" "?v"]
                                                        ["=" "?t.begin" "?v.form"]]})))))
    (testing "a token's surface against a number"
      (is (= #{} (tok ["=" "?t.value" 3.0]))))))

(deftest a-metadata-key-typed-decomposed-finds-the-composed-key
  (let [{:keys [s1 s2]} (build!)]
    (is (= #{(str s1) (str s2)}
           (ids (run {"find" ["?s"] "where" [["span" "?s" {"metadata" {"fo\u0301rm" {"regex" "."}}}]]}))))
    (is (= #{(str s1) (str s2)}
           (ids (run {"find" ["?s"] "where" [["span" "?s"] ["=" "?s.metadata.fo\u0301rm" thai-nfc]]}))))))

(deftest a-null-return-is-the-default
  (let [{:keys [s1 s2 s3]} (build!)]
    (is (= #{(str s1) (str s2) (str s3)} (ids (run {"find" ["?s"] "where" [["span" "?s"]] "return" nil}))))))
