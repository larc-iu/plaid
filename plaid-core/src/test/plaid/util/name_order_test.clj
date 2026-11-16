(ns plaid.util.name-order-test
  "Document names in number order, as the apps list them (plaid-ui
  domain/collation.js `compareNames`) and the assistant reads them
  (plaid-agent `plaid_agent.core.tools.name_key`). The names are those of
  plaid-agent's tests/test_name_order.py, with a few more shapes."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.util.name-order :as no]))

(defn- sorted [names] (vec (sort no/compare-names names)))

;; The order name_key gives these names (plaid-agent, 2026-11-16). The apps
;; agree on all of them except one mark against another ("1_x" and "1. One")
;; and accented letters ("Éa", "étude"), which they order by the locale.
(def ^:private in-order
  ["" "(1) a" "(1) Intro" "(2) b" "(2) Pear" "(10) c" "(10) Frog story" "1. One" "1_x" "02" "2" "2. Two"
   "02_x" "2_x" "10. Ten" "10_x" "12" "apple" "Banana" "fable" "m³ notes" "Story ①" "Story ②" "STRASSE"
   "Straße" "Text" "text" "Text 1" "Text 2" "text 2" "Text ３" "Text 10" "Text １２" "Text²" "Zebra" "Éa"
   "étude" "קובץ 2" "קובץ 10" "نص ٢" "نص ١٠"])

(deftest the-table-in-name-key-order
  (is (= in-order (sorted (reverse in-order))))
  (is (= in-order (sorted (shuffle in-order)))))

(deftest numbered-prefixes-in-number-order
  (is (= ["(1) Intro" "(2) Pear" "(10) Frog story"] (sorted ["(10) Frog story" "(2) Pear" "(1) Intro"])))
  (is (= ["1. One" "2. Two" "10. Ten"] (sorted ["10. Ten" "2. Two" "1. One"])))
  (is (= ["Text 2" "text 3" "Text 10"] (sorted ["Text 10" "Text 2" "text 3"])))
  (is (= ["1_x" "02_x" "10_x"] (sorted ["10_x" "02_x" "1_x"]))))

(deftest ties-fall-to-the-names-and-a-blank-is-first
  (is (= ["02_x" "2_x"] (sorted ["2_x" "02_x"])))
  (is (= ["Text" "text"] (sorted ["text" "Text"])))
  (is (= ["" "A" "b"] (sorted ["b" "" "A"])))
  (is (zero? (no/compare-names nil "")))
  (is (= [nil "(1) a"] (sorted ["(1) a" nil])))
  (testing "only the same name compares equal"
    (is (zero? (no/compare-names "Text 2" "Text 2")))
    (is (not (zero? (no/compare-names "02" "2"))))))

(deftest other-scripts-count-their-digits
  (is (= ["קובץ 2" "קובץ 10"] (sorted ["קובץ 10" "קובץ 2"])))
  (is (= ["نص ٢" "نص ١٠"] (sorted ["نص ١٠" "نص ٢"])))
  (is (= ["Text ３" "Text １２"] (sorted ["Text １２" "Text ３"]))))

(deftest no-name-throws
  (testing "circled and superscript digits are characters, not numbers (REV-SF2-1)"
    (doseq [n ["Story ①" "⑩" "²" "¹²" "m³" "٣" "𝟙𝟚" "ↂ" "" "a😀b"
               (str "e" (char 0x301)) (str "x" (char 0xD800) "1")]]
      (is (integer? (no/compare-names n "Story 2")) n)))
  (testing "a run of digits longer than any number type"
    (let [big (apply str (repeat 5000 "9"))]
      (is (= ["8" big (str big "9")] (sorted [(str big "9") big "8"]))))))
