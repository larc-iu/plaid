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

(defn utf16->cp
  "Code-point index in `s` equivalent to UTF-16 index `u` — i.e. how many code
  points precede `u`. Inverse of [[cp->utf16]]. Used to reinterpret a stored
  UTF-16 offset as a code-point offset (see plaid.migrate.codepoint-offsets)."
  ^long [^String s ^long u]
  (.codePointCount s 0 u))

(defn cp-subs
  "Like `clojure.core/subs`, but `cp-begin`/`cp-end` are **code-point** indices.
  Two-arity slices to the end. Zero-width (cp-begin == cp-end) yields \"\"."
  (^String [^String s ^long cp-begin]
   (subs s (cp->utf16 s cp-begin)))
  (^String [^String s ^long cp-begin ^long cp-end]
   (subs s (cp->utf16 s cp-begin) (cp->utf16 s cp-end))))

(defn cp->utf16-index
  "Build a reusable code-point -> UTF-16 offset array for `s`: a length
  `(inc (cp-count s))` int-array where element k is the UTF-16 offset of the
  k-th code point (element (cp-count s) == (.length s)). Use when slicing many
  ranges off ONE body — `cp->utf16` is O(distance), so naive per-token slicing
  is O(n*k); precomputing the array makes the whole pass O(n)."
  ^ints [^String s]
  (let [len (.length s)
        cps (.codePointCount s 0 len)
        arr (int-array (inc cps))]
    (loop [u 0, c 0]
      (aset arr c u)
      (if (< u len)
        (recur (.offsetByCodePoints s u 1) (inc c))
        arr))))

(defn cp-slicer
  "Return a `(fn [cp-begin cp-end] substring)` that slices `s` by code-point
  indices in O(1) per call, after an O(n) prebuild. For slicing many tokens'
  surfaces out of a single text body (e.g. `get-tokens`)."
  [^String s]
  (let [idx (cp->utf16-index s)]
    (fn ^String [^long cp-begin ^long cp-end]
      (subs s (aget idx cp-begin) (aget idx cp-end)))))
