(ns plaid.sql.query.exec-regex-test
  "Integration tests for regex value matching ({value {regex .. flags ..}}),
  backed by the REGEXP UDF registered per query connection. :value is matched
  against the JSON-decoded scalar so anchors work."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]
            [plaid.query.ast :as ast]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))

(defn- values
  "Run a query returning ?s spans, then read each span's value (the set of
  matched lemma strings)."
  [where]
  (let [r (qe/run db "admin@example.com" {"find" ["?s"] "where" where})]
    (set (map (fn [[sid]] (:span/value (:body (h/get-span admin-request sid))))
              (:results r)))))

(defn- build!
  "A lemma span layer with values walking / walks / talked / ran / WALK."
  []
  (let [pid  (h/create-test-project admin-request "RxProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "lemma"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "a b c d e"))
        mk   (fn [b e v] (let [t (id (h/create-token admin-request tokl text b e))]
                           (h/create-span admin-request sl [t] v)))]
    (mk 0 1 "walking")
    (mk 2 3 "walks")
    (mk 4 5 "talked")
    (mk 6 7 "ran")
    (mk 8 9 "WALK")
    {:sl sl}))

(deftest regex-unanchored
  (build!)
  (testing "substring-style match finds both walk* forms"
    (is (= #{"walking" "walks"}
           (values [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" "walk"}}]])))))

(deftest regex-anchored
  (build!)
  (testing "anchors work because the regex runs on the decoded scalar, not the JSON"
    (is (= #{"walking"}
           (values [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" "^walking$"}}]])))
    (is (= #{"talked"}
           (values [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" "ed$"}}]])))))

(deftest regex-case-insensitive
  (build!)
  (testing "flags i folds case"
    (is (= #{"walking" "walks" "WALK"}
           (values [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" "walk" "flags" "i"}}]]))))
  (testing "without the flag, case matters"
    (is (= #{"WALK"}
           (values [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" "WALK"}}]])))))

(deftest regex-unicode-case-folding
  ;; The `i` flag compiles to `(?iu)`, so case folding is Unicode-aware, not
  ;; ASCII-only. Under a bare `(?i)` the first assertion would fail.
  (let [pid  (h/create-test-project admin-request "RxUni")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "lemma"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "a"))
        t0   (id (h/create-token admin-request tokl text 0 1))]
    (h/create-span admin-request sl [t0] "ЦИЯ")  ; uppercase Cyrillic
    (testing "flags i folds case for non-ASCII letters"
      (is (= #{"ЦИЯ"}
             (values [["span" "?s" {"layer" "RxUni/lemma" "value" {"regex" "ция$" "flags" "i"}}]]))))
    (testing "without the flag, non-ASCII case still matters"
      (is (= #{}
             (values [["span" "?s" {"layer" "RxUni/lemma" "value" {"regex" "ция$"}}]]))))))

(deftest regex-composes-with-not
  (build!)
  (testing "spans NOT matching walk.* — same span correlated, regex negated"
    (is (= #{"talked" "ran"}
           (values [["span" "?s" {"layer" "RxProj/lemma"}]
                    ["not" ["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" "walk" "flags" "i"}}]]])))))

(deftest regex-redos-is-aborted
  (let [pid  (h/create-test-project admin-request "RxDos")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "w"))
        sl   (id (h/create-span-layer admin-request tokl "lemma"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "x"))
        t0   (id (h/create-token admin-request tokl text 0 1))]
    (h/create-span admin-request sl [t0] (apply str (repeat 32 "a")))
    (testing "a catastrophic-backtracking pattern is aborted by the watchdog, not hung"
      ;; (.*a){28} over 32 a's runs ~6.7s unbounded in pure Java, which SQLite's
      ;; interrupt can't reach — interruptible-cs + worker interrupt must. (A
      ;; trivial "(a+)+b" is optimized away by the JDK, so use this measured one.)
      (binding [qe/*query-timeout-ms* 1000]
        (let [start (System/nanoTime)
              code (try (qe/run db "admin@example.com"
                                {"find" ["?s"]
                                 "where" [["span" "?s" {"layer" "RxDos/lemma" "value" {"regex" "(.*a){28}"}}]]})
                        nil
                        (catch clojure.lang.ExceptionInfo e (:code (ex-data e))))
              ms   (/ (- (System/nanoTime) start) 1e6)]
          (is (= 408 code) "must abort with a 408 timeout")
          (is (< ms 20000) (str "must not hang past the limit (took " (long ms) "ms)")))))))

(deftest regex-validation
  (testing "an invalid pattern is a 400 at validation time"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"invalid regex"
         (ast/expand {"find" ["?s"]
                      "where" [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" "(unclosed"}}]]}))))
  (testing "regex on a non-text key is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"does not support a regex"
         (ast/expand {"find" ["?t"]
                      "where" [["token" "?t" {"layer" "RxProj/words" "begin" {"regex" "1"}}]]}))))
  (testing "unsupported flags are a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"flags .* unsupported"
         (ast/expand {"find" ["?s"]
                      "where" [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" "x" "flags" "g"}}]]})))))
