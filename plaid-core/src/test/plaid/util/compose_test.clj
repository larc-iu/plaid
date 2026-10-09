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

(deftest a-token-of-a-lone-mark-is-left-zero-width-only-with-no-cuts
  (let [{:keys [at]} (canonical/compose "ta\u0301")]
    ;; with no token edges known, the edge between a and its mark goes after á
    (is (= [0 2] [(at 0) (at 2)]))
    (is (= [2 2] [(at 2) (at 3)]))))

(defn- positions-cut [s cuts]
  (let [{:keys [at]} (canonical/compose s cuts)] (mapv at (range (inc (cps s))))))

(deftest a-token-edge-inside-a-character-keeps-it-decomposed
  (testing "morphemes ta [0 2] and the tone [2 3]: each keeps its own letters"
    (let [{:keys [text at]} (canonical/compose "ta\u0301" #{0 2 3})]
      (is (= "ta\u0301" text))
      (is (= [0 2 3] (mapv at [0 2 3])))))
  (testing "only the character the edge falls in stays decomposed"
    (let [s "ba\u0301 ka\u0301 e\u0301"
          cuts #{0 3 4 6 7 8 10}
          {:keys [text]} (canonical/compose s cuts)]
      (is (= "bá ka\u0301 é" text))
      (is (= [0 1 2 2 3 4 5 6 7 8 8] (positions-cut s cuts)))))
  (testing "an edge between e and its dot, and the acute after"
    (is (= "e\u0323\u0301" (:text (canonical/compose "e\u0323\u0301" #{1}))))
    ;; between the dot and the acute the halves compose apart: all composed
    (is (= "\u1EB9\u0301" (:text (canonical/compose "e\u0323\u0301" #{2})))))
  (testing "Hangul jamo: the final as a morpheme of its own"
    (let [s "\u1100\u1161\u11A8"
          {:keys [text at]} (canonical/compose s #{0 2 3})]
      (is (= "\uAC00\u11A8" text))
      (is (= [0 1 2] (mapv at [0 2 3])))))
  (testing "a cut where composing changes nothing composes as without it"
    (is (= (positions "pʰa\u0301 ba\u0301") (positions-cut "pʰa\u0301 ba\u0301" #{0 4 5 8})))
    (is (= "pʰá bá" (:text (canonical/compose "pʰa\u0301 ba\u0301" #{0 4 5 8})))))
  (testing "a body kept decomposed is composed no further with its edges moved"
    (let [s "xka\u0301\u0323y"
          cuts #{1 3 5}
          {:keys [text at]} (canonical/compose s cuts)]
      (is (= text (:text (canonical/compose text (set (map at cuts))))))))
  (testing "a composed text is itself whatever the cuts"
    (let [s "pʰá b"]
      (is (identical? s (:text (canonical/compose s #{1 2 3})))))))

(deftest nfc-but-keeps-what-the-stored-body-keeps
  (is (= "ká mi" (canonical/nfc-but "ka\u0301 mi" "ká")))
  (is (= "ka\u0301 mé" (canonical/nfc-but "ka\u0301 me\u0301" "ka\u0301 me")))
  (is (= "ká" (canonical/nfc-but "ka\u0301" nil))))

(deftest marks-reorder-inside-their-piece
  ;; dot below (ccc 220) after acute (230) is reordered and composes
  (let [s "a\u0301\u0323 x"]
    (is (= (nfc s) (:text (canonical/compose s))))
    (is (= [0 2 2 2 3 4] (positions s)))))

(deftest a-mark-that-does-not-compose-stays-out-of-the-letter-before
  ;; ẹ́ typed e, dot below, acute: e and the dot compose to ẹ, and the acute
  ;; has no composed letter with it. A tone morpheme [2 3] keeps the acute,
  ;; and the edge between e and its dot goes after ẹ.
  (let [s "e\u0323\u0301"]
    (is (= "\u1EB9\u0301" (:text (canonical/compose s))))
    (is (= [0 1 1 2] (positions s))))
  (let [s "a\u0301\u0331"]
    (is (= "\u00E1\u0331" (:text (canonical/compose s))))
    (is (= [0 1 1 2] (positions s)))))

(def ^:private alphabet
  ["a" "e" "o" " " "\u0301" "\u0300" "\u0323" "\u0308" "\u1112" "\u1161" "\u11AB" "க" "\u0BCD"
   "\u0BC6" "\u0BBE" "\u212B" "\u0331" "\u0344" "\u1EB9" "\uD801\uDC00" "\uD834\uDD5F" "क" "\u093C" "न" "\u3099" "か" "\n"])

(deftest random-texts-compose-with-an-order-keeping-map
  (let [rnd (java.util.Random. 20261009)]
    (dotimes [_ 3000]
      (let [s (apply str (repeatedly (.nextInt rnd 12) #(alphabet (.nextInt rnd (count alphabet)))))
            {:keys [text at]} (canonical/compose s)
            ps (mapv at (range (inc (cps s))))]
        (is (= (nfc s) text) (pr-str s))
        (is (= 0 (first ps)) (pr-str s))
        (is (= (cps text) (peek ps)) (pr-str s))
        (is (apply <= ps) (pr-str s))
        ;; a place where the text can be cut, its halves composing apart to
        ;; the whole, goes to the end of its composed first half
        (let [cs (.toArray (.codePoints ^String s))
              sub (fn [a b] (String. cs (int a) (int (- b a))))]
          (doseq [p (range 1 (alength cs))
                  :let [pre (nfc (sub 0 p))]
                  :when (= text (str pre (nfc (sub p (alength cs)))))]
            (is (= (cps pre) (ps p)) (pr-str s p))))))))

(deftest random-texts-and-cuts-keep-every-token-its-own-letters
  (let [rnd (java.util.Random. 20261010)]
    (dotimes [_ 3000]
      (let [s (apply str (repeatedly (.nextInt rnd 12) #(alphabet (.nextInt rnd (count alphabet)))))
            n (cps s)
            cuts (into (sorted-set) (repeatedly (.nextInt rnd 5) #(.nextInt rnd (inc n))))
            {:keys [text at]} (canonical/compose s cuts)
            ps (mapv at (range (inc n)))
            cs (.toArray (.codePoints ^String s))
            sub (fn [^String x a b] (let [xs (.toArray (.codePoints x))] (String. xs (int a) (int (- b a)))))]
        (is (= (nfc s) (nfc text)) (pr-str s cuts))
        (is (apply <= ps) (pr-str s cuts))
        (is (= (cps text) (peek ps)) (pr-str s cuts))
        ;; between two cuts, the same text as before, never none
        (doseq [[a b] (partition 2 1 (concat [0] cuts [n]))
                :when (< a b)]
          (is (< (at a) (at b)) (pr-str s cuts a b))
          (is (= (nfc (String. cs (int a) (int (- b a)))) (nfc (sub text (at a) (at b))))
              (pr-str s cuts a b)))
        ;; composing again with the cuts moved changes nothing
        (is (= text (:text (canonical/compose text (map at cuts)))) (pr-str s cuts))
        ;; with no cut inside a character composing changes, it is NFC
        (when (= text (:text (canonical/compose s nil)))
          (is (= (nfc s) text)))))))

(deftest the-clients-compose-as-the-core-does
  ;; made by this function, read by both clients' tests
  (doseq [{:strs [input cuts text at]} (json/read-str (slurp (io/file "../plaid-client-js/test/fixtures/compose.json")))]
    (is (= text (:text (canonical/compose input cuts))) (pr-str input cuts))
    (is (= at (positions-cut input cuts)) (pr-str input cuts))))

(deftest data-is-composed-keys-and-all-but-the-raw-keys
  (let [v {:name "ba\u0301" (keyword "gle\u0301") ["e\u0301" 1 nil] "k\u0301" {:password "a\u0301"}}
        out (canonical/compose-data v #(= :password %))]
    (is (= {:name "bá" :glé ["é" 1 nil] "ḱ" {:password "a\u0301"}} out))
    (let [m {:a "b" :c [1 "d"]}]
      (is (identical? m (canonical/compose-data m (constantly false)))))))
