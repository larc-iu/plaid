;; Which patterns name a combining mark, so the server's REGEXP also
;; matches them decomposed (REV7-CORE-4). Both tables are canonical_cases.json,
;; which plaid-agent's tests/test_canonical_match.py and plaid-ui's
;; javaRegex.test.js read too.
(ns plaid.util.names-mark-test
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is]]
            [plaid.util.canonical :as canonical]))

(def ^:private canonical-cases
  (json/read-str (slurp (io/file "src/test/plaid/util/canonical_cases.json"))))

(def ^:private cases (get canonical-cases "namesMark"))

(deftest names-mark-reads-a-pattern-as-the-clients-do
  (doseq [[pattern named] cases]
    (is (= named (canonical/names-mark? pattern)) pattern)))

;; How a pattern naming a mark is matched against a value in NFD
;; (REV8-CORE-1).
(def ^:private decomposed-cases (get canonical-cases "decomposed"))

(deftest decompose-pattern-keeps-class-letters
  (doseq [[pattern want] decomposed-cases]
    (is (= want (canonical/decompose-pattern pattern)) pattern)))
