(ns plaid.algos.text
  (:require [taoensso.timbre :as log]
            [editscript.core :as e]
            [plaid.util.codepoint :as cp]))

(comment
  (def x1 "hello world " #_"The ice-cream melted")
  (def x2 "hi world " #_"The ice cream meted!")

  ;; editscript format
  [7 [:r " "] 8 [:- 1] 3 [:+ "!"]]

  ;; fast-diff js format
  [0 "The ice"]
  [-1 "-"]
  [1 " "]
  [0 "cream me"]
  [-1 "l"]
  [0 "ted"]
  [1 "!"]

  (e/diff x1 x2 {:str-diff :character :str-change-limit 0.9999999})

  (editscript-diff x1 x2)

  (diff x1 x2)
  (let [ops (diff x1 x2)]
    (prn ops)
    (apply-text-edits ops {:text/body x1} [])))

(defn- editscript-diff
  "Use editscript to get a character-level diff and convert it into the same format used
  by the fast-diff javascript library, which `diff` below is expecting. (We originally used
  this library in glam.)"
  [old new]
  (let [[[_ _ ops]] (e/get-edits (e/diff old new {:algo :a-star
                                                  :str-diff :character
                                                  :str-change-limit 0.9999999}))]
    (if (string? ops)
      ;; Total replacement of the original string
      (vector [-1 old]
              [1 new])
      ;; Edit of the existing string
      (loop [head (first ops)
             tail (rest ops)
             ops []
             i 0]
        (cond
          (nil? head)
          ops

          (number? head)
          (recur (first tail)
                 (rest tail)
                 (conj ops [0 (subs old i (+ i head))])
                 (+ i head))

          ;; Replacement
          (= (first head) :r)
          (recur (first tail)
                 (rest tail)
                 (-> ops
                     (conj [-1 (subs old i (+ i (count (second head))))])
                     (conj [1 (second head)]))
                 (+ i (count (second head))))

          ;; Deletion
          (= (first head) :-)
          (recur (first tail)
                 (rest tail)
                 (conj ops [-1 (subs old i (+ i (second head)))])
                 (+ i (second head)))

          ;; Addition
          (= (first head) :+)
          (recur (first tail)
                 (rest tail)
                 (conj ops [1 (second head)])
                 i)

          :else
          (throw (ex-info "Unknown op!" {:op head :code 500})))))))

(defn valid-delete? [{:keys [type index value] :as op}]
  (and (map? op)
       (= :delete type)
       (int? index)
       (int? value)))

(defn valid-insert? [{:keys [type index value] :as op}]
  (and (map? op)
       (= :insert type)
       (int? index)
       (string? value)))

(defn valid-ops? [ops]
  (every? #(or (valid-delete? %)
               (valid-insert? %))
          ops))

(defn delete-op [index value]
  {:type  :delete
   :index index
   :value value})

(defn insert-op [index value]
  {:type  :insert
   :index index
   :value value})

(defn- surrogate? [cp] (<= 0xD800 (long cp) 0xDFFF))

(defn- codepoint-proxy
  "Build a per-call bijection between the Unicode code points present in `old`
  and `new` and single non-surrogate BMP proxy chars, then return the proxy
  encodings of both strings plus a `decode` fn (proxy substring -> real string).

  Why: `editscript` diffs Java *chars* (UTF-16 code units), so a char-level diff
  of astral text can cut INSIDE a surrogate pair — producing an edit op whose
  boundary falls mid-code-point. Diffing the proxy strings instead (one BMP char
  per code point) makes the diff CODE-POINT granular: op boundaries always land
  on code-point boundaries, so offsets/token shifts are correct and the body
  reconstructs exactly. Returns nil when there are more distinct code points than
  the BMP proxy pool can hold (caller falls back) — unreachable for real text."
  [^String old ^String new]
  (let [ocps (vec (.toArray (.codePoints old)))
        ncps (vec (.toArray (.codePoints new)))
        dcps (vec (distinct (concat ocps ncps)))
        n (count dcps)
        pool (->> (range 1 0x10000) (remove surrogate?) (take n) vec)]
    (when (= n (count pool))
      (let [pchars (mapv char pool)
            cp->px (zipmap dcps pchars)
            px->cp (zipmap pchars dcps)
            ->px (fn [cps] (apply str (map cp->px cps)))
            decode (fn [^String s]
                     (apply str (map #(String. (Character/toChars (int (px->cp %)))) s)))]
        {:old* (->px ocps) :new* (->px ncps) :decode decode}))))

(defn diff
  "Diff `old` -> `new` into a vector of insert/delete edit-ops. Op `:index` and
  the `:delete` `:value` count are **Unicode code-point** positions, matching the
  canonical token-offset unit; insert `:value` is the literal inserted string.
  Applying the ops to `old` reconstructs `new` exactly, including astral text.

  The diff is computed at code-point granularity (via `codepoint-proxy`) so an
  edit boundary never splits a surrogate pair — otherwise a char-level diff of
  e.g. an interior emoji deletion would mis-shift the surrounding tokens."
  [old new]
  (if-let [{:keys [old* new* decode]} (codepoint-proxy old new)]
    (let [results (editscript-diff old* new*)]
      (loop [head (first results)
             tail (rest results)
             ops []
             i 0]
        (let [code (if-not (nil? head) (first head))
              value (if-not (nil? head) (second head))]
          (cond
            (nil? head)
            ops

            ;; equality (value is a proxy substring; only its length matters)
            (= 0 code)
            (recur (first tail) (rest tail) ops (+ i (count value)))

            ;; insertion — decode the proxy value back to the real string
            (= 1 code)
            (recur (first tail) (rest tail)
                   (conj ops (insert-op i (decode value)))
                   (+ i (count value)))

            ;; deletion (count is in code points = proxy chars)
            (= -1 code)
            (recur (first tail) (rest tail)
                   (conj ops (delete-op i (count value)))
                   i)

            :else
            (throw (ex-info "Unknown diff op code" {:code 500 :op-code code}))))))
    ;; Fallback: more distinct code points than the proxy pool (not reachable
    ;; for real text) — whole-string replace. Correct, just not minimal.
    [(delete-op 0 (cp/cp-count old)) (insert-op 0 new)]))

;; i is a code-point index, v a code-point count / inserted string.
(defn- insert-str [s i v]
  (str (cp/cp-subs s 0 i) v (cp/cp-subs s i)))

(defn- delete-str [s i v]
  (str (cp/cp-subs s 0 i) (cp/cp-subs s (+ i v))))

(defn apply-text-edit
  "Given an operation, a text and tokens, shift :token/begin and :token/end on a list
  of tokens as appropriate. Operations are maps, with :type of either :delete or :insert,
  :index indicating the position in the string, and :value for the value being inserted
  or the number of tokens to be deleted.

  :index and the :delete :value count are **Unicode code-point** positions — the
  same unit as the :token/begin/:token/end of the `tokens` passed in, and as the
  ops produced by `diff`. (Slicing the body uses plaid.util.codepoint, so astral
  text shifts correctly.)

  Op examples:

    {:type :insert    {:type :delete
     :index 3          :index 4
     :value \"is \"}   :value 3}

  Returns a map:
   - :text contains the new text map
   - :tokens contains the modified tokens that still exist
   - :deleted contains the ids of tokens that were deleted because they had zero width

  Example return map:

    {:text {:text/body \"good dog\", ...}
     :tokens ({:token/begin 0, :token/end 4, ...}, {:token/begin 5, :token/end 8, ...})
     :deleted ()}
  "
  [{:keys [type index value] :as op} text tokens]
  (let [type (or (and (keyword? type) type)
                 (and (string? type) (keyword type))
                 type)]
    (if (not (or (and (or (= type :insert)) (int? index) (string? value))
                 (and (= type :delete) (int? index) (int? value))))
      (do
        (log/error "Malformed op:" op)
        tokens)
      (case type
        ;; three cases:
        ;; - token opens and closes before index (no changes)
        ;; - token opens before index but closes later (expand the token)
        ;; - token opens and closes after index (add offset to both indices)
        :insert
        (let [offset (cp/cp-count value)
              unaffected-tokens (filterv #(<= (:token/end %) index) tokens)
              affected-tokens (filterv #(> (:token/end %) index) tokens)]
          {:text (update text :text/body insert-str index value)
           :tokens (into unaffected-tokens
                         (map (fn [{:token/keys [begin end] :as token}]
                                (if (and (> index begin) (< index end))
                                  (-> token
                                      (update :token/end #(+ % offset)))
                                  (-> token
                                      (update :token/begin #(+ % offset))
                                      (update :token/end #(+ % offset)))))
                              affected-tokens))
           :deleted []})

        :delete
        (let [end-index (+ index value)
              zero-width? (fn [{:token/keys [begin end]}] (= begin end))
              unaffected? (fn [{:token/keys [begin end] :as token}]
                            (if (zero-width? token)
                              ;; Zero-width tokens are pinned at position p:
                              ;; they're unaffected iff the deletion range
                              ;; starts at or after p (so no characters
                              ;; before p are touched). Mirrors the insert
                              ;; side which keeps a zero-width token at p
                              ;; pinned when inserting at p.
                              (<= end index)
                              (and (< begin index)
                                   (<= end index))))
              contained? (fn [{:token/keys [begin end] :as token}]
                           (if (zero-width? token)
                             ;; Zero-width tokens: STRICT containment on
                             ;; both sides. A delete range that begins or
                             ;; ends at p does NOT delete the zero-width
                             ;; token at p (insert-symmetry).
                             (and (< index begin)
                                  (> end-index end))
                             (and (>= begin index)
                                  (<= end end-index))))
              ;; token opens and closes within deletion range--delete it
              deleted-tokens (filterv contained? tokens)
              ;; token opens and closes before index (no changes)
              unaffected-tokens (filterv unaffected? tokens)
              affected-tokens (filterv #(not (or (contained? %) (unaffected? %))) tokens)]
          {:text (update text :text/body delete-str index value)
           :tokens (into unaffected-tokens
                         (mapv (fn [{:token/keys [begin end] :as token}]
                                 (cond
                                   ;; token opens and closes after deletion range--token is same but indices shrink
                                   (and (>= begin end-index)
                                        (>= end end-index))
                                   (-> token
                                       (update :token/begin #(- % value))
                                       (update :token/end #(- % value)))

                                   ;; token opens before index and closes within deletion range--shrink the token
                                   (and (< begin index)
                                        (<= end end-index))
                                   (-> token
                                       (assoc :token/end index))

                                   ;; token opens within deletion range and closes outside--set token/begin to index and shrink
                                   (and (>= begin index)
                                        (> end end-index))
                                   (-> token
                                       (assoc :token/begin index)
                                       (update :token/end #(- % (- end-index (min begin index)))))

                                   ;; deletion range is contained inside token
                                   :else
                                   (-> token
                                       (update :token/end #(- % value)))))
                               affected-tokens))
           :deleted (mapv :token/id deleted-tokens)})))))

(defn apply-text-edits [ops text tokens]
  (loop [accum {:deleted [] :text text :tokens tokens}
         op (first ops)
         ops (rest ops)]
    (if (nil? op)
      accum
      (let [result (apply-text-edit op (:text accum) (:tokens accum))
            new-accum (-> accum
                          (assoc :text (:text result))
                          (assoc :tokens (:tokens result))
                          (update :deleted into (:deleted result)))]
        (recur new-accum (first ops) (rest ops))))))
