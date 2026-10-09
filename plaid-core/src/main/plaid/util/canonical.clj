(ns plaid.util.canonical
  "Canonical equivalence (Unicode NFC) for the query language: text that is
  canonically equivalent, such as `pʰá` typed composed and stored decomposed
  (a + U+0301), is the same text to a search, an equality as much as a regular
  expression."
  (:import [java.text Normalizer Normalizer$Form]
           [java.util BitSet]))

(defn nfc
  "`s` in Unicode NFC, without a copy when it already is."
  ^String [^String s]
  (if (Normalizer/isNormalized s Normalizer$Form/NFC)
    s
    (Normalizer/normalize s Normalizer$Form/NFC)))

(def ^:private ^BitSet not-alone
  "Code points that let a text have another, canonically equivalent spelling:
  every code point after the first in a canonical decomposition (a combining
  mark, a Hangul vowel or final, a vowel sign that composes), and the one a
  singleton decomposes to (KELVIN SIGN to K, a CJK compatibility ideograph to
  its unified one). Built once, on first use."
  (delay
    (let [bits (BitSet. 0x110000)]
      (doseq [cp (range 0x110000)
              :when (and (Character/isDefined (int cp))
                         (not (<= 0xD800 cp 0xDFFF)))
              :let [s (String. (Character/toChars cp))]
              :when (not (Normalizer/isNormalized s Normalizer$Form/NFD))
              :let [d (.toArray (.codePoints (Normalizer/normalize s Normalizer$Form/NFD)))]]
        (if (= 1 (alength d))
          (.set bits (aget d 0))
          (doseq [i (range 1 (alength d))] (.set bits (aget d i)))))
      bits)))

(defn only-spelling?
  "Whether `s` is the only spelling of its text: no other string is
  canonically equivalent to it, so an equality with it can compare the stored
  text exactly (and use an index). True of almost every ASCII text and of most
  text in scripts without combining marks."
  [^String s]
  (and (Normalizer/isNormalized s Normalizer$Form/NFD)
       (let [^BitSet bits @not-alone]
         (not (.anyMatch (.codePoints s) (reify java.util.function.IntPredicate
                                           (test [_ cp] (.get bits cp))))))))
