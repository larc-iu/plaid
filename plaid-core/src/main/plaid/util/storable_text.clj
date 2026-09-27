(ns plaid.util.storable-text
  "The one check for a string headed for a plain-text column: a text body, a
  name, a vocabulary form, a metadata key.

  Two things a Java string can hold do not survive such a column:
  - an unpaired surrogate. It is not a Unicode character, and the SQLite
    driver writes it as `?`, so what is read back is not what was sent.
  - U+0000. It is stored, but SQLite's string functions stop at it, so the
    query engine reads every token after it in a body as empty.

  Both are refused with a 400 rather than repaired, since only the sender
  knows what was meant.")

(defn problem
  "A description of the first thing in `s` a plain-text column cannot hold,
  with its code-point position, or nil when there is none."
  [^String s]
  (let [n (.length s)]
    (loop [i 0 cp 0]
      (when (< i n)
        (let [c (.charAt s i)]
          (cond
            (= c \u0000)
            (str "a NUL character (U+0000) at position " cp)

            (Character/isHighSurrogate c)
            (if (and (< (inc i) n) (Character/isLowSurrogate (.charAt s (inc i))))
              (recur (+ i 2) (inc cp))
              (format "an unpaired surrogate (U+%04X) at position %d" (int c) cp))

            (Character/isLowSurrogate c)
            (format "an unpaired surrogate (U+%04X) at position %d" (int c) cp)

            :else
            (recur (inc i) (inc cp))))))))

(defn assert-storable!
  "Throw a 400 when `s` is a string holding something a plain-text column
  cannot store (see `problem`). `what` names the value in the message, as in
  \"Text body\" or \"Name\". Anything that is not a string passes, so the
  caller's own type check keeps its message.

  Call it inside a `submit-operation!` body, so the refusal is projected to a
  structured response."
  [what s]
  (when (string? s)
    (when-let [p (problem s)]
      (throw (ex-info (str what " contains " p ", which cannot be stored.")
                      {:code 400})))))
