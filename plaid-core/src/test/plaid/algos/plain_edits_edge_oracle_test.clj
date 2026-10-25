(ns plaid.algos.plain-edits-edge-oracle-test
  "The plain-edits oracle where its rules meet an edge: a selection typed over,
  nodes beside the words, a layer that splits on space, and text typed where two
  sentences or two words meet. The generators and the judge are in
  `plaid.algos.plain-edits-oracle`."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.algos.plain-edits-oracle :refer [cases-per-config configs cps edit-loss-problems gap-fill gen-doc gen-gaps keystrokes layout-tokens problems punct? roles run save save-read server-gaps trim-ws ws?]]
            [plaid.algos.text :as ta]
            [plaid.util.codepoint :as cp]))

;; ---------------------------------------------------------------- selections typed over

(defn- select-type-over
  "One gap: a selection from inside or at the edge of a word to inside or at
  the edge of a word up to three on, typed over with its own text with its
  words changed: one dropped, one of the text's words added before or after
  one, one grown or shrunk by a letter, one swapped for another word of the
  text, or all retyped as they were. The typed text shares letters, often
  ends, with the selection (REV3-F-TEXT-CORE G3)."
  [^java.util.Random rng ^String body tokens]
  (let [words (vec (sort-by :token/begin (filter #(= :w (:token/layer %)) tokens)))
        texts (mapv #(cp/cp-subs body (:token/begin %) (:token/end %)) words)
        pick #(nth % (.nextInt rng (count %)))
        i (.nextInt rng (count words))
        j (min (dec (count words)) (+ i (.nextInt rng 4)))
        wi (words i) wj (words j)
        a (+ (:token/begin wi) (.nextInt rng (max 1 (- (:token/end wi) (:token/begin wi)))))
        a (if (.nextBoolean rng) (:token/begin wi) a)
        b (if (.nextBoolean rng) (:token/end wj) (- (:token/end wj) (.nextInt rng (max 1 (- (:token/end wj) (:token/begin wj))))))
        b (max b (inc a))
        sel (cp/cp-subs body a b)
        parts (vec (re-seq #"\S+|\s+" sel))
        wk (vec (keep-indexed (fn [k p] (when-not (re-matches #"\s+" p) k)) parts))
        k (when (seq wk) (pick wk))
        v (if (nil? k)
            (str sel (pick texts))
            (case (.nextInt rng 6)
              0 (apply str (assoc parts k ""))
              1 (apply str (assoc parts k (str (pick texts) " " (parts k))))
              2 (apply str (assoc parts k (str (parts k) " " (pick texts))))
              3 (apply str (assoc parts k (str (parts k) (pick texts))))
              4 (apply str (assoc parts k (pick texts)))
              sel))]
    (when (not= v sel) [{:start a :end b :value v}])))

(deftest a-selection-typed-over-deletes-no-word-with-a-letter-left
  (doseq [[cname opts] configs]
    (let [fails (atom [])]
      (dotimes [seed 400]
        (let [rng (java.util.Random. (+ seed (* 6151 (hash cname))))
              layout (:layout opts :apps)
              {:keys [body tokens]} (gen-doc rng opts)
              tokens (layout-tokens layout tokens)]
          (when-let [gaps (and (some #(= :w (:token/layer %)) tokens) (select-type-over rng body tokens))]
            (let [ops (ta/gap-ops gaps)
                  r (run body tokens ops layout false)
                  ps (-> (problems body tokens (server-gaps body tokens ops layout) r)
                         (into (edit-loss-problems body tokens ops layout r))
                         (cond-> (not= (ta/edit-ops-body ops body) (:text/body (:text r))) (conj "body")))]
              (when (seq ps) (swap! fails conj {:config cname :seed seed :old body :gaps gaps :problems (take 3 ps)}))))))
      (testing (str cname)
        (is (empty? @fails) (pr-str (take 3 @fails)))))))

;; ---------------------------------------------------------------- nodes beside the words

(defn- nodes-and-words
  "The words (:w) and nodes (:u) after a save, both on the one rule."
  [old tokens {:keys [ops new]}]
  (let [r (if ops (run old tokens ops) (save old new tokens))
        live (fn [layer] (into {} (comp (filter #(= layer (:token/layer %)))
                                        (remove #((set (:deleted r)) (:token/id %)))
                                        (map (juxt :token/id identity)))
                               (:tokens r)))]
    {:body [(:text/body (:text r)) (:text/body (:text r))]
     :words (live :w)
     :nodes (live :u)
     :deleted-nodes (set (:deleted r))}))

(defn- follow-problems
  "A node edge that stood at a word's edge stands at that word's edge now,
  whenever the word is left, and a node goes only when all its letters do."
  [tokens expected {:keys [body words nodes deleted-nodes]}]
  (let [ws (filterv #(= :w (:token/layer %)) tokens)
        out (transient [])]
    (when (not= [expected expected] body) (conj! out (str "body " (pr-str body))))
    (doseq [{:token/keys [id layer begin end]} tokens :when (= :u layer)]
      (if-let [n (nodes id)]
        (do
          (doseq [w ws :when (= begin (:token/begin w)) :let [w* (words (:token/id w))] :when w*]
            (when (not= (:token/begin w*) (:token/begin n))
              (conj! out (str id " begins at " (:token/begin n) ", its word " (:token/id w) " at " (:token/begin w*)))))
          (doseq [w ws :when (= end (:token/end w)) :let [w* (words (:token/id w))] :when w*]
            (when (not= (:token/end w*) (:token/end n))
              (conj! out (str id " ends at " (:token/end n) ", its word " (:token/id w) " at " (:token/end w*))))))
        (cond
          (not (deleted-nodes id)) (conj! out (str id " missing"))
          ;; REV2 M3: never deleted while a word it stood over, or in, stays
          (some #(and (words (:token/id %))
                      (or (and (<= begin (:token/begin %)) (<= (:token/end %) end))
                          (and (<= (:token/begin %) begin) (<= end (:token/end %)))))
                ws)
          (conj! out (str id " deleted though its word stays")))))
    (persistent! out)))

(deftest nodes-beside-the-words-keep-to-the-words
  ;; A node layer beside the words (UMR's) takes the words' outcome at their
  ;; edges, whatever the edit (Luke, 2026-09-30, option c).
  (let [opts {:carets 3 :nodes true :spaced 0.3 :glue 0.1}
        fails (atom [])]
    (dotimes [seed cases-per-config]
      (let [rng (java.util.Random. (+ seed 424242))
            {:keys [body tokens]} (gen-doc rng opts)
            gaps (gen-gaps rng body tokens opts)
            tokens (filterv #(#{:w :u :s} (:token/layer %)) tokens)
            new-body (ta/edit-ops-body (ta/gap-ops gaps) body)]
        (doseq [[rname change] {:composed {:ops (ta/gap-ops gaps)}
                                :keys-left-to-right {:ops (keystrokes gaps false)}
                                :whole-body {:new new-body}}]
          (let [ps (follow-problems tokens new-body (nodes-and-words body tokens change))]
            (when (seq ps) (swap! fails conj {:seed seed :reading rname :old body :gaps gaps :problems (take 3 ps)}))))))
    (is (empty? @fails) (str (count @fails) " " (pr-str (take 3 @fails))))))

;; ---------------------------------------------------------------- ud: a space splits a word

(defn- ws-runs [^ints cs b e]
  (loop [i b in? false n 0]
    (if (< i e)
      (let [w (ws? (aget cs i))] (recur (inc i) w (if (and w (not in?)) (inc n) n)))
      n)))

(defn- split-problems
  "`split` against `plain`, the same edit without `splitOnSpace`, judged by
  the ruling, not by the algorithm: a word the plain rule gives typed
  whitespace inside is cut only at the runs of whitespace holding typed
  whitespace (REV2 M1), and goes on the part holding the most of its own old
  letters, the first on a tie. Each other part holding one of its old
  letters is a new word, with a new
  token under it on each layer under the words the word had one as long as
  it on, unless that layer deals them out (`dealt`) and had as many as
  there are parts, which then go one to each part in order (Q2-UD-POLISH-2,
  FX6-SPLIT). Another token as long as it goes with it. A token under it
  shorter than it (FX6-SPLIT) stays on the part the word stays on when it
  reaches it, else the first part it reaches, cut to it, each other part it
  reaches gets a new token of its layer over its letters there, and it goes
  when it reaches none. Any other token inside it is cut to the part holding
  most of its letters (or goes when none of it is there), one over several
  words that began or ended with it begins or ends where it does, and
  nothing else differs. A row (a token of a layer that forbids overlap
  beside the words) is where it is without `splitOnSpace`: it keeps every
  old letter it held. `gaps` are the change as the server takes it."
  [^String old tokens gaps plain split dealt]
  (let [o (cps old)
        nw (cps (:text/body (:text plain)))
        ;; old position -> new position, and the typed new positions
        newpos (let [m (int-array (alength o) -1)]
                 (loop [i 0 gs (seq gaps) shift 0]
                   (let [{:keys [start end value] :as g} (first gs)]
                     (cond
                       (and g (= start end) (<= start i)) (recur i (next gs) (+ shift (cp/cp-count value)))
                       (and g (< start end) (<= end i)) (recur i (next gs) (+ shift (- (cp/cp-count value) (- end start))))
                       (< i (alength o)) (do (when-not (and g (<= start i) (< i end)) (aset m i (+ i shift)))
                                             (recur (inc i) gs shift)))))
                 m)
        typed (let [a (boolean-array (alength nw) true)]
                (dotimes [i (alength o)] (when (>= (aget newpos i) 0) (aset a (aget newpos i) false)))
                a)
        p (into {} (map (juxt :token/id identity)) (:tokens plain))
        q (into {} (map (juxt :token/id identity)) (:tokens split))
        sentence-now (into {} (map (juxt :token/id (juxt :token/begin :token/end)))
                           (gap-fill (into (filterv #(= :s (:token/layer %)) (:tokens split))
                                           (map-indexed #(assoc %2 :token/id [::head %1]) (:heads split)))
                                     (alength nw)))
        moved (into {}
                    (keep (fn [{:token/keys [id layer begin end]}]
                            (when-let [t (and (= :w layer) (p id))]
                              (let [pb (:token/begin t) pe (:token/end t)
                                    runs (->> (range pb pe) (partition-by #(ws? (aget nw %)))
                                              (filter #(ws? (aget nw (first %)))))
                                    cuts (filter (fn [r] (some #(aget typed %) r)) runs)]
                                (when (seq cuts)
                                  (let [pieces (map vector (cons pb (map #(inc (last %)) cuts)) (concat (map first cuts) [pe]))
                                        own (set (keep #(let [x (aget newpos %)] (when (and (>= x 0) (not (ws? (aget o %)))) x))
                                                       (range begin end)))
                                        score (fn [[x y]] (count (filter own (range x y))))
                                        best (reduce max (map score pieces))]
                                    [[begin end] (first (filter #(= best (score %)) pieces))]))))))
                    tokens)
        ;; every part of each split word (Q2-UD-POLISH-2: each is a word)
        pieces-of (into {}
                        (keep (fn [{:token/keys [id layer begin end]}]
                                (when (moved [begin end])
                                  (let [t (p id) pb (:token/begin t) pe (:token/end t)
                                        runs (->> (range pb pe) (partition-by #(ws? (aget nw %)))
                                                  (filter #(ws? (aget nw (first %)))))
                                        cuts (filter (fn [r] (some #(aget typed %) r)) runs)
                                        own (set (keep #(let [x (aget newpos %)] (when (and (>= x 0) (not (ws? (aget o %)))) x))
                                                       (range begin end)))
                                        all (map vector (cons pb (map #(inc (last %)) cuts)) (concat (map first cuts) [pe]))]
                                    ;; a part holding none of its letters is text
                                    ;; typed apart from it
                                    [[begin end] (vec (or (not-empty (filter (fn [[x y]] (some own (range x y))) all))
                                                          [(moved [begin end])]))]))))
                        (filter #(= :w (:token/layer %)) tokens))
        ;; the tokens under a split word as long as it, by word and layer: as
        ;; many of a layer as parts go one to each part, in order
        child? #{:m :x}
        under (group-by (juxt (juxt :token/begin :token/end) :token/layer)
                        (filter #(and (child? (:token/layer %)) (p (:token/id %))
                                      (pieces-of [(:token/begin %) (:token/end %)]))
                                tokens))
        shared (into {} (mapcat (fn [[[w l] ts]] (when (and (dealt l) (= (count ts) (count (pieces-of w))))
                                                   (map vector (map :token/id ts) (pieces-of w))))
                                under))
        ;; a token under a split word, shorter than it: id -> [home others]
        ;; (each cut to its part), by where it stands
        own-of (fn [begin end] (set (keep #(let [x (aget newpos %)] (when (and (>= x 0) (not (ws? (aget o %)))) x))
                                          (range begin end))))
        under-placed (into {}
                           (keep (fn [{:token/keys [id layer begin end]}]
                                   (when-let [t (and (child? layer) (p id))]
                                     (when-let [[w ps] (some (fn [[[wb we] ps]] (when (and (<= wb begin) (<= end we) (not (and (= wb begin) (= we end))))
                                                                                  [[wb we] ps]))
                                                             pieces-of)]
                                       (let [own (own-of begin end)
                                             reach (filterv (fn [[b e]] (some own (range b e)))
                                                            (map (fn [[x y]] [(max x (:token/begin t)) (min y (:token/end t))]) ps))
                                             [kx ky] (moved w)
                                             home (or (first (filter (fn [[b e]] (and (<= kx b) (<= e ky))) reach)) (first reach))]
                                         [id [home (remove #(= % home) reach) layer]])))))
                           tokens)
        ;; one new token per token reaching over a cut
        want-made (sort (concat
                         (mapcat (fn [[w ps]]
                                   (for [piece ps :when (not= piece (moved w))
                                         l (cons :w (keep (fn [[[w2 l] ts]] (when (and (= w2 w) (not (shared (:token/id (first ts))))) l)) under))]
                                     [l (first piece) (second piece)]))
                                 pieces-of)
                          ;; and the pieces of those shorter than it on the
                          ;; parts they reach
                         (for [[_ [_ others l]] under-placed [b e] others] [l b e])))
        out (transient [])]
    (when (not= want-made (sort (map (juxt :token/layer :token/begin :token/end) (:made split))))
      (conj! out (str "made " (pr-str (:made split)) ", want " (pr-str want-made))))
    (when (not= (:text split) (:text plain)) (conj! out "body"))
    (doseq [{:token/keys [id layer begin end]} tokens
            :let [t (p id)
                  got (q id)
                  ;; a token over a sentence follows the sentence (REV3)
                  over (when (and t (#{:a :ss} layer))
                         (some #(when (and (= :s (:token/layer %)) (= [begin end] (trim-ws o [(:token/begin %) (:token/end %)])))
                                  (:token/id %))
                               tokens))
                  inside (some (fn [[[wb we] ps]] (when (and (<= wb begin) (<= end we) (not (and (= wb begin) (= we end)))) ps)) pieces-of)
                  want (cond
                         ;; a head made only on one side moves the first sentence
                         (and (= :s layer) (not= (:heads plain) (:heads split))) got
                         ;; and a token typed over with the line: one side
                         ;; begins it before the line's end, the other after
                         (and t got (not= (:heads plain) (:heads split))
                              (let [he (:token/end (first (or (:heads plain) (:heads split))))]
                                (not= (< (:token/begin got) he) (< (:token/begin t) he))))
                         got
                         (or (nil? t) (= :s layer)) t
                         over (let [[b e] (trim-ws nw (sentence-now over))] (assoc t :token/begin b :token/end e))
                         ;; a row keeps every old letter it held and the text
                         ;; typed inside it, so a typed space that splits a
                         ;; word moves it nowhere (FX-E-TEXT, REV4-TEXT-2)
                         (#{:a :ss :rw} layer) t
                         (shared id) (let [[x y] (shared id)] (assoc t :token/begin x :token/end y))
                         (moved [begin end]) (let [[x y] (moved [begin end])] (assoc t :token/begin x :token/end y))
                         (contains? under-placed id) (when-let [[b e] (first (under-placed id))]
                                                       (assoc t :token/begin b :token/end e))
                         ;; to the part holding most of its own letters, the
                         ;; first on a tie
                         inside (let [in (fn [[x y]] [(max x (:token/begin t)) (min y (:token/end t))])
                                      own (set (keep #(let [x (aget newpos %)] (when (and (>= x 0) (not (ws? (aget o %)))) x))
                                                     (range begin end)))
                                      score (fn [piece] (let [[b e] (in piece)] [(count (filter own (range b e))) (- e b)]))
                                      best (reduce (fn [a q] (if (pos? (compare (score q) (score a))) q a)) inside)
                                      [b e] (in best)]
                                  (when (< b e) (assoc t :token/begin b :token/end e)))
                         :else (let [b (or (some (fn [[[wb _] [x _]]] (when (= wb begin) x)) moved) (:token/begin t))
                                     e (or (some (fn [[[_ we] [_ y]]] (when (= we end) y)) moved) (:token/end t))]
                                 (if (< b e) (assoc t :token/begin b :token/end e) t)))
                  got (q id)]]
      (when (not= (some-> want ((juxt :token/begin :token/end))) (some-> got ((juxt :token/begin :token/end))))
        (conj! out (str id " at " (some-> got ((juxt :token/begin :token/end))) ", want " (some-> want ((juxt :token/begin :token/end)))))))
    (persistent! out)))

(deftest a-layer-that-splits-on-space-differs-only-there
  ;; ud (Luke, 2026-09-30): the plain rule, but a word given a space splits
  ;; and (Q2-UD-POLISH-2) each other part of the word is a word of its own
  (doseq [[layout opts] [[:apps {:carets 3 :spaced 0.4 :child 0.7 :nodes true :glue 0.1}]
                         [:apps-dealt {:carets 3 :spaced 0.4 :child 0.7 :nodes true :glue 0.1}]
                         ;; a script's words with morphemes inside them
                         [:script {:carets 3 :spaced 0.3 :sub 0.6 :glue 0.1 :typed ["Q" " " "Q R" " Q " "XZ XZ"]}]]]
    (let [fails (atom [])]
      (dotimes [seed cases-per-config]
        (let [rng (java.util.Random. (+ seed 5151 (if (#{:apps :apps-dealt} layout) 0 7)))
              {:keys [body tokens]} (gen-doc rng opts)
              gaps (gen-gaps rng body tokens opts)
              tokens (layout-tokens layout tokens)
              new-body (ta/edit-ops-body (ta/gap-ops gaps) body)
              server (server-gaps body tokens (ta/gap-ops gaps) layout)]
          (doseq [[rname plain split sgaps] [[:composed
                                              (run body tokens (ta/gap-ops gaps) layout false)
                                              (run body tokens (ta/gap-ops gaps) layout true)
                                              server]
                                             [:keys-right-to-left
                                              (run body tokens (keystrokes gaps true) layout false)
                                              (run body tokens (keystrokes gaps true) layout true)
                                              server]
                                             [:whole-body
                                              (save body new-body tokens layout false)
                                              (save body new-body tokens layout true)
                                              (first (save-read body new-body tokens layout false))]]]
            (let [ps (split-problems body tokens sgaps plain split (:dealt (roles layout false)))]
              (when (seq ps) (swap! fails conj {:layout layout :seed seed :reading rname :old body :gaps gaps :problems (take 3 ps)}))))))
      (testing (str layout)
        (is (empty? @fails) (str (count @fails) " " (pr-str (take 3 @fails))))))))

;; ---------------------------------------------------------------- sentence starts by the caret

;; REV3: a token over a sentence follows it, a node over several words keeps
;; to its words, and a line typed before the first sentence is a sentence
(defn- follow-checks [^String old tokens server r]
  (let [o (cps old)
        nb (:text/body (:text r))
        by-id (into {} (map (juxt :token/id identity)) (:tokens r))
        heads (:heads r)
        filled (into {} (map (juxt :token/id (juxt :token/begin :token/end)))
                     (gap-fill (into (filterv #(= :s (:token/layer %)) (:tokens r))
                                     (map #(assoc % :token/id ::head) heads))
                               (cp/cp-count nb)))
        sents (filter #(= :s (:token/layer %)) tokens)
        words (filter #(= :w (:token/layer %)) tokens)
        ;; the plain rule deletes a token with no letter left and no letter
        ;; typed inside it, its sentence or not (REV-W2-LAST F1): no gap
        ;; within it types one (its whole text typed over too), nor an
        ;; insert strictly inside it, and no word under it is kept
        may-go? (fn [begin end]
                  (and (not-any? (fn [i] (and (not (ws? (aget o i)))
                                              (not-any? #(and (<= (:start %) i) (< i (:end %))) server)))
                                 (range begin end))
                       (not-any? #(and (some (complement ws?) (cps (:value %)))
                                       (if (= (:start %) (:end %))
                                         (< begin (:start %) end)
                                         (and (<= begin (:start %)) (<= (:end %) end))))
                                 server)
                       (not-any? #(and (<= begin (:token/begin %)) (<= (:token/end %) end) (by-id (:token/id %)))
                                 words)))
        out (transient [])]
    ;; segments over sentences
    (doseq [{:token/keys [id begin end]} tokens :when (= :as (first id))
            :let [st (some #(when (= [begin end] (trim-ws o [(:token/begin %) (:token/end %)])) %) sents)
                  want (some->> st :token/id filled (trim-ws (cps nb)))
                  got (some-> (by-id id) ((juxt :token/begin :token/end)))]
            :when (and want (not= want got) (or got (not (may-go? begin end))))]
      (conj! out (if got
                   (str id " at " got ", its sentence at " want)
                   (str id " deleted though its sentence stays, at " want))))
    ;; rows over sentences with their whitespace (REV2-TEXT-1): each on its
    ;; sentence as the gap-fill leaves it, off the whitespace it had none of,
    ;; text typed in its whitespace going with the sentence that takes it
    ;; (FX-E-TEXT, REV4-TEXT-1), and the next row begins where it ends
    (let [nw (cps nb)
          rws (sort-by :token/begin (filter #(= :rw (first (:token/id %))) tokens))
          wants (reduce (fn [acc {:token/keys [id begin end]}]
                          (let [st (some #(when (= [begin end] [(:token/begin %) (:token/end %)]) %) sents)
                                want (when-let [[b e] (some-> st :token/id filled)]
                                       (let [b (if (ws? (aget o begin)) b (loop [x b] (if (and (< x e) (ws? (aget nw x))) (recur (inc x)) x)))
                                             e (if (ws? (aget o (dec end))) e (loop [x e] (if (and (> x b) (ws? (aget nw (dec x)))) (recur (dec x)) x)))
                                             b (if-let [pe (:end (peek acc))] (max b pe) b)]
                                         (when (< b e) [b e])))]
                            (conj acc {:id id :want want :end (second want) :span [begin end]})))
                        [] rws)]
      (doseq [{:keys [id want span]} wants
              :let [got (some-> (by-id id) ((juxt :token/begin :token/end)))]
              :when (and want (not= want got) (or got (not (apply may-go? span))))]
        (conj! out (if got
                     (str id " at " got ", its sentence at " want)
                     (str id " deleted though its sentence stays, at " want)))))
    ;; nodes over several words, not over a sentence, keep to their words
    (doseq [{:token/keys [id begin end]} tokens :when (#{:un :us} (first id))
            :let [n (by-id id)
                  wb (some #(when (= begin (:token/begin %)) (by-id (:token/id %))) words)
                  we (some #(when (= end (:token/end %)) (by-id (:token/id %))) words)]
            :when n]
      (when (and wb (not= (:token/begin wb) (:token/begin n)))
        (conj! out (str id " begins at " (:token/begin n) ", its first word at " (:token/begin wb))))
      (when (and we (not= (:token/end we) (:token/end n)))
        (conj! out (str id " ends at " (:token/end n) ", its last word at " (:token/end we)))))
    ;; a line typed before the first sentence (REV3 N1, REV4 R4 R5): the
    ;; new text before the first sentence's first letter left, when it holds
    ;; a letter before its last line break, is a sentence of its own
    (when-let [s0 (some #(when (zero? (:token/begin %)) %) sents)]
      (let [in-gap? (fn [i] (some #(and (<= (:start %) i) (< i (:end %))) server))
            q (first (filter #(and (not (ws? (aget o %))) (not (in-gap? %))) (range 0 (:token/end s0))))]
        (when q
          (let [p (+ q (reduce + 0 (map #(- (cp/cp-count (:value %)) (- (:end %) (:start %)))
                                        (filter #(or (< (:start %) q) (and (= (:start %) (:end %)) (<= (:start %) q))) server))))
                prefix (cp/cp-subs nb 0 p)
                m (last (re-seq #"[\s\S]*[\n\r\u0085\u2028\u2029]" prefix))
                k (some-> m cp/cp-count)
                want (when (and m (re-find #"\S" m)
                                ;; not over a word the edit kept (typed over)
                                (not-any? #(and (= :w (:token/layer %)) (< (:token/begin %) k)) (:tokens r)))
                       [0 k])
                got (some-> (first heads) ((juxt :token/begin :token/end)))]
            (when (not= want got)
              (conj! out (str "head " (pr-str got) ", want " (pr-str want) " for " (pr-str prefix))))))))
    (persistent! out)))

(deftest text-typed-where-two-sentences-meet-goes-to-the-next-past-the-whitespace
  ;; Luke (2026-10-15, superseding 2026-09-30), REV2 H1, REV3: text typed
  ;; after the whitespace between two sentences, anywhere in it, joins the
  ;; sentence after, and right after punctuation with no whitespace between
  ;; them too (between two letters, the one before). Right after a
  ;; sentence's last letter, the sentence before. Text holding a line break,
  ;; or with one between it and the next letter, leaves the boundary where
  ;; it was. Edits and a whole-body save alike. A line typed before the first
  ;; sentence is a sentence of its own. A segment over a sentence follows it,
  ;; and a node over several words keeps to them. Sentences never begin on
  ;; whitespace they did not have. Every other rule judged as ever.
  (let [opts {:carets 3 :spaced 0.3 :bound-early 0.5 :at-sentences true :sentence-segments true :nodes true
              :sentence-rows true :points 0.2 :lead " "
              :sentence-seps [" " "  " "\n" ". " " \n " "" "\n  "]
              :typed ["Q" "Oh " "XZ XZ " " Q" "  " "Q\nR" "\n" "-" "Q R" "Oh.\n"]}
        fails (atom [])]
    (dotimes [seed cases-per-config]
      (let [rng (java.util.Random. (+ seed 777))
            {:keys [body tokens]} (gen-doc rng opts)
            gaps (gen-gaps rng body tokens opts)
            ;; the start of the text too
            gaps (if (and (< (.nextDouble rng) 0.3) (seq gaps) (> (:start (first gaps)) 1))
                   (into [(nth [{:start 0 :end 0 :value "Oh "} {:start 0 :end 0 :value "Oh.\n"}
                                {:start 0 :end 0 :value "Oh.\nNew "} {:start 0 :end 0 :value "Q"}
                                {:start 0 :end 0 :value "\n"} {:start 0 :end 0 :value "  \n"}
                                ;; the same line with the first letter typed over
                                {:start 0 :end 1 :value "Oh.\nX"} {:start 0 :end 1 :value "Oh.\n"}]
                               (.nextInt rng 8))]
                         gaps)
                   gaps)
            o (cps body)
            sents (sort-by :token/begin (filter #(= :s (:token/layer %)) tokens))]
        (doseq [[rname ops] {:composed (ta/gap-ops gaps) :keys-left-to-right (keystrokes gaps false)}]
          (let [r (run body tokens ops)
                server (server-gaps body tokens ops :apps)
                ps (vec (remove #(re-find #"^\[:as " %) (problems body tokens server r)))
                nb (:text/body (:text r))
                ss (gap-fill (filterv #(= :s (:token/layer %)) (:tokens r)) (cp/cp-count nb))
                shift (fn [g] (reduce + 0 (map #(- (cp/cp-count (:value %)) (- (:end %) (:start %)))
                                               (take-while #(not= % g) server))))
                ps (into ps
                         (keep (fn [{a :start b :end v :value :as g}]
                                 (when-let [[x y L F] (and (= a b) (seq v) (pos? a) (< a (alength o))
                                                           (let [L (loop [i (dec a)] (cond (neg? i) nil (ws? (aget o i)) (recur (dec i)) :else i))
                                                                 F (loop [i a] (cond (>= i (alength o)) nil (ws? (aget o i)) (recur (inc i)) :else i))
                                                                 at (fn [i] (some #(when (and (<= (:token/begin %) i) (< i (:token/end %))) %) sents))
                                                                 x (some-> L at)
                                                                 y (some-> F at)]
                                                             ;; between two sentences, and any other change in
                                                             ;; the run only types there (FX-B-TEXT, REV-TEXT-2)
                                                             (when (and x y (not= x y)
                                                                        (every? #(and (= (:start %) (:end %)) (< L (:start %) (inc F)))
                                                                                (filter #(and (not= % g) (<= L (:end %)) (<= (:start %) (inc F))) server)))
                                                               [x y L F])))]
                                   ;; Luke (2026-10-15): text typed after the
                                   ;; whitespace between two sentences belongs to
                                   ;; the one after, typed right after the earlier
                                   ;; one's last letter to that one. With no
                                   ;; whitespace between, the one after. A line
                                   ;; typed, or a line break between the text and
                                   ;; the next letter, leaves the boundary where it
                                   ;; was.
                                   (let [lead-ws (count (take-while ws? (cps v)))
                                         brk? #(re-find #"[\n\r\u0085\u2028\u2029]" %)
                                         want (cond
                                                ;; between two letters, text holding a
                                                ;; space goes where the word rules put it
                                                (= a (inc L) F) (cond (brk? v) (:token/id x)
                                                                      (punct? (aget o L)) (:token/id y)
                                                                      (re-find #"\s" v) nil
                                                                      :else (:token/id x))
                                                (= a (inc L)) (:token/id x)
                                                ;; a line typed later in the run too
                                                (or (brk? v) (brk? (cp/cp-subs body a F))
                                                    (some #(and (<= a (:start %) F) (brk? (:value %))) server))
                                                (if (> a (:token/begin y)) (:token/id y) (:token/id x))
                                                :else (:token/id y))
                                         p (+ a (shift g) lead-ws)
                                         got (some #(when (and (<= (:token/begin %) p) (< p (:token/end %))) (:token/id %)) ss)]
                                     (when (and want (< lead-ws (cp/cp-count v)) (not= want got)
                                                ;; the sentence it should join is left
                                                (some #(= want (:token/id %)) (:tokens r)))
                                       (str "text typed at " a " went to " got ", not " want))))))
                         server)
                ps (into ps (follow-checks body tokens server r))]
            (when (seq ps) (swap! fails conj {:seed seed :reading rname :old body :gaps gaps :problems (take 3 ps)}))))))
    (is (empty? @fails) (str (count @fails) " " (pr-str (take 3 @fails))))))

(deftest a-row-over-a-one-word-sentence-typed-over-follows-the-sentence
  ;; REV-W2-TEXT N2, seed 2034 of the test above, past its default seeds: a
  ;; paste over `kai` (a sentence of one word, under a row over the whole
  ;; sentence) and into the next sentence types `kai` over as `Q`. The word
  ;; and its sentence go to `Q`, and the row follows the sentence edge by
  ;; edge to where the next one begins, over `Q\nR`. The judge read the row
  ;; as a word typed over, since its text is the word's, where a row over a
  ;; sentence follows it as the other rows do.
  (let [body "ə́múk   su  dog\n  kai  thee da\t你好 a café"
        tokens (vec (for [[id layer begin end] [[[:s 0] :s 0 18] [[:s 1] :s 18 21] [[:s 2] :s 21 40]
                                                [[:rw 0] :rw 0 18] [[:rw 1] :rw 18 21] [[:rw 2] :rw 21 40]
                                                [[:w 1] :w 0 10] [[:w 2] :w 12 15] [[:w 3] :w 18 21] [[:w 4] :w 23 30]
                                                [[:w 5] :w 31 33] [[:w 6] :w 34 35] [[:w 7] :w 36 40]]]
                      {:token/id id :token/layer layer :token/begin begin :token/end end}))
        ops (ta/gap-ops [{:start 18 :end 35 :value "Q\nR"}])
        server (server-gaps body tokens ops :apps)
        r (run body tokens ops)
        at (fn [id] (some #(when (= id (:token/id %)) [(:token/begin %) (:token/end %)]) (:tokens r)))]
    (is (= [18 19] (at [:w 3])))
    (is (= [18 19] (at [:s 1])))
    (is (= [18 21] (at [:rw 1])))
    (is (= [21 26] (at [:rw 2])))
    (is (empty? (problems body tokens server r)))
    (is (empty? (follow-checks body tokens server r)))
    ;; and a product that deleted the row, or a segment over the sentence,
    ;; while its sentence stays fails the follow checks (REV-W2-LAST F1)
    (let [without (fn [r id] (-> r
                                 (update :tokens (fn [ts] (vec (remove #(= id (:token/id %)) ts))))
                                 (update :deleted (fnil conj []) id)))
          tokens' (into tokens (for [[id begin end] [[[:as 0] 0 15] [[:as 1] 18 21] [[:as 2] 23 40]]]
                                 {:token/id id :token/layer :ss :token/begin begin :token/end end}))
          server' (server-gaps body tokens' ops :apps)
          r' (run body tokens' ops)]
      (is (= ["[:rw 1] deleted though its sentence stays, at [18 21]"]
             (follow-checks body tokens server (without r [:rw 1]))))
      (is (empty? (follow-checks body tokens' server' r')))
      (is (= ["[:as 1] deleted though its sentence stays, at [18 21]"]
             (follow-checks body tokens' server' (without r' [:as 1])))))))

(deftest a-row-or-segment-typed-over-whole-and-kept-may-not-go
  ;; REV-BH7-TEXT F5, seed 329 of the test above with rows and segments: the
  ;; one sentence, its row and its segment are typed over whole as ` Q`, so
  ;; the rule keeps each of them, on `Q`, while every word goes. The plain
  ;; rule deletes only a token with no letter left and no letter typed inside
  ;; it, so a product that deleted the row or the segment here fails the
  ;; follow checks, though no word under either is kept.
  (let [body "caf\u00e9 thee da\ta"
        tokens (vec (for [[id layer begin end] [[[:s 0] :s 0 14] [[:rw 0] :rw 0 14] [[:as 0] :ss 0 14]
                                                [[:w 1] :w 0 4] [[:w 2] :w 5 12] [[:w 3] :w 13 14]]]
                      {:token/id id :token/layer layer :token/begin begin :token/end end}))
        ops (ta/gap-ops [{:start 0 :end 14 :value " Q"}])
        server (server-gaps body tokens ops :apps)
        r (run body tokens ops)
        at (fn [id] (some #(when (= id (:token/id %)) [(:token/begin %) (:token/end %)]) (:tokens r)))
        without (fn [r id] (-> r
                               (update :tokens (fn [ts] (vec (remove #(= id (:token/id %)) ts))))
                               (update :deleted (fnil conj []) id)))]
    (is (= [1 2] (at [:s 0]) (at [:rw 0]) (at [:as 0])))
    (is (nil? (at [:w 1])))
    (is (empty? (follow-checks body tokens server r)))
    (is (= ["[:as 0] deleted though its sentence stays, at [1 2]"]
           (follow-checks body tokens server (without r [:as 0]))))
    (is (= ["[:rw 0] deleted though its sentence stays, at [1 2]"]
           (follow-checks body tokens server (without r [:rw 0]))))))

;; ---------------------------------------------------------------- the side the caret is on

(deftest text-typed-where-two-words-meet-goes-to-the-side-it-says
  ;; REV2 M2, REV3 N6 N7: letters typed where two words meet with no space,
  ;; the insert saying `side`, go into the word on that side, with what hangs
  ;; off it and its sentence; with no side, into the word before, or where a
  ;; sentence begins after punctuation, the word after (Luke, 2026-10-15). A side
  ;; where the words do not meet counts for nothing. Every other rule judged
  ;; as ever.
  (let [opts {:carets 3 :spaced 0.2 :glue 0.6 :points 0.2}
        fails (atom [])]
    (dotimes [seed cases-per-config]
      (let [rng (java.util.Random. (+ seed 99))
            {:keys [body tokens]} (gen-doc rng opts)
            o (cps body)
            words (sort-by :token/begin (filter #(= :w (:token/layer %)) tokens))
            meets (vec (keep (fn [[x y]] (when (= (:token/end x) (:token/begin y)) [x y])) (partition 2 1 words)))
            apart (vec (keep (fn [[x y]] (when (< (:token/end x) (:token/begin y)) [x y])) (partition 2 1 words)))
            glued? (and (seq meets) (or (empty? apart) (< (.nextDouble rng) 0.7)))]
        (when (or (seq meets) (seq apart))
          (let [[x y] (if glued? (nth meets (.nextInt rng (count meets))) (nth apart (.nextInt rng (count apart))))
                a (if (or glued? (.nextBoolean rng)) (:token/begin y) (:token/end x))
                side (nth [nil "before" "after"] (.nextInt rng 3))
                v (nth ["Q" "XZ" "Ж𐍂" "x " "x y"] (.nextInt rng 5))
                op (cond-> {:type :insert :index a :value v} side (assoc :side side))
                r (run body tokens [op])
                r0 (run body tokens [(dissoc op :side)])
                ;; with no side, where a sentence begins the one after
                ;; (Luke, 2026-10-15)
                eff (when glued? (or side (when (and (punct? (aget o (dec a)))
                                                     (some #(and (= :s (:token/layer %)) (= a (:token/begin %))) tokens))
                                            "after")))
                ;; the part of sided text away from its side belongs to
                ;; the side's row, not to the word it touches
                ps (vec (cond->> (problems body tokens [(cond-> {:start a :end a :value v} side (assoc :side (keyword side)))] r)
                          eff (remove #(re-find #"joined to a word is in none" %))))
                at (fn [id] (some #(when (= id (:token/id %)) %) (:tokens r)))
                ext (fn [res] (set (map (juxt :token/id :token/begin :token/end) (:tokens res))))
                ps (cond-> ps
                     (and (not eff) (not= (ext r) (ext r0)))
                     (conj (str "side " side " where the words do not meet changed the outcome")))
                ps (if (and glued? (not (re-find #"\s" v)))
                     (let [want (if (= eff "after") (:token/id y) (:token/id x))
                           got (some #(when (and (<= (:token/begin %) a) (< a (:token/end %)) (= :w (:token/layer %))) (:token/id %)) (:tokens r))]
                       (cond-> ps (not= want got) (conj (str "typed " (pr-str v) " side " side " went to " got ", not " want))))
                     ps)
                ;; the typed text's first letter is in the sentence of the side's word
                ps (if glued?
                     (let [nb (:text/body (:text r))
                           ss (gap-fill (filterv #(= :s (:token/layer %)) (:tokens r)) (cp/cp-count nb))
                           sent-of (fn [p] (some #(when (and (<= (:token/begin %) p) (< p (:token/end %))) (:token/id %)) ss))
                           w (at (if (= eff "after") (:token/id y) (:token/id x)))]
                       (cond-> ps
                         (and w (not= (sent-of a) (sent-of (:token/begin w))))
                         (conj (str "typed " (pr-str v) " side " side " is in sentence " (sent-of a) ", its word in " (sent-of (:token/begin w))))))
                     ps)
                ps (cond-> ps (some #(not= ((juxt :token/begin :token/end) (at (:token/id %)))
                                           ((juxt :token/begin :token/end) (at [:w (second (:token/id %))])))
                                    (filter #(= :m (:token/layer %)) tokens))
                           (conj "a morpheme off its word"))]
            (when (seq ps) (swap! fails conj {:seed seed :old body :op op :problems (take 3 ps)}))))))
    (is (empty? @fails) (str (count @fails) " " (pr-str (take 3 @fails))))))
