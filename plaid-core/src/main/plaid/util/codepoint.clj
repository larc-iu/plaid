(ns plaid.util.codepoint
  "Unicode **code-point** string measurement and slicing.

  Text offsets (`:token/begin` / `:token/end`) are canonically 0-based indices
  in Unicode code points (NOT UTF-16 code units, bytes, or grapheme clusters).
  Java/Clojure `count`/`subs`/`.length`/`charAt` all work in UTF-16 code units,
  which disagree with code points for astral characters (>= U+10000 — emoji and
  SMP scripts). This namespace is the single home for converting between the two
  so the JVM server slices/measures consistently with SQLite (`substr`/`length`
  count code points) and Python (`str` is code-point native).

  Convention enforced here: begin inclusive, end exclusive, begin <= end,
  zero-width (begin == end) allowed.")

(defn cp-count
  "Number of Unicode code points in `s` (not UTF-16 `.length`/`count`)."
  ^long [^String s]
  (.codePointCount s 0 (.length s)))

(defn cp->utf16
  "UTF-16 index in `s` of the code point at code-point index `cp-idx`.
  `cp-idx` in [0, (cp-count s)]; the upper bound maps to (.length s).
  Throws IndexOutOfBoundsException (like `subs`) when out of range."
  ^long [^String s ^long cp-idx]
  (.offsetByCodePoints s 0 cp-idx))

(defn cp-subs
  "Like `clojure.core/subs`, but `cp-begin`/`cp-end` are **code-point** indices.
  Two-arity slices to the end. Zero-width (cp-begin == cp-end) yields \"\"."
  (^String [^String s ^long cp-begin]
   (subs s (cp->utf16 s cp-begin)))
  (^String [^String s ^long cp-begin ^long cp-end]
   (subs s (cp->utf16 s cp-begin) (cp->utf16 s cp-end))))
