(ns plaid.algos.text.chars
  "What the text rules read a code point as: whitespace, a line break,
  punctuation or a symbol (from the tables the apps read), a combining mark,
  a letter of a word, and what a project's ignored-tokens rule makes of it."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]))

(defn cps->str [cps]
  (let [sb (StringBuilder.)]
    (doseq [c cps] (.appendCodePoint sb (int c)))
    (.toString sb)))

(defn combining-mark?
  "A code point of Unicode category Mn, Mc or Me: a mark that belongs to the
  letter before it."
  [c]
  (let [t (Character/getType (int c))]
    (or (= t Character/NON_SPACING_MARK)
        (= t Character/COMBINING_SPACING_MARK)
        (= t Character/ENCLOSING_MARK))))

(defn word-letter?
  "Whether code point `c` is part of a word's text: a letter, a digit, a
  combining mark or one `letter-like` holds (a set or a predicate of code
  points, see `layer-roles`), not punctuation."
  [letter-like c]
  (or (Character/isLetterOrDigit (int c)) (combining-mark? c) (boolean (letter-like (int c)))))

(defn leading-marks
  "How many code points at the start of `s` are combining marks."
  [^String s]
  (let [cps (.toArray (.codePoints s))]
    (loop [i 0]
      (if (and (< i (alength cps)) (combining-mark? (aget cps i))) (recur (inc i)) i))))

(defn space?
  "Whether code point `c` separates words, as the apps' tokenizers take it
  (JavaScript's `\\s` and U+0085, NEL): Java's whitespace, and also the
  no-break spaces (U+00A0, U+2007, U+202F) and U+FEFF, which Java counts as
  letters, and NEL, a line break that neither Java nor JavaScript counts as
  whitespace (REV6-TEXT-3, REV8-CORE-4), but not the information separators
  (U+001C to U+001F), which only Java counts."
  [c]
  (let [c (int c)]
    (and (not (<= 0x1C c 0x1F))
         (or (Character/isWhitespace c) (Character/isSpaceChar c) (= c 0xFEFF) (= c 0x85)))))

(defn line-break?
  "Whether code point `c` ends a line."
  [c]
  (contains? #{0x0A 0x0D 0x85 0x2028 0x2029} (int c)))

;; Punctuation and symbols (Unicode P and S), pictographs and the built-in
;; tokenizer's break class, read from the table igt and plaid-client-py read
;; (`resources/punctuation_classes.txt`, written by plaid-igt's
;; `tools/punctuationClasses.mjs` with plaid-ui's `punctuationClasses.js`),
;; and the scripts written without spaces (`resources/spaceless_scripts.txt`,
;; plaid-igt's `tools/spacelessScripts.mjs`), never from Java's own Unicode
;; tables, which are a version behind igt's (Java 21 has Unicode 15, the
;; tables 16).
(def punct-classes
  "`{\"punct\" ranges \"picto\" ranges \"break\" ranges \"spaceless\" ranges}`,
  each an int array of inclusive `[first last]` code-point pairs in order."
  (into {}
        (for [file ["punctuation_classes.txt" "spaceless_scripts.txt"]
              line (with-open [r (io/reader (io/resource file) :encoding "UTF-8")] (vec (line-seq r)))
              :when (not (or (str/blank? line) (str/starts-with? line "#")))]
          (let [[k & ranges] (str/split (str/trim line) #" +")]
            [k (int-array (mapcat (fn [r]
                                    (let [[a b] (map #(Integer/parseInt % 16) (str/split r #"-"))]
                                      [a (or b a)]))
                                  ranges))]))))

(defn in-ranges?
  "Whether code point `c` lies in `ranges`, an int array of inclusive
  `[first last]` pairs in order."
  [^ints ranges c]
  (let [c (int c)]
    (loop [lo 0 hi (quot (alength ranges) 2)]
      (if (< lo hi)
        (let [m (quot (+ lo hi) 2)]
          (cond (< c (aget ranges (* 2 m))) (recur lo m)
                (> c (aget ranges (inc (* 2 m)))) (recur (inc m) hi)
                :else true))
        false))))

(defn punct?
  "Whether code point `c` is punctuation to the text rules: a character
  the ignore rule skips (plaid-ui `isIgnoredCharacter`), Unicode
  punctuation or a symbol, but not a pictograph, not U+2205, the zero
  morph, and not one `letter-like` holds, the code points the project's
  rule calls letters (see `ignored-rule`). Typed right after it,
  with no whitespace, text goes to the sentence after (see
  `typed-to-next?`), and a word token made only of it takes no text typed
  against it (see `apply-plain-gaps`)."
  [letter-like c]
  (let [c (int c)]
    (and (in-ranges? (punct-classes "punct") c)
         (not (in-ranges? (punct-classes "picto") c))
         (not= c 0x2205)
         (not (letter-like c)))))

(defn punct-only?
  "Whether token `t` over code points `o` is made only of punctuation (see
  `punct?`), `letter-like` read as letters."
  [^ints o letter-like {:token/keys [begin end]}]
  (let [ll (or letter-like #{})]
    (every? #(punct? ll (aget o %)) (range begin end))))

(defn- single-code-points
  "The code points of the entries of `xs` that are one code point long."
  [xs]
  (into #{} (keep (fn [x] (when (and (string? x) (= 1 (.codePointCount ^String x 0 (count x))))
                            (.codePointAt ^String x 0))))
        xs))

(defn ignored-rule
  "A token layer's ignored-tokens rule, read from its parsed `config` at
  `config.plaid.ignoredTokens` (the only reader of that key in core), as
  `{:letter-like :break? :ignored-word?}`:
  - `:letter-like`: the code points the rule calls letters, which are then
    no punctuation to the text rules (see `punct?`), as a set or a
    predicate of code points. Under the punctuation rule
    (`unicodePunctuation`) each exception of one code point, an exception
    longer than that matching nothing (plaid-igt `isLetterLike`). Under an
    explicit list (`blacklist`) every punctuation character but the entries
    of one code point, since the built-in tokenizer breaks a word only at
    those and reads the rest as letters (plaid-ui
    `shouldTokenizeCharacter`), so an empty list makes every one a letter.
    Under no rule, none.
  - `:break?`: whether a code point ends a word to the built-in tokenizer
    (plaid-ui `shouldTokenizeCharacter`): the break class less the
    letter-like characters under the punctuation rule, the entries of an
    explicit list, and the break class under no rule.
  - `:ignored-word?`: whether a word spelled with the given code points is
    one the rule ignores (plaid-ui `isTokenIgnored`): under the punctuation
    rule, all of it punctuation to the text rules (see `punct?`), and under
    an explicit list, an entry of it. Under no rule, none is."
  [config]
  (let [rule (get-in config ["plaid" "ignoredTokens"])
        type (when (map? rule) (get rule "type"))
        entries (fn [k] (when (sequential? (get rule k)) (get rule k)))
        break-class? (fn [c] (in-ranges? (punct-classes "break") c))]
    (case type
      "unicodePunctuation"
      (let [letter-like (single-code-points (entries "whitelist"))]
        {:letter-like letter-like
         :break? (fn [c] (and (break-class? c) (not (contains? letter-like (int c)))))
         :ignored-word? (fn [cps] (every? (partial punct? letter-like) cps))})
      "blacklist"
      (let [listed (single-code-points (entries "blacklist"))
            words (set (filter string? (entries "blacklist")))]
        {:letter-like (fn [c] (and (in-ranges? (punct-classes "punct") c) (not (contains? listed (int c)))))
         :break? (fn [c] (contains? listed (int c)))
         :ignored-word? (fn [cps] (contains? words (String. (int-array cps) 0 (count cps))))})
      {:letter-like #{}
       :break? break-class?
       :ignored-word? (constantly false)})))
