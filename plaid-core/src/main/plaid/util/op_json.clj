(ns plaid.util.op-json
  "A text edit op as JSON in the form core prints it in a refusal (each client
  names a refused op in its own plain JSON): the keys type, index, length,
  value and side first, in that order, then the others sorted by code point,
  and the keys of an object inside it sorted the same way. A number is printed as JavaScript prints the double
  nearest it (`1.0` and `1e3` as `1` and `1000`, `1e21` as `1e+21`), a string
  with only `\"`, `\\`, the control characters and a lone surrogate escaped,
  and no spaces."
  (:import [java.math BigDecimal MathContext RoundingMode]))

(def ^:private op-keys ["type" "index" "length" "value" "side"])

(defn- key-name ^String [k]
  (if (keyword? k) (subs (str k) 1) (str k)))

(defn- code-point-compare
  "Two strings compared code point by code point, as Python compares them
  (Java's own compareTo compares UTF-16 units)."
  [^String a ^String b]
  (let [x (.toArray (.codePoints a))
        y (.toArray (.codePoints b))
        n (min (alength x) (alength y))]
    (loop [i 0]
      (cond
        (== i n) (compare (alength x) (alength y))
        (== (aget x i) (aget y i)) (recur (inc i))
        :else (compare (aget x i) (aget y i))))))

(defn- by-code-point [ks]
  (sort code-point-compare ks))

(defn- js-number
  "`n` as JavaScript's Number::toString prints the double nearest it, `null`
  for one that is not finite."
  ^String [n]
  (let [d (double n)]
    (cond
      (or (Double/isNaN d) (Double/isInfinite d)) "null"
      (zero? d) "0"
      :else
      (let [a (Math/abs d)
            bd (.stripTrailingZeros (BigDecimal. (Double/toString a)))
            ;; Java prints two digits where one would do when two come
            ;; closer (Double.MIN_VALUE is 4.9E-324), JavaScript the one (5e-324)
            one (.stripTrailingZeros (.round (BigDecimal. a) (MathContext. 1 RoundingMode/HALF_EVEN)))
            bd (if (and (> (.precision bd) 1) (== (.doubleValue one) a)) one bd)
            digits (.toString (.unscaledValue bd))
            k (count digits)
            n (- k (.scale bd))
            zeros (fn [c] (apply str (repeat c \0)))
            body (cond
                   (<= k n 21) (str digits (zeros (- n k)))
                   (< 0 n 22) (str (subs digits 0 n) "." (subs digits n))
                   (< -6 n 1) (str "0." (zeros (- n)) digits)
                   :else (let [e (dec n)]
                           (str (subs digits 0 1)
                                (when (> k 1) (str "." (subs digits 1)))
                                "e" (if (neg? e) "-" "+") (Math/abs (long e)))))]
        (str (when (neg? d) "-") body)))))

(defn- js-string
  "`s` as JSON.stringify writes it."
  ^String [^String s]
  (let [sb (StringBuilder. "\"")
        n (.length s)]
    (loop [i 0]
      (when (< i n)
        (let [c (.charAt s i)
              ci (int c)]
          (cond
            (= c \") (.append sb "\\\"")
            (= c \\) (.append sb "\\\\")
            (= c \backspace) (.append sb "\\b")
            (= c \formfeed) (.append sb "\\f")
            (= c \newline) (.append sb "\\n")
            (= c \return) (.append sb "\\r")
            (= c \tab) (.append sb "\\t")
            (< ci 0x20) (.append sb (format "\\u%04x" ci))
            (and (Character/isHighSurrogate c) (< (inc i) n) (Character/isLowSurrogate (.charAt s (inc i))))
            (do (.append sb c) (.append sb (.charAt s (inc i))))
            (Character/isSurrogate c) (.append sb (format "\\u%04x" ci))
            :else (.append sb c))
          (recur (if (and (Character/isHighSurrogate c) (< (inc i) n) (Character/isLowSurrogate (.charAt s (inc i))))
                   (+ i 2)
                   (inc i))))))
    (.toString (.append sb "\""))))

(declare write)

(defn- write-map ^String [m ks]
  (let [by-name (into {} (map (fn [[k v]] [(key-name k) v])) m)]
    (str "{" (apply str (interpose "," (map #(str (js-string %) ":" (write (get by-name %))) ks))) "}")))

(defn- write
  ^String [v]
  (cond
    (nil? v) "null"
    (boolean? v) (str v)
    (number? v) (js-number v)
    (string? v) (js-string v)
    (keyword? v) (js-string (key-name v))
    (map? v) (write-map v (by-code-point (map key-name (keys v))))
    (sequential? v) (str "[" (apply str (interpose "," (map write v))) "]")
    :else (js-string (str v))))

(defn op-json
  "`op` (as parsed from a request) as JSON in the form core prints it."
  ^String [op]
  (if (map? op)
    (let [names (set (map key-name (keys op)))]
      (write-map op (concat (filter names op-keys)
                            (by-code-point (remove (set op-keys) names)))))
    (write op)))
