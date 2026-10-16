;; Which patterns name a combining mark, so the server's REGEXP also
;; matches them decomposed (REV7-CORE-4). The same table as plaid-agent's
;; tests/test_canonical_match.py and plaid-ui's javaRegex.test.js.
(ns plaid.util.names-mark-test
  (:require [clojure.test :refer [deftest is]]
            [plaid.util.canonical :as canonical]))

(def ^:private cases
  [["\u0301" true]
   ["\\x{301}" true]
   ["\\u0301" true]
   ["\\x{0301}" true]
   ["[\u0301]" true]
   ["[\\x{300}-\\x{36f}]" true]
   ["[\u0300-\u036f]" true]
   ["\\p{M}" true]
   ["\\p{Mn}" true]
   ["a|\u0301" true]
   ["\\Q\u0301\\E" true]
   ["\\pM" true]
   ["\\p{IsMn}" true]
   ["\\p{gc=Mc}" true]
   ["\\p{InCombiningDiacriticalMarks}" true]
   ["\\p{Mark}" true]
   ["\\p{general_category=Nonspacing_Mark}" true]
   ["[\\p{Mn}\\p{Me}]" true]
   ["[a\\x{301}]" true]
   ["[\\p{M}]" true]
   ["[[\\p{M}]a]" true]
   ["\\x30\u0301" true]
   ["a" false]
   ["a." false]
   ["\\w" false]
   ["[a-z]" false]
   ["\\p{L}" false]
   ["\\P{M}" false]
   ["\\\\x{301}" false]
   ["\\x41" false]
   ["[\\x{2f0}-\\x{310}]" false]
   ["\\p{IsLatin}" false]
   ["[a-]" false]
   ["\\x{zz}" false]
   ["[^\\p{Me}]" false]
   ["\\x{110000}" false]
   ["\\x{1F600}" false]
   ["[\\p{L}\\p{M}]" false]
   ["\\b" false]
   ["\\W" false]
   ["a\\w" false]
   ["[^\\x{301}]" true]
   ["[\\x{2ff}-\\x{370}]" false]])

(deftest names-mark-reads-a-pattern-as-the-clients-do
  (doseq [[pattern named] cases]
    (is (= named (canonical/names-mark? pattern)) pattern)))
