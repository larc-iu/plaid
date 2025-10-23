(ns plaid.algos.token
  (:require [clojure.string :as cstr]
            [taoensso.timbre :as log]))

(def whitespace-regexp #"\s|\n")
(defn whitespace? [s]
  (boolean (re-matches whitespace-regexp s)))

(defn whitespace-tokenize [text]
  (loop [offsets []
         open nil
         i 0
         head (subs text 0 1)
         tail (subs text 1)]
    (if (nil? head)
      (if (some? open)
        (conj offsets [open i])
        offsets)
      (let [new-head (if (= i (dec (count text))) nil (subs tail 0 1))
            new-tail (if (= 0 (count tail)) nil (subs tail 1))]
        (cond
          (and (whitespace? head) (some? open))
          (recur (conj offsets [open i]) nil (inc i) new-head new-tail)

          (and (not (whitespace? head)) (nil? open))
          (recur offsets i (inc i) new-head new-tail)

          :else
          (recur offsets open (inc i) new-head new-tail))))))

(defn unicode-category [c]
  (when (= (type c) Character)
    (let [code (Character/getType ^Character c)]
      (condp = code
        ;; L, Letter
        Character/UPPERCASE_LETTER "Lu"
        Character/LOWERCASE_LETTER "Ll"
        Character/TITLECASE_LETTER "Lt"
        Character/MODIFIER_LETTER "Lm"
        Character/OTHER_LETTER "Lo"

        ;; M, Mark
        Character/NON_SPACING_MARK "Mn"
        Character/COMBINING_SPACING_MARK "Mc"
        Character/ENCLOSING_MARK "Me"

        ;; N, Number
        Character/DECIMAL_DIGIT_NUMBER "Nd"
        Character/LETTER_NUMBER "Nl"
        Character/OTHER_NUMBER "No"

        ;; P, Punctuation
        Character/CONNECTOR_PUNCTUATION "Pc"
        Character/DASH_PUNCTUATION "Pd"
        Character/START_PUNCTUATION "Ps"
        Character/END_PUNCTUATION "Pe"
        Character/INITIAL_QUOTE_PUNCTUATION "Pi"
        Character/FINAL_QUOTE_PUNCTUATION "Pf"
        Character/OTHER_PUNCTUATION "Po"

        ;; S, Symbol
        Character/MATH_SYMBOL "Sm"
        Character/CURRENCY_SYMBOL "Sc"
        Character/MODIFIER_SYMBOL "Sk"
        Character/OTHER_SYMBOL "So"

        ;; Z, Separator
        Character/SPACE_SEPARATOR "Zs"
        Character/LINE_SEPARATOR "Zl"
        Character/PARAGRAPH_SEPARATOR "Zp"

        ;; C, Other
        Character/CONTROL "Cc"
        Character/FORMAT "Cf"
        Character/SURROGATE "Cs"
        Character/PRIVATE_USE "Co"
        Character/UNASSIGNED "Cn"
        nil))))

(defn- get-coverage-index [max-offset offsets]
  (reduce (fn [m [begin end]]
            (merge m (into {} (map (fn [i] [i true]) (range begin end)))))
          (into {} (map (fn [i] [i false]) (range max-offset)))
          offsets))

(defn- morpheme-tokenize-helper [body existing-token-offsets separator]
  (let [separator (if (char? separator) separator (char separator))
        getcat (memoize unicode-category)
        separator? (fn [c] (= c separator))
        boundary? (fn [c] (#{\C \S \P \N} (first (getcat c))))
        space? (fn [c] (#{\Z} (first (getcat c))))
        token-char? (fn [c] (not (or (space? c) (boundary? c) (separator? c))))
        index (get-coverage-index (count body) existing-token-offsets)
        covered? (fn [[b e]] (some #(index %) (range b e)))]
    (loop [chars (seq body)
           output-chars []
           offsets []
           i 0
           ops []]
      (cond
        ;; Base case
        (not (seq chars))
        {:new-body (cstr/join output-chars)
         :offsets  offsets
         :ops      ops}

        ;; Take while there are separator chars that are covered
        (and (separator? (first chars)) (covered? [i (inc i)]))
        (let [chunk (loop [output []
                           j i
                           [head :as chars] chars]
                      (if (and (some? head) (separator? head) (index j))
                        (recur (conj output head)
                               (inc j)
                               (rest chars))
                        output))]
          (recur (drop (count chunk) chars)
                 (into output-chars chunk)
                 offsets
                 (+ i (count chunk))
                 ops))

        ;; If we encounter an uncovered double sep, treat it as a literal, eating only one copy, and tokenize it
        (and (separator? (first chars))
             (separator? (second chars))
             (not (covered? [i (+ i 2)])))
        (recur (drop 2 chars)
               (conj output-chars separator)
               (conj offsets [(count output-chars) (inc (count output-chars))])
               (+ i 2)
               (conj ops {:type :delete :index (count output-chars) :value 1}))

        ;; If we encounter a legitimate sep, skip ahead without eating
        (separator? (first chars))
        (recur (drop 1 chars)
               output-chars
               offsets
               (inc i)
               (conj ops {:type :delete :index (count output-chars) :value 1}))

        ;; At least 1 space--eat them but don't tokenize them
        (space? (first chars))
        (let [chunk (take-while space? chars)]
          (recur
            (drop-while space? chars)
            (into output-chars chunk)
            offsets
            (+ i (count chunk))
            ops))

        ;; Skip newlines always
        (= \newline (first chars))
        (recur (drop 1 chars)
               (conj output-chars (first chars))
               offsets
               (inc i)
               ops)

        ;; If we peek a clear non-boundary, eat em all up while they last
        (token-char? (first chars))
        (let [token (take-while token-char? chars)
              new-chars (into output-chars token)
              span [(count output-chars) (count new-chars)]]
          (recur
            (drop-while token-char? chars)
            new-chars
            (if (covered? [i (+ i (count token))])
              offsets
              (conj offsets span))
            (+ i (count token))
            ops))

        ;; We have at least one boundary char in the mix--definitely take the first char, and
        ;; take the rest as long as it's token-chars, producing a token
        (boundary? (first chars))
        (let [token (concat [(first chars)] (take-while token-char? (rest chars)))
              new-chars (into output-chars token)
              span [(count output-chars) (count new-chars)]]
          (recur
            (drop (count token) chars)
            new-chars
            (if (covered? [i (+ i (count token))])
              offsets
              (conj offsets span))
            (+ i (count token))
            ops))

        :else
        (throw (ex-info "Unexpected case!" {:chars        chars
                                            :output-chars output-chars
                                            :offsets      offsets
                                            :i            i
                                            :code         500}))))))

(defn filter-overlaps
  "Only works if no text edits have been made"
  [existing proposed]
  (let [all (concat existing proposed)
        max-offset (if (seq all) (apply max (map second all)) 0)
        coverage-index (get-coverage-index max-offset existing)]
    (filter (fn [[begin end]]
              (every? #(not (coverage-index %)) (range begin end)))
            proposed)))

(defn morpheme-tokenize
  "Given:
   - body: a string of text
   - existing-token-offsets: any existing tokens (provided as 2-vectors of begin and end index)
   - separator: a morpheme separator
  perform a heuristic tokenization that tries to tokenize morphemes by using punctuation, space,
  and morpheme separators as hints. To literally include the separator, include it twice.

  Returns a map with 3 keys:
   - new-body: the new string value of the text's body
   - offsets: the offsets of new tokens that should be created
   - ops: the text edit operations (see plaid.algos.text) that describe how to handle separator sequences appropriately.
          You should probably use these with txt/update-body**--see plaid.xtdb.token-layer/morpheme-tokenize

  Example:

  (morpheme-tokenize \"John-'s two--hundred dogs\" [] \"-\")
  => {:new-body \"John's saved two-hundred dogs\"
      :offsets [[0 4] [4 6] [7 10] [10 12] [13 16] [16 17] [17 24] [25 28] [28 29]]]
      :ops ...}

  (let [{:keys [offsets]} (morpheme-tokenize \"John-'s sav-ed two--hundred dog-s\" [] \\-)
    (doseq [[begin end] offsets]
      (println (subs body begin end))))
  =>
  John
  's
  sav
  ed
  two
  -
  hundred
  dog
  s
  "
  [body existing-token-offsets separator]
  (let [output (morpheme-tokenize-helper body existing-token-offsets separator)]
    output))

(comment

  (require '[plaid.algos.text :refer :all])

  (let [text "John-'s sav-ed two--hundred dogs"
        existing []
        {:keys [ops]} (morpheme-tokenize text existing \-)]
    (plaid.algos.text/apply-text-edits ops text []))
  )
