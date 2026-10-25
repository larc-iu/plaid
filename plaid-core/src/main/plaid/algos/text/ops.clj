(ns plaid.algos.text.ops
  "Edit operations on a text's body: the op shapes, the checks a sent op
  passes, ops applied as sent (`apply-text-edits`), the net change of the
  ops an editor sends (`compose-edits`) and the ops of a list of gaps, and
  the conversion between running-coordinate ops and old-body edits."
  (:require [plaid.algos.text.chars :refer [leading-marks]]
            [plaid.util.codepoint :as cp]
            [plaid.util.op-json :as op-json]))

(defn delete-op [index value]
  {:type  :delete
   :index index
   :value value})

(defn insert-op [index value]
  {:type  :insert
   :index index
   :value value})

(defn replace-op [index length value]
  {:type   :replace
   :index  index
   :length length
   :value  value})

(defn- op-type [type]
  (or (and (keyword? type) type)
      (and (string? type) (keyword type))
      type))

(defn- check-op!
  "The 400s `apply-text-edits` throws, for `op` applied to a text of `len`
  code points."
  [op len]
  (let [{:keys [index value length]} op
        type (op-type (:type op))]
    ;; `integer?`: an index past a long (1e20 written out) is out of
    ;; bounds, as both clients say, not malformed
    (when-not (or (and (= type :insert) (integer? index) (string? value))
                  (and (= type :delete) (integer? index) (integer? value))
                  (and (= type :replace) (integer? index) (integer? length) (string? value)))
      (throw (ex-info (str "Malformed text edit operation: " (op-json/op-json op)
                           ". Expected {type: \"insert\", index: int, value: string},"
                           " {type: \"delete\", index: int, value: int}"
                           " or {type: \"replace\", index: int, length: int, value: string}")
                      {:code 400 :op op})))
    (when-not (contains? #{nil "before" "after" :before :after} (:side op))
      (throw (ex-info (str "A text edit's side is \"before\" or \"after\": " (op-json/op-json op))
                      {:code 400 :op op})))
    (when-not (case type
                :insert (<= 0 index len)
                :delete (and (<= 0 index) (<= 0 value) (<= (+ index value) len))
                :replace (and (<= 0 index) (<= 0 length) (<= (+ index length) len)))
      (throw (ex-info (str "Text edit operation out of bounds: " (op-json/op-json op)
                           " (text length is " len " code points)")
                      {:code 400 :op op :text-length len})))
    type))

(defn ops->edits
  "Sequential running-coordinate ops -> edits in OLD-body coordinates:
  {:kind :delete :start s :end e} / {:kind :insert :at a :value v} /
  {:kind :replace :start s :end e :value v}."
  [ops]
  (loop [ops ops del 0 ins 0 out []]
    (if-let [{:keys [type index value length]} (first ops)]
      (let [type (if (keyword? type) type (keyword type))
            old-pos (+ index del (- ins))]
        (case type
          :delete (recur (rest ops) (+ del value) ins
                         (conj out {:kind :delete :start old-pos :end (+ old-pos value)}))
          :insert (recur (rest ops) del (+ ins (cp/cp-count value))
                         (conj out {:kind :insert :at old-pos :value value}))
          :replace (recur (rest ops) (+ del length) (+ ins (cp/cp-count value))
                          (conj out {:kind :replace :start old-pos :end (+ old-pos length)
                                     :value value}))))
      out)))

(defn edits->ops
  "Old-coordinate edits, in their original (position-monotone) order ->
  sequential running-coordinate ops. An edit at old position p is shifted by
  the inserts before it and by the deletes that START strictly before p (a
  delete starting AT p removes text after p and doesn't move p). Linear:
  the deletes are summed as the edits pass them, and only those starting at
  the current position wait."
  [edits]
  (loop [edits edits del-before 0 waiting [] ins 0 out []]
    (if-let [e (first edits)]
      (let [p (or (:start e) (:at e))
            passed (filter #(< (first %) p) waiting)
            del-before (+ del-before (reduce + 0 (map second passed)))
            waiting (if (seq passed) (filterv #(>= (first %) p) waiting) waiting)
            running (+ p (- del-before) ins)]
        (case (:kind e)
          :delete (let [n (- (:end e) (:start e))]
                    (recur (rest edits) del-before (conj waiting [(:start e) n]) ins
                           (conj out (delete-op running n))))
          :insert (recur (rest edits) del-before waiting (+ ins (cp/cp-count (:value e)))
                         (conj out (insert-op running (:value e))))
          :replace (let [n (- (:end e) (:start e))]
                     (recur (rest edits) del-before (conj waiting [(:start e) n])
                            (+ ins (cp/cp-count (:value e)))
                            (conj out (replace-op running n (:value e)))))))
      out)))

(declare apply-text-edits)

(defn edit-ops-body
  "The text `ops` (running coordinates, applied in turn) make of `old`, or
  nil when one of them does not fit it. Through a gap buffer, so ops in
  nearly their order cost the text they move. Applying them in turn copies
  the whole text for each op out of order, which took seconds on a long text
  pasted over by another."
  [ops ^String old]
  (let [^ints o (.toArray (.codePoints old))
        n (alength o)
        typed (reduce + 0 (keep #(when (string? (:value %)) (cp/cp-count (:value %))) ops))
        cap (+ n typed)
        buf (int-array cap)]
    (System/arraycopy o 0 buf (- cap n) n)
    (loop [ops (seq ops) gs 0 ge (- cap n)]
      ;; (a nil op is one that does not fit, never the end of the list)
      (if ops
        (let [{:keys [index value length] :as op} (first ops)
              type (op-type (:type op))
              len (+ gs (- cap ge))
              cut (case type :delete value :replace length :insert 0 nil)
              typed (when (#{:insert :replace} type) value)]
          (when (and (int? index) (<= 0 index len) (int? cut) (<= 0 cut (- len index))
                     (or (= type :delete) (string? typed)))
            ;; the gap to index
            (let [[gs ge] (cond
                            (< index gs) (let [k (- gs index)]
                                           (System/arraycopy buf index buf (- ge k) k)
                                           [index (- ge k)])
                            (> index gs) (let [k (- index gs)]
                                           (System/arraycopy buf ge buf gs k)
                                           [index (+ ge k)])
                            :else [gs ge])
                  ge (+ ge cut)
                  gs (if typed
                       (let [^ints v (.toArray (.codePoints ^String typed))]
                         (System/arraycopy v 0 buf gs (alength v))
                         (+ gs (alength v)))
                       gs)]
              (recur (next ops) gs ge))))
        (str (String. buf 0 (int gs)) (String. buf (int ge) (int (- cap ge))))))))

(defn- token-edit
  "A function of one token giving what `op` (valid, its type a keyword) does
  to it: the token moved or resized, or nil when the op deletes it.

  An insert inside a token grows it, and text typed at a token's end stays
  outside it (`cat` to `cats` leaves the token on `cat`), except the
  combining marks (Unicode Mn, Mc, Me) the text starts with: those belong to
  the letter before them, so a token ending there takes them and a
  zero-width token there moves past them. A delete removes a token it holds
  whole, and a zero-width token only when it stands strictly inside the
  deleted range.

  A replace is a delete and an insert, except that a token covering the whole
  replaced range keeps it, resized (`kat` to `cat` keeps the word token and
  everything hanging off it), and a zero-width token at the range's end
  stays at the end. A replace whose new text starts with marks is those
  marks inserted, then the rest replacing the range. An empty value is a
  delete, a zero length an insert."
  [{:keys [type index value length]}]
  (let [shift (fn [t d] (-> t (update :token/begin + d) (update :token/end + d)))]
    (case type
      :insert
      (let [offset (cp/cp-count value)
            marks (if (pos? index) (leading-marks value) 0)]
        (fn [{:token/keys [begin end] :as t}]
          (cond
            (< end index) t
            (= end index) (cond (zero? marks) t
                                (< begin index) (update t :token/end + marks)
                                :else (shift t marks))
            (< begin index) (update t :token/end + offset)
            :else (shift t offset))))

      :delete
      (let [ei (+ index value)]
        (fn [{:token/keys [begin end] :as t}]
          (if (= begin end)
            (cond (<= end index) t
                  (< index begin ei) nil
                  :else (shift t (- value)))
            (cond (and (<= index begin) (<= end ei)) nil
                  (<= end index) t
                  (<= ei begin) (shift t (- value))
                  (< begin index) (if (<= end ei)
                                    (assoc t :token/end index)
                                    (update t :token/end - value))
                  :else (-> t (assoc :token/begin index) (update :token/end - value))))))

      :replace
      (cond
        (zero? length) (token-edit (insert-op index value))
        (= value "") (token-edit (delete-op index length))
        (and (pos? index) (pos? (leading-marks value)))
        (let [k (leading-marks value)
              f (token-edit (insert-op index (cp/cp-subs value 0 k)))
              g (token-edit (replace-op (+ index k) length (cp/cp-subs value k)))]
          (fn [t] (some-> t f g)))
        :else
        (let [ei (+ index length)
              delta (- (cp/cp-count value) length)
              del (token-edit (delete-op index length))
              ins (token-edit (insert-op index value))]
          (fn [{:token/keys [begin end] :as t}]
            (cond
              (and (< begin end) (<= begin index) (<= ei end)) (update t :token/end + delta)
              (and (= begin end) (= end ei)) (shift t delta)
              :else (some-> t del ins))))))))

(defn apply-text-edits
  "Apply `ops` one after another to `text` and `tokens`, each by the rules
  of `token-edit`. An op is {:type :insert :index i :value \"is \"},
  {:type :delete :index i :value n} or {:type :replace :index i :length n
  :value \"new\"}, its type a keyword or a string, indices and counts in
  code points of the body as the ops before it left it. A malformed or
  out-of-bounds op is a 400 (`check-op!`). Returns {:text :tokens :deleted},
  the deleted tokens' ids, the tokens and ids in no promised order.

  Ops that each stand at or after where the one before left off (every op
  list `diff` and the steps after it give, and most a client sends) are
  applied in one pass: the body is built once, and each token is put through
  only the ops that reach it, after the shift of those before it. Applying
  each op over the whole text and every token cost seconds for a thousand
  edits over a long text, with the write lock held. Other op lists are
  applied a run of such ops at a time: one op out of that order among the
  7,000 a long line retyped gave cost a minute applied in turn."
  [ops text tokens]
  (let [ops (vec ops)
        ^String body (:text/body text)
        ^ints o (.toArray (.codePoints body))
        n (alength o)
        ;; Validate as the ops come, and place each in the old body: an op
        ;; at running index i stands at old position i - shift. `edits` is
        ;; nil once an op stands before where the previous one left off,
        ;; which is op `break`.
        {:keys [edits break]}
        (reduce (fn [{:keys [len shift reach edits break] :as acc} op]
                  (let [type (check-op! op len)
                        {:keys [index value length]} op
                        [del ins] (case type
                                    :insert [0 (cp/cp-count value)]
                                    :delete [value 0]
                                    :replace [length (cp/cp-count value)])
                        s (- index shift)
                        t (+ s del)]
                    (assoc acc
                           :len (+ len (- ins del))
                           :shift (+ shift (- ins del))
                           :reach t
                           :edits (when (and edits (<= reach s))
                                    (conj edits {:op (assoc op :type type) :start s :end t
                                                 :delta (- ins del)
                                                 :value (if (= type :delete) "" value)}))
                           :break (or break (when (and edits (< s reach)) (count edits))))))
                {:len n :shift 0 :reach 0 :edits []}
                ops)]
    (if-not edits
      ;; The ops before `break` stand in order, and so do the first run of
      ;; those from it on: each run in one pass, over what the one before
      ;; made, is the ops applied in turn.
      (loop [ops ops j break text text tokens tokens deleted []]
        (let [{t :text ts :tokens d :deleted} (apply-text-edits (subvec ops 0 j) text tokens)
              ops (subvec ops j)
              deleted (into deleted d)]
          (if (empty? ops)
            {:text t :tokens ts :deleted deleted}
            ;; how many of the rest stand in order
            (recur ops
                   (loop [i 0 shift 0 reach 0]
                     (if (< i (count ops))
                       (let [{:keys [type index value length]} (ops i)
                             [del ins] (case (op-type type)
                                         :insert [0 (cp/cp-count value)]
                                         :delete [value 0]
                                         :replace [length (cp/cp-count value)])
                             s (- index shift)]
                         (if (< s reach) i (recur (inc i) (+ shift (- ins del)) (+ s del))))
                       i))
                   t ts deleted))))
      (let [k (count edits)
            new-body (let [sb (StringBuilder.)]
                       (loop [p 0 es edits]
                         (if-let [{:keys [start end value]} (first es)]
                           (do (.append sb (String. o (int p) (int (- start p))))
                               (.append sb ^String value)
                               (recur end (rest es)))
                           (.append sb (String. o (int p) (int (- n p))))))
                       (str sb))
            ends (long-array (map :end edits))
            ;; where each op stands when it is applied
            at (long-array (map (comp :index :op) edits))
            ;; the shift of the edits before each
            before (long-array (reductions + 0 (map :delta edits)))
            fns (mapv (comp token-edit :op) edits)
            ;; the first index in xs whose value is at least x
            lower (fn [^longs xs x]
                    (loop [a 0 b (alength xs)]
                      (if (< a b)
                        (let [m (quot (+ a b) 2)]
                          (if (< (aget xs m) (long x)) (recur (inc m) b) (recur a m)))
                        a)))
            edit-token (fn [{:token/keys [begin] :as t}]
                         ;; The edits that end before it only shift it. From
                         ;; the first that reaches it, each op stands at or
                         ;; after where the one before stood, so once one
                         ;; stands past the token's end, none of the rest
                         ;; touches it.
                         (let [lo (lower ends begin)
                               d (aget before lo)
                               t (if (zero? d)
                                   t
                                   (-> t (update :token/begin + d) (update :token/end + d)))]
                           (loop [i lo t t]
                             (if (and t (< i k) (<= (aget at i) (long (:token/end t))))
                               (recur (inc i) ((fns i) t))
                               t))))
            results (mapv (fn [t] [t (edit-token t)]) tokens)]
        {:text (assoc text :text/body new-body)
         :tokens (into [] (keep second) results)
         :deleted (into [] (keep (fn [[t t']] (when-not t' (:token/id t)))) results)}))))

;; ---------------------------------------------------------------------------
;; Edits from the caret
;;
;; An editor that knows where each change was made sends the changes as ops
;; (`PATCH /texts/:id` with `edits`). Nothing is guessed about where they
;; stand: the caret said. The ops are composed into their net change, gaps of
;; old text and what stands there now, which the plain rule below then reads.

(defn compose-edits
  "The net change `ops` make to `old`, as gaps in old-body code points,
  `[{:start a :end b :value v}]`: between two runs of old text that came
  through, [a b) of `old` went and `v` stands there now. In old-body order,
  never touching, each an insert (a = b), a delete (v empty) or both. A gap
  whose `v` is the text it took is left out (a letter deleted and typed
  back).

  `ops` are running-coordinate ops, applied in order (each op's index is in
  the body the ops before it left), as `apply-text-edits` takes them. Each
  is checked against that body, and a malformed or out-of-bounds one throws
  the 400 `apply-text-edits` would. Old text an op deletes is gone even when
  the same letters are typed back later, so the gaps depend only on what
  came through, never on the order or the grouping of the keystrokes. So a
  zero-width token strictly inside a stretch deleted a letter at a time is
  deleted as it is by one delete of the stretch: two words joined by
  deleting the letters and the space between them are one word, and a
  marker of the edge of either has no edge left to mark."
  [ops ^String old]
  (let [n (cp/cp-count old)
        ;; the new text as segments: [:old a b] for old text that came
        ;; through, [:new s k] for k typed code points
        seg-len (fn [[kind x y]] (if (= kind :old) (- y x) y))
        cut (fn [[kind x y side :as seg] k]
              ;; the segment's first k code points and the rest
              (if (= kind :old)
                [[:old x (+ x k)] [:old (+ x k) y]]
                [[:new (cp/cp-subs x 0 k) k side] [:new (cp/cp-subs x k) (- y k) side]]))
        ;; A finger over the segments: `left` (a vector) before it, `right`
        ;; (a list) after it, `pos` its place in the new text and `len` the
        ;; new text's length. Each op moves the finger to its index, cutting a
        ;; segment there, drops what it deletes from `right` and puts what it
        ;; types on `left`, so ops near each other (typing, a paste split into
        ;; many ops) cost what the finger moves, not the whole text.
        segs (loop [ops (seq ops)
                    left []
                    right (if (pos? n) (list [:old 0 n]) ())
                    pos 0
                    len n]
               ;; every op is checked: a nil one is refused, never read as
               ;; the end of the list, which dropped every op after it
               (if ops
                 (let [op (first ops)
                       type (check-op! op len)
                       {:keys [index value length]} op
                       k (case type :insert 0 :delete value :replace length)
                       v (if (= type :delete) "" value)
                       vn (cp/cp-count v)
                       ;; the finger to `index`
                       [left right] (loop [left left right right pos pos]
                                      (cond
                                        (< index pos)
                                        (let [seg (peek left) l (seg-len seg)]
                                          (if (<= (- pos l) index)
                                            (let [[x y] (cut seg (- index (- pos l)))]
                                              [(conj (pop left) x) (conj right y)])
                                            (recur (pop left) (conj right seg) (- pos l))))
                                        (> index pos)
                                        (let [seg (first right) l (seg-len seg)]
                                          (if (<= index (+ pos l))
                                            (let [[x y] (cut seg (- index pos))]
                                              [(conj left x) (conj (rest right) y)])
                                            (recur (conj left seg) (rest right) (+ pos l))))
                                        :else [left right]))
                       ;; `k` code points dropped after it
                       right (loop [right right k k]
                               (if (pos? k)
                                 (let [seg (first right) l (seg-len seg)]
                                   (if (<= l k)
                                     (recur (rest right) (- k l))
                                     (conj (rest right) (second (cut seg k)))))
                                 right))]
                   (recur (next ops) (conj left [:new v vn (some-> (:side op) keyword)]) right (+ index vn) (+ (- len k) vn)))
                 ;; runs of typed or kept text next to each other are read
                 ;; as one below
                 (into [] (remove #(zero? (seg-len %))) (concat left right))))
        ;; the gaps between the runs of old text that came through
        ;; A gap's `:side` is the side its typed text was typed on where two
        ;; tokens meet (`side` on an op, :before or :after), when its ops say
        ;; one and only one.
        gaps (loop [segs segs pos 0 typed (StringBuilder.) sides #{} out []]
               (let [[kind x y side :as seg] (first segs)
                     flush (fn [a]
                             (let [v (str typed)]
                               (if (or (< pos a) (pos? (count v)))
                                 (conj out (cond-> {:start pos :end a :value v}
                                             (= 1 (count sides)) (assoc :side (first sides))))
                                 out)))]
                 (cond
                   (nil? seg) (flush n)
                   (= kind :new) (recur (rest segs) pos (.append typed ^String x)
                                        (cond-> sides (and side (pos? y)) (conj side)) out)
                   :else (recur (rest segs) y (StringBuilder.) #{} (flush x)))))
        same? (fn [{:keys [start end value]}]
                (and (< start end) (= value (cp/cp-subs old start end))))]
    (into [] (remove same?) gaps)))

(defn gap-ops
  "Running ops for `gaps` (old-body order, never touching, see
  `compose-edits`): an insert, a delete, or a replace each."
  [gaps]
  (loop [gaps gaps shift 0 out []]
    (if-let [{:keys [start end value]} (first gaps)]
      (let [i (+ start shift)
            k (- end start)
            n (cp/cp-count value)]
        (recur (rest gaps) (+ shift (- n k))
               (conj out (cond
                           (zero? k) (insert-op i value)
                           (zero? n) (delete-op i k)
                           :else (replace-op i k value)))))
      out)))
