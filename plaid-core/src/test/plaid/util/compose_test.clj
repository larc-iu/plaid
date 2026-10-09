(ns plaid.util.compose-test
  "`canonical/compose`: a body composed with every position mapped, and
  `compose-data` over a request's data."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer :all]
            [plaid.util.canonical :as canonical])
  (:import [java.text Normalizer Normalizer$Form]))

(defn- nfc [s] (Normalizer/normalize s Normalizer$Form/NFC))
(defn- cps [^String s] (.codePointCount s 0 (.length s)))
(defn- positions [s] (let [{:keys [at]} (canonical/compose s)] (mapv at (range (inc (cps s))))))

(deftest a-composed-body-is-itself
  (let [s "pʰá b"
        {:keys [text at]} (canonical/compose s)]
    (is (identical? s text))
    (is (= 3 (at 3)))))

(deftest a-mark-composes-with-its-letter
  (let [s "pʰa\u0301 ba\u0301"]
    (is (= {:text "pʰá bá"} (select-keys (canonical/compose s) [:text])))
    ;; p ʰ a ◌\u0301 _ b a ◌\u0301 : the edge between a and its mark goes after á
    (is (= [0 1 2 3 3 4 5 6 6] (positions s)))))

(deftest astral-characters-count-as-one
  (let [s "\uD801\uDC00e\u0301\uD801\uDC01"]
    (is (= "\uD801\uDC00é\uD801\uDC01" (:text (canonical/compose s))))
    (is (= [0 1 2 2 3] (positions s)))))

(deftest hangul-jamo-compose-across-letters
  ;; \u1112 \u1161 \u11AB (L V T) are letters, not marks, and compose into 한
  (let [s "x\u1112\u1161\u11ABy"]
    (is (= "x한y" (:text (canonical/compose s))))
    (is (= [0 1 2 2 2 3] (positions s)))))

(deftest a-token-of-a-lone-mark-is-left-zero-width
  (let [{:keys [at]} (canonical/compose "ta\u0301")]
    ;; morphemes "ta" [0 2] and the tone [2 3]
    (is (= [0 2] [(at 0) (at 2)]))
    (is (= [2 2] [(at 2) (at 3)]))))

(deftest marks-reorder-inside-their-piece
  ;; dot below (ccc 220) after acute (230) is reordered and composes
  (let [s "a\u0301\u0323 x"]
    (is (= (nfc s) (:text (canonical/compose s))))
    (is (= [0 2 2 2 3 4] (positions s)))))

(def ^:private alphabet
  ["a" "e" "o" " " "\u0301" "\u0300" "\u0323" "\u0308" "\u1112" "\u1161" "\u11AB" "க" "\u0BCD"
   "\u0BC6" "\u0BBE" "\u212B" "\uD801\uDC00" "\uD834\uDD5F" "क" "\u093C" "न" "\u3099" "か" "\n"])

(deftest random-texts-compose-with-an-order-keeping-map
  (let [rnd (java.util.Random. 20261009)]
    (dotimes [_ 3000]
      (let [s (apply str (repeatedly (.nextInt rnd 12) #(alphabet (.nextInt rnd (count alphabet)))))
            {:keys [text at]} (canonical/compose s)
            ps (mapv at (range (inc (cps s))))]
        (is (= (nfc s) text) (pr-str s))
        (is (= 0 (first ps)) (pr-str s))
        (is (= (cps text) (peek ps)) (pr-str s))
        (is (apply <= ps) (pr-str s))))))

(deftest the-clients-compose-as-the-core-does
  ;; made by this function, read by both clients' tests
  (doseq [{:strs [input text at]} (json/read-str (slurp (io/file "../plaid-client-js/test/fixtures/compose.json")))]
    (is (= text (:text (canonical/compose input))) (pr-str input))
    (is (= at (positions input)) (pr-str input))))

(deftest data-is-composed-keys-and-all-but-the-raw-keys
  (let [v {:name "ba\u0301" (keyword "gle\u0301") ["e\u0301" 1 nil] "k\u0301" {:password "a\u0301"}}
        out (canonical/compose-data v #(= :password %))]
    (is (= {:name "bá" :glé ["é" 1 nil] "ḱ" {:password "a\u0301"}} out))
    (let [m {:a "b" :c [1 "d"]}]
      (is (identical? m (canonical/compose-data m (constantly false)))))))
