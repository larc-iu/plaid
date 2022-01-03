(ns glam.algos.token
  (:require [clojure.string :as cstr]
            #?(:cljs ["unicode-properties" :refer [getCategory]])))

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

#?(:clj
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
   :cljs
   (defn unicode-category [c]
     (if (int? c)
       (getCategory c)
       (getCategory (.charCodeAt c 0)))))

(defn- morpheme-tokenize-helper [body separator]
  (let [separator (if (char? separator) separator (char separator))
        getcat (memoize unicode-category)
        separator? (fn [c] (= c separator))
        boundary? (fn [c] (#{\C \S \P \N} (first (getcat c))))
        space? (fn [c] (#{\Z} (first (getcat c))))
        token-char? (fn [c] (not (or (space? c) (boundary? c) (separator? c))))]
    (loop [chars (seq body)
           output-chars []
           offsets []]
      (cond
        ;; Base case
        (not (seq chars))
        [(cstr/join output-chars) offsets]

        ;; If we encounter a double sep, treat it as a literal, eating only one copy, and tokenize it
        (and (separator? (first chars)) (separator? (second chars)))
        (recur (drop 2 chars)
               (conj output-chars separator)
               (conj offsets [(count output-chars) (inc (count output-chars))]))

        ;; If we encounter a legitimate sep, skip ahead without eating
        (separator? (first chars))
        (recur (drop 1 chars)
               output-chars
               offsets)

        ;; At least 1 space--eat them but don't tokenize them
        (space? (first chars))
        (recur
          (drop-while space? chars)
          (into output-chars (take-while space? chars))
          offsets)

        ;; If we peek a clear non-boundary, eat em all up while they last
        (token-char? (first chars))
        (let [token (take-while token-char? chars)
              new-chars (into output-chars token)]
          (recur
            (drop-while token-char? chars)
            new-chars
            (conj offsets [(count output-chars) (+ (count token) (count output-chars))])))

        ;; We have at least one boundary char in the mix--definitely take the first char, and
        ;; take the rest as long as it's token-chars, producing a token
        (boundary? (first chars))
        (let [token (concat [(first chars)] (take-while token-char? (rest chars)))
              new-chars (into output-chars token)]
          (recur
            (drop (count token) chars)
            new-chars
            (conj offsets [(count output-chars) (count new-chars)])))

        :else
        (throw (ex-info "Unexpected case!" {:chars        chars
                                            :output-chars output-chars
                                            :offsets      offsets}))))))

(defn filter-overlaps [existing proposed]
  (let [max-offset (apply max (map second (concat existing proposed)))
        coverage-index (reduce (fn [m [begin end]]
                                 (merge m (into {} (map (fn [i] [i true]) (range begin end)))))
                               (into {} (map (fn [i] [i false]) (range max-offset)))
                               existing)]
    (filter (fn [[begin end]]
              (every? #(not (coverage-index %)) (range begin end)))
            proposed)))

(defn morpheme-tokenize
  "Given:
   - body: a string of text
   - existing-token-offsets: any existing tokens (provided as 2-vectors of begin and end index)
   - separator: a morpheme separator
  perform a heuristic tokenization that tries to tokenize morphemes by using
  punctuation, space, and morpheme separators as hints. Returns a sequence of offset 2-vectors.
  To literally include the separator, include it twice.

  Example:

  (morpheme-tokenize \"John-'s two--hundred dogs\" [] \"-\")
  => [\"John's saved two-hundred dogs\" [[0 4] [4 6] [7 10] [10 12] [13 16] [16 17] [17 24] [25 28] [28 29]]]

  (let [[body offsets] (morpheme-tokenize \"John-'s sav-ed two--hundred dog-s\" [] \\-)
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
  (let [[body offsets] (morpheme-tokenize-helper body separator)]
    [body (filter-overlaps existing-token-offsets offsets)]))

(comment

  (morpheme-tokenize "John-'s sav-ed two--hundred dog-s" [[0 5]] \-)


  )
