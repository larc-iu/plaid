(ns plaid.util.name-order
  "The order of document names wherever core lists them in number order: a
  run of decimal digits counts as its number, so \"(2) x\" comes before
  \"(10) x\", \"2.\" before \"10.\" and \"Text 2\" before \"Text 10\".

  The same rule as plaid-agent's `plaid_agent.core.tools.name_key`, piece for
  piece, and in step with the apps' `compareNames` (plaid-ui
  domain/collation.js) on numbered names. Those two already differ on one mark
  against another (\"1_x\", \"1. One\") and on accented letters, which the apps
  order by the locale and this, like name_key, by code point.

  The rule. The name is put in NFC and lower case, then cut into pieces: a run
  of decimal digits (Unicode Nd, so ASCII, Arabic-Indic or full-width digits,
  never a circled or superscript one) or one other character. A digit run is
  its number and files after spaces and marks and before letters (and other
  numeric characters such as \"①\"), as the apps' collator files digits. Other
  characters go by code point within their kind. Names whose pieces compare
  equal (\"02\" and \"2\", \"Text\" and \"text\") fall back to the NFC names by
  code point. A blank name, or none, is the smallest. Nothing here can throw:
  one test decides a digit, the same one that cuts the run."
  (:require [plaid.util.canonical :as canonical])
  (:import (java.util Locale)))

(defn- digit? [cp] (Character/isDigit (int cp)))

(defn- kind
  "Where a character that is not a decimal digit files: 2 for a letter or
  another numeric character, 0 for anything else. A digit run is 1."
  [cp]
  (let [t (Character/getType (int cp))]
    (if (or (Character/isLetter (int cp))
            (= t Character/LETTER_NUMBER)
            (= t Character/OTHER_NUMBER))
      2
      0)))

(defn- pieces
  "The pieces of `s` as `[kind number code-point]`: a digit run is
  `[1 its-value -1]`, any other character `[kind 0 its-code-point]`."
  [^String s]
  (let [cps (.toArray (.codePoints s))
        n (alength cps)]
    (loop [i 0 out (transient [])]
      (if (>= i n)
        (persistent! out)
        (let [cp (aget cps i)]
          (if (digit? cp)
            (let [end (loop [j i] (if (and (< j n) (digit? (aget cps j))) (recur (inc j)) j))
                  ;; Character/digit is 0 to 9 for every Nd character
                  value (reduce (fn [^BigInteger acc j]
                                  (.add (.multiply acc BigInteger/TEN)
                                        (BigInteger/valueOf (max 0 (Character/digit (aget cps j) 10)))))
                                BigInteger/ZERO
                                (range i end))]
              (recur end (conj! out [1 value -1])))
            (recur (inc i) (conj! out [(kind cp) BigInteger/ZERO cp]))))))))

(defn- compare-piece [[ka va ca] [kb vb cb]]
  (let [c (compare ka kb)]
    (if (zero? c)
      (let [c (.compareTo ^BigInteger va ^BigInteger vb)]
        (if (zero? c) (compare ca cb) c))
      c)))

(defn- compare-seqs
  "Lexicographic over two vectors with `cmp`, a prefix first."
  [cmp xs ys]
  (let [nx (count xs) ny (count ys)]
    (loop [i 0]
      (cond
        (and (= i nx) (= i ny)) 0
        (= i nx) -1
        (= i ny) 1
        :else (let [c (cmp (nth xs i) (nth ys i))]
                (if (zero? c) (recur (inc i)) c))))))

(defn- code-points [^String s] (vec (.toArray (.codePoints s))))

(defn compare-names
  "A comparator of two document names (strings or nil) in number order, see
  the namespace. Zero only for the same name in NFC."
  [a b]
  (let [x (canonical/nfc (or a ""))
        y (canonical/nfc (or b ""))
        c (compare-seqs compare-piece
                        (pieces (.toLowerCase ^String x Locale/ROOT))
                        (pieces (.toLowerCase ^String y Locale/ROOT)))]
    (if (zero? c)
      (compare-seqs compare (code-points x) (code-points y))
      c)))
