(ns plaid.algos.row-follow-oracle-test
  "A seeded property test of where the rows go when a text is edited: the
  tokens of a layer that forbids overlap beside the words (time-alignment
  segments), over sentences with or without their whitespace, over several
  sentences, inside one, or cut anywhere (FX-D-TEXT, after REV3-TEXT). Each
  case is one to three changes near the sentence boundaries, judged on the
  edits path and on a whole-body save, with and without `splitOnSpace` on
  the words, against the gaps the server reads the change as. A sentence is
  read as it is stored, after the partition's gap-fill (FX-E-TEXT). The
  invariant, for every row layer:
  1. no edit of a text whose rows did not overlap makes them overlap (so the
     save never answers 409),
  2. text typed strictly inside a row stays in that row, but for whitespace
     at an edge that was on a letter (the plain rule moves the edge off it)
     and a line typed at the start that becomes a sentence of its own (every
     token reaching over it leaves it). Text typed in the whitespace where a
     row over whole sentences meets a sentence boundary counts as typed at
     the boundary: it is in the row exactly when it is in one of the
     sentences the row reaches (FX-E-TEXT, REV4-TEXT-1), unless the save
     deletes every sentence the row holds whole. Where a row's end sits in
     the whitespace before a sentence's first letter and the next row
     follows that sentence (begins on its boundary and holds it whole),
     text typed in that whitespace that the sentence takes is in the next
     row, not this one: the sentence wins the crossing (FX-F-TEXT,
     REV5-TEXT-1), unless no letter of the row is left. The mirror: where
     a row's begin sits in the whitespace after a sentence's last letter and
     the row before follows that sentence (ends on its boundary and holds it
     whole), text typed in that whitespace that the sentence takes is in the
     row before (FX-G-TEXT, REV6-TEXT-2), unless no letter of the row is
     left,
  3. text typed where a row's edge meets a sentence boundary (a sentence's
     begin or first letter, its end or the end of its last letter) goes
     with the sentence the partition rule chooses, and the row on that
     sentence's side holds it,
  4. a row edge not on a sentence boundary stays where it was, among the
     text a gap typed there, or moved off whitespace onto the row's text,
     or, at an end the sentence after it wins in (2), where the next row
     now begins, and at a begin the sentence before wins in (2), where the
     row before now ends,
  5. an old letter left stays in the row it was in, and in no other."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [plaid.algos.text :as ta]))

(defn- cps [^String s] (.toArray (.codePoints s)))

(defn- ws? [c] (#'ta/space? c))

(defn- trim-ws [^ints cs [b e]]
  (let [b (loop [x b] (if (and (< x e) (ws? (aget cs x))) (recur (inc x)) x))
        e (loop [x e] (if (and (> x b) (ws? (aget cs (dec x)))) (recur (dec x)) x))]
    [b e]))

(def ^:private opts {:children #{:m} :exclusive #{:w :r}})

(defn- gap-fill
  "The sentences of `r` as the save stores them: each to the next one's
  begin, the first from 0 (or the line made a sentence of its own, `-1`),
  the last to the end of the text."
  [r n]
  (let [ss (sort-by first (concat (map (fn [h] [(:token/begin h) (:token/end h) -1]) (:heads r))
                                  (keep (fn [t] (when (= :s (:token/layer t)) [(:token/begin t) (:token/end t) (second (:token/id t))]))
                                        (:tokens r))))
        c (count ss)]
    (map-indexed (fn [i [b e id]] [(if (zero? i) 0 b) (if (= i (dec c)) n (max e (first (nth ss (inc i))))) id]) ss)))

(defn- tokens-of [{:keys [sents words rows]}]
  (-> []
      (into (map-indexed (fn [i [b e]] {:token/id [:s i] :token/layer :s :token/begin b :token/end e}) sents))
      (into (map-indexed (fn [i [b e]] {:token/id [:r i] :token/layer :r :token/begin b :token/end e}) rows))
      (into (mapcat (fn [i [b e]] [{:token/id [:w i] :token/layer :w :token/begin b :token/end e}
                                   {:token/id [:m i] :token/layer :m :token/begin b :token/end e}])
                    (range) words))))

(defn run-case
  "`{:gaps :r}`: the gaps the server reads case `c`'s change as on `path`
  (`:edits` or `:body`) and what the plain rule makes of them."
  [{:keys [o gaps sos] :as c} path]
  (let [tokens (tokens-of c)
        ops (ta/gap-ops gaps)
        opts (cond-> opts sos (assoc :split-on-space true))]
    (if (= path :edits)
      (let [used (ta/plain-edit-gaps o ops tokens #{:s} #{:w} opts)]
        {:gaps used :r (ta/apply-plain-gaps o tokens used #{:s} #{:w} opts)})
      (let [[used r] (ta/plain-body-read o (ta/edit-ops-body ops o) tokens #{:s} #{:w} opts)]
        {:gaps used :r r}))))

(defn violations
  "What breaks the invariant (see the ns doc) in case `c` on `path`."
  [{:keys [o sents rows] :as c} path]
  (let [{gaps :gaps r :r} (try (run-case c path) (catch Throwable e {:error (.getMessage e)}))]
    (if-not r
      [[0 (str "error " (pr-str (:error (run-case c path))))]]
      (let [oc (cps o)
            nb (:text/body (:text r))
            nc (cps nb)
            gaps (vec (sort-by (juxt :start :end) gaps))
            vlen (fn [g] (alength (cps (:value g))))
            ;; each gap's new begin
            new-at (vec (reductions (fn [at [g h]] (+ at (vlen g) (- (:start h) (:end g))))
                                    (:start (first gaps)) (partition 2 1 gaps)))
            ;; the new place of the old letter at x left by the gaps
            pm (fn [x] (+ x (reduce + 0 (map #(- (vlen %) (- (:end %) (:start %)))
                                             (filter #(<= (:end %) x) gaps)))))
            gone? (fn [x] (some #(and (<= (:start %) x) (< x (:end %))) gaps))
            new-rows (into {} (keep (fn [t] (when (= :r (:token/layer t)) [(second (:token/id t)) [(:token/begin t) (:token/end t)]])))
                           (:tokens r))
            ;; the sentence new position p is in, as stored
            filled (gap-fill r (alength nc))
            sentence-at (fn [p] (some (fn [[b e id]] (when (and (<= b p) (< p e)) id)) filled))
            ;; old sentence boundaries: begins (with and without whitespace)
            ;; and ends, each naming its sentence
            sb (into {} (mapcat (fn [i [b e]] (let [[x y] (trim-ws oc [b e])] (cond-> [[b i]] (< x y) (conj [x i])))) (range) sents))
            se (into {} (mapcat (fn [i [b e]] (let [[x y] (trim-ws oc [b e])] (cond-> [[e i]] (< x y) (conj [y i])))) (range) sents))
            ;; the old sentences each row reaches (any of their text), and
            ;; those it holds whole (by their letters, or all of a sentence
            ;; with none)
            sent-span (fn [[b e]] (let [[x y] (trim-ws oc [b e])] (if (< x y) [x y] [b e])))
            reaches (fn [i] (let [[b e] (rows i)]
                              (into #{} (keep-indexed (fn [k [x y]] (when (and (< x e) (< b y)) k))) sents)))
            ;; (a row whose sentences the save all deleted follows none, and
            ;; keeps what is typed inside it by (2))
            live-sents (into #{} (keep (fn [t] (when (= :s (:token/layer t)) (second (:token/id t))))) (:tokens r))
            whole (fn [i] (let [[b e] (rows i)
                                ks (filter (fn [k] (let [[x y] (sent-span (sents k))] (and (<= b x) (<= y e)))) (range (count sents)))]
                            (if (some live-sents ks) ks [])))
            ;; a gap in the whitespace between a row's letters and an edge of
            ;; it on a boundary of a sentence it holds whole
            boundary-ws? (fn [i a z]
                           (let [[b e] (rows i)
                                 [lb le] (trim-ws oc [b e])
                                 ws (whole i)
                                 wb (some (fn [k] (contains? (hash-set (first (sents k)) (first (trim-ws oc (sents k)))) b)) ws)
                                 we (some (fn [k] (contains? (hash-set (second (sents k)) (second (trim-ws oc (sents k)))) e)) ws)]
                             ;; (all of a row of only whitespace)
                             (boolean (if (< lb le)
                                        (or (and wb (<= a lb)) (and we (>= z le)))
                                        (or wb we)))))
            ;; where row i's end sits in the whitespace before a sentence's
            ;; first letter and the next row follows that sentence:
            ;; `[next-row sentence]`
            crossing (fn [i]
                       (let [[b e] (rows i)
                             x (loop [x e] (if (and (< x (alength oc)) (ws? (aget oc x))) (recur (inc x)) x))
                             j (some (fn [k] (when (= x (first (trim-ws oc (sents k)))) k)) (range (count sents)))
                             nx (first (sort-by (comp first rows) (filter #(<= e (first (rows %)) x) (range (count rows)))))]
                         (when (and (pos? e) (< b e) (ws? (aget oc (dec e))) j nx
                                    (= j (sb (first (rows nx))))
                                    (some #{j} (whole nx)))
                           [nx j])))
            crossing-ws? (fn [i a]
                           (let [[b e] (rows i)]
                             ;; (a row with no letter left keeps what is
                             ;; typed in it, as it would be left empty)
                             (and (crossing i) (< a e)
                                  (every? #(ws? (aget oc %)) (range a e))
                                  (some #(and (not (ws? (aget oc %))) (not (gone? %))) (range b e)))))
            ;; the mirror: where row i's begin sits in the whitespace after
            ;; a sentence's last letter and the row before follows that
            ;; sentence (ends on its boundary and holds it whole):
            ;; `[row-before sentence]`
            mirror (fn [i]
                     (let [[b e] (rows i)
                           y (loop [y b] (if (and (pos? y) (ws? (aget oc (dec y)))) (recur (dec y)) y))
                           j (some (fn [k] (let [[x z] (trim-ws oc (sents k))] (when (and (< x z) (= y z)) k))) (range (count sents)))
                           pv (last (sort-by (comp second rows) (filter #(<= y (second (rows %)) b) (range (count rows)))))]
                       (when (and (< b e) (< b (alength oc)) (ws? (aget oc b)) j pv
                                  (= j (se (second (rows pv))))
                                  (some #{j} (whole pv)))
                         [pv j])))
            mirror-ws? (fn [i a]
                         (let [[b e] (rows i)]
                           ;; (a row with no letter left keeps what is
                           ;; typed in it)
                           (and (mirror i) (< b a)
                                (every? #(ws? (aget oc %)) (range b a))
                                (some #(and (not (ws? (aget oc %))) (not (gone? %))) (range b e)))))
            out (transient [])
            v! (fn [k msg] (conj! out [k msg]))]
        ;; 1. no overlap
        ;; (with the rows a save makes, as the save writes them beside the
        ;; others)
        (let [rs (sort (into (vec (vals new-rows))
                             (keep (fn [t] (when (= :r (:token/layer t)) [(:token/begin t) (:token/end t)])))
                             (:made r)))]
          (doseq [[b e] rs :when (>= b e)] (v! 1 (str "empty row " [b e])))
          (doseq [[[_ e] [b _]] (partition 2 1 rs) :when (> e b)] (v! 1 (str "rows overlap " (vec rs)))))
        (doseq [[i [b e]] (map-indexed vector rows)
                :let [[nb* ne*] (new-rows i)]
                :when nb*]
          ;; 2. text typed strictly inside, but for the whitespace where a
          ;; row over whole sentences meets a sentence boundary, where text
          ;; is in the row exactly when it is in a sentence the row reaches
          (doseq [[gi {a :start z :end :as g}] (map-indexed vector gaps)
                  :when (and (< b a) (if (= a z) (< a e) (< z e)) (pos? (vlen g)))
                  :when (not (boundary-ws? i a z))
                  :let [x (new-at gi)
                        [nx j] (when (crossing-ws? i a) (crossing i))
                        [pv pj] (when (mirror-ws? i a) (mirror i))
                        ;; whitespace at an edge on a letter before is moved off
                        ;; (and a line made a sentence of its own at the
                        ;; start, which every token reaching over it leaves)
                        out (remove (fn [p] (or (cond
                                                  nx (if (= j (sentence-at p))
                                                       (or (ws? (aget nc p)) (let [[x y] (new-rows nx)] (and x (<= x p) (< p y))))
                                                       (<= nb* p (dec ne*)))
                                                  pv (if (= pj (sentence-at p))
                                                       (or (ws? (aget nc p)) (let [[x y] (new-rows pv)] (and x (<= x p) (< p y))))
                                                       (<= nb* p (dec ne*)))
                                                  :else (<= nb* p (dec ne*)))
                                                (= -1 (sentence-at p))
                                                (and (< p nb*) (not (ws? (aget oc b))) (every? #(ws? (aget nc %)) (range p nb*)))
                                                (and (>= p ne*) (not (ws? (aget oc (dec e)))) (every? #(ws? (aget nc %)) (range ne* (inc p))))))
                                    (range x (+ x (vlen g))))]
                  :when (seq out)]
            (v! 2 (str "row " i " " [b e] "->" [nb* ne*] " left out " (pr-str (:value g)) " typed inside at " a)))
          (doseq [[gi {a :start z :end :as g}] (map-indexed vector gaps)
                  :when (and (< b a) (if (= a z) (< a e) (< z e)) (pos? (vlen g)) (boundary-ws? i a z))
                  :let [x (new-at gi) vc (cps (:value g)) reach (reaches i)]
                  k (range (alength vc))
                  :let [j (sentence-at (+ x k))]
                  :when (and (not (ws? (aget vc k))) (not= -1 j)
                             (not= (contains? reach j) (and (<= nb* (+ x k)) (< (+ x k) ne*))))]
            (v! 2 (str "row " i " " [b e] "->" [nb* ne*] " " (pr-str (:value g)) " typed at " a
                       " in the whitespace at a sentence boundary, in sentence " j ", reaches " (sort reach))))
          ;; 3. text typed where an edge meets a sentence boundary
          (doseq [[gi {a :start z :end :as g}] (map-indexed vector gaps)
                  :when (= a z)
                  [edge j] [[:begin (when (= a b) (sb a))] [:end (when (= a e) (se a))]]
                  :when j
                  :let [x (new-at gi)
                        vc (cps (:value g))]
                  k (range (alength vc))
                  :when (and (not (ws? (aget vc k))) (= j (sentence-at (+ x k))))
                  :when (not (and (<= nb* (+ x k)) (< (+ x k) ne*)))]
            (v! 3 (str "row " i " " [b e] "->" [nb* ne*] " " (name edge) " at sentence " j
                       " left out " (pr-str (:value g)) " that sentence took")))
          ;; 4. an edge off the boundaries stays put
          (doseq [[edge p q] [[:begin b nb*] [:end e ne*]]
                  :when (not ((if (= edge :begin) sb se) p))
                  :let [at (keep-indexed (fn [gi {a :start z :end :as g}] (when (<= a p z) [(new-at gi) (+ (new-at gi) (vlen g))])) gaps)
                        lo (if (seq at) (reduce min (map first at)) (pm p))
                        hi (if (seq at) (reduce max (map second at)) (pm p))
                        ok? (or (<= lo q hi)
                                (and (= edge :end) (crossing i) (= q (first (new-rows (first (crossing i))))))
                                (and (= edge :begin) (mirror i) (= q (second (new-rows (first (mirror i))))))
                                (and (= edge :begin) (> q hi) (every? #(ws? (aget nc %)) (range hi q)))
                                (and (= edge :end) (< q lo) (every? #(ws? (aget nc %)) (range q lo))))]
                  :when (not ok?)]
            (v! 4 (str "row " i " " [b e] "->" [nb* ne*] " " (name edge) " off a boundary moved to " q ", not in " [lo hi]))))
        ;; 5. old letters stay in their rows
        (doseq [x (range (alength oc))
                :when (and (not (ws? (aget oc x))) (not (gone? x)))
                :let [was (some (fn [[i [b e]]] (when (and (<= b x) (< x e)) i)) (map-indexed vector rows))
                      p (pm x)
                      now (some (fn [[i [b e]]] (when (and (<= b p) (< p e)) i)) new-rows)]
                :when (and (not= was now) (or (nil? was) (new-rows was)))]
          (v! 5 (str "old letter at " x " was in row " was ", now in row " now)))
        (persistent! out)))))

;; ---------------------------------------------------------------- cases

(def ^:private seps [" " "  " "   " "\n" "\n " "\t\n" " \n" "\n\n" "　　" "\r\n" "  \n  " " \t " "  \n"])
(def ^:private last-seps ["" "" " " "  " "\n"])
(def ^:private typed-vals ["X" "X " "So " "Y Z" "Q." "Q.\n" "\nX" "X\n" " X" "XY"])
(def shapes [:full :trim :mixed :midws :span :span-trim :short :midws-begin :random :part-ws :ws-begin])

(defn gen-case
  "A case as REV3-TEXT's generator made them: two to four sentences, with
  whitespace between them (some of only whitespace), words (none in a
  fifth of them), rows of one of `shapes`, and one to three changes near
  the sentence boundaries."
  [^java.util.Random rng]
  (let [pick #(nth % (.nextInt rng (count %)))
        rint (fn [a b] (+ a (.nextInt rng (inc (- b a)))))
        word #(apply str (repeatedly (rint 1 4) (fn [] (pick "abcdefgh"))))
        ns (rint 2 4)
        [body sents words]
        (reduce (fn [[body sents words] i]
                  (let [b (count body)]
                    (if (and (< (.nextDouble rng) 0.08) (< 0 i (dec ns)))
                      (let [body (str body (pick [" " "  " "\n"]))] [body (conj sents [b (count body)]) words])
                      (let [[body words] (reduce (fn [[body words] j]
                                                   (let [body (if (pos? j) (str body " ") body)
                                                         w (word)]
                                                     [(str body w) (conj words [(count body) (+ (count body) (count w))])]))
                                                 [body words] (range (rint 1 3)))
                            body (str body (pick ["." "." "?" ".\"" ""]))
                            body (str body (if (< i (dec ns)) (pick seps) (pick last-seps)))]
                        [body (conj sents [b (count body)]) words]))))
                ["" [] []] (range ns))
        oc (cps body)
        tr #(trim-ws oc %)
        real (filterv #(apply < (tr %)) sents)
        shape (pick shapes)
        rows (case shape
               :full sents
               :trim (mapv tr real)
               :mixed (vec (keep #(case (pick [:full :trim :none]) :full % :trim (when (apply < (tr %)) (tr %)) nil) sents))
               (:midws :midws-begin)
               (let [rows (mapv (fn [[_ e :as s]]
                                  (let [[tb te] (tr s) w (- e te)]
                                    (if (= shape :midws)
                                      (if (>= w 2) [tb (+ te (rint 1 (dec w)))] [tb (pick [te e])])
                                      [tb e])))
                                real)]
                 (if (= shape :midws)
                   rows
                   (reduce (fn [rows i]
                             (let [[pb pe] (rows (dec i)) [tb te] (rows i) [_ pte] (tr [pb pe])]
                               (if (>= (- tb pte) 2)
                                 (-> rows (assoc (dec i) [pb pte]) (assoc i [(rint (inc pte) (dec tb)) te]))
                                 rows)))
                           rows (range 1 (count rows)))))
               (:span :span-trim)
               (loop [i 0 out []]
                 (if (< i (count sents))
                   (let [k (rint 1 3) grp (subvec sents i (min (count sents) (+ i k)))
                         [b e] [(first (first grp)) (second (peek grp))]
                         [b e] (if (= shape :span-trim) (tr [b e]) [b e])]
                     (recur (+ i k) (if (< b e) (conj out [b e]) out)))
                   out))
               :short (vec (keep (fn [[sb se]]
                                   (let [ws (filterv (fn [[b e]] (and (<= sb b) (<= e se))) words)]
                                     (when (seq ws)
                                       (let [a (.nextInt rng (count ws)) z (rint a (dec (count ws)))]
                                         [(first (ws a)) (second (ws z))]))))
                                 real))
               ;; rows over the last words of a sentence and the whitespace
               ;; after it, beside rows over whole sentences (REV5-TEXT-1)
               :part-ws (vec (keep (fn [[sb se :as s]]
                                     (let [ws (filterv (fn [[b e]] (and (<= sb b) (<= e se))) words)]
                                       (if (and (seq ws) (< (.nextDouble rng) 0.5))
                                         [(first (ws (.nextInt rng (count ws)))) se]
                                         s)))
                                   sents))
;; rows beginning in the whitespace after the sentence before,
               ;; over all or part of their sentence, beside rows over whole
               ;; sentences (REV6-TEXT-2)
               :ws-begin (let [rs (mapv tr real)]
                           (vec (map-indexed (fn [i [tb te :as r]]
                                               (if (and (pos? i) (< (.nextDouble rng) 0.6))
                                                 (let [[_ pte] (rs (dec i))
                                                       ws (filterv (fn [[b e]] (and (<= tb b) (<= e te))) words)
                                                       b (if (< (inc pte) tb) (rint (inc pte) (dec tb)) tb)
                                                       e (if (and (seq ws) (< (.nextDouble rng) 0.5)) (second (ws (.nextInt rng (count ws)))) te)]
                                                   [b e])
                                                 r))
                                             rs)))
               :random (let [cuts (vec (sort (distinct (repeatedly (rint 2 6) #(.nextInt rng (inc (count body)))))))]
                         (vec (keep (fn [[a b]] (when (< (.nextDouble rng) 0.7) [a b])) (partition 2 1 cuts)))))
        rows (filterv (fn [[b e]] (< b e)) rows)
        spots (vec (sort (distinct (filter #(<= 0 % (count body))
                                           (mapcat (fn [[b e :as s]] (let [[_ te] (tr s)] (cons b (range (dec te) (inc e))))) sents)))))
        gaps (reduce (fn [out _]
                       (let [a (pick spots) kind (.nextDouble rng)
                             g (cond (< kind 0.7) {:start a :end a :value (pick typed-vals)}
                                     (and (< kind 0.85) (< a (count body))) {:start a :end (inc a) :value ""}
                                     (< a (count body)) {:start a :end (inc a) :value (pick ["X" " " "\t" "X "])})]
                         (if (and g (not-any? (fn [u] (or (not (or (<= (:end g) (:start u)) (<= (:end u) (:start g))))
                                                          (and (= (:start g) (:end g)) (<= (:start u) (:start g) (:end u)))
                                                          (and (= (:start u) (:end u)) (<= (:start g) (:start u) (:end g)))))
                                              out))
                           (conj out g)
                           out)))
                     [] (range (rint 1 3)))]
    (let [;; ud's words, which a typed space splits
          sos (< (.nextDouble rng) 0.3)
          ;; a text not tokenized yet (a transcript typed on the Media tab
          ;; in a script without spaces), where the rows decide in the
          ;; words' place (REV6-TEXT-1)
          words (if (< (.nextDouble rng) 0.2) [] words)]
      {:o body :sents sents :words words :rows rows :shape shape :gaps (vec (sort-by (juxt :start :end) gaps))
       :sos sos})))

(defn sweep
  "`{[path invariant shape] count}` and the first few failing cases, over
  `cases`."
  [cases]
  (reduce (fn [acc c]
            (reduce (fn [acc path]
                      (let [vs (violations c path)]
                        (reduce (fn [acc [k msg]]
                                  (-> acc
                                      (update-in [:counts [path k (:shape c)]] (fnil inc 0))
                                      (update :examples #(if (< (count %) 12) (conj % {:path path :msg msg :case c}) %))))
                                acc (distinct (map (fn [[k m]] [k (if (#{1} k) "overlap" m)]) vs)))))
                    (update acc :cases inc) [:edits :body]))
          {:cases 0 :counts {} :examples []} cases))

(defn read-cases
  "The cases of a JSON-lines file as REV3-TEXT's scripts wrote them."
  [path]
  (with-open [rd (io/reader path)]
    (vec (for [line (line-seq rd) :when (not (str/blank? line))
               :let [m (json/read-str line :key-fn keyword)]]
           (-> m
               (update :gaps #(mapv (fn [g] (select-keys g [:start :end :value])) %))
               (update :shape (fn [s] (if (string? s) (keyword (first (str/split s #" "))) s))))))))

(def ^:private sweep-size
  (or (some-> (System/getenv "PLAID_ROW_SWEEP") parse-long) 3000))

(deftest rows-follow-sentences-and-keep-what-is-typed-inside-them
  (let [rng (java.util.Random. 20261016)
        {:keys [counts examples]} (sweep (repeatedly sweep-size #(gen-case rng)))]
    (is (empty? counts) (str (pr-str counts) "\n" (str/join "\n" (map pr-str (take 4 examples)))))))

(deftest the-rows-review-shapes
  (testing "REV3-TEXT-1: a row ending mid-whitespace beside one beginning there, any edit"
    (doseq [[o sents rows at] [["Ab.\n Cd. Ef." [[0 5] [5 9] [9 12]] [[0 4] [4 7]] 10]
                               ["Ab.\n Cd. Ef." [[0 5] [5 9] [9 12]] [[0 4] [4 11]] 1]
                               ["Ab.  Cd. Ef." [[0 5] [5 9] [9 12]] [[0 4] [4 7]] 10]
                               ["Ab.  Cd. Ef." [[0 5] [5 9] [9 12]] [[0 4] [4 11]] 10]]
            path [:edits :body]
            :let [c {:o o :sents sents :words [[0 2] [5 7] [9 11]] :rows rows :gaps [{:start at :end at :value "X"}]}
                  {r :r} (run-case c path)]]
      (is (empty? (violations c path)) (pr-str o rows path))
      (is (= (map (fn [[b e]] (if (< at e) [(cond-> b (> b at) inc) (inc e)] [b e])) rows)
             (sort (keep #(when (= :r (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r))))
          "the rows do not move")))
  (testing "REV3-TEXT-2: text typed inside a row is in a row (FX-E-TEXT: the one over the sentence that takes it)"
    (doseq [[o sents rows want] [["Ab.  Cd. Ef." [[0 5] [5 9] [9 12]] [[0 5] [5 12]] [[0 4] [4 13]]]
                                 ["Ab.  Cd." [[0 4] [4 5] [5 8]] [[0 5] [5 8]] [[0 6] [6 9]]]]
            path [:edits :body]
            :let [c {:o o :sents sents :words [[0 2] [5 7]] :rows rows :gaps [{:start 4 :end 4 :value "X"}]}
                  {r :r} (run-case c path)]]
      (is (empty? (violations c path)) (pr-str o rows path))
      (is (= want (sort (keep #(when (= :r (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r)))))))
  (testing "REV3-TEXT-3: a row over two sentences takes text typed at its start"
    (doseq [[rows want] [[[[0 3] [4 11]] [[0 3] [4 14]]]
                         [[[0 4] [4 11]] [[0 4] [4 14]]]]
            path [:edits :body]
            :let [c {:o "Ab.\nCd. Ef." :sents [[0 4] [4 8] [8 11]] :words [[0 2] [4 6] [8 10]] :rows rows
                     :gaps [{:start 4 :end 4 :value "So "}]}
                  {r :r} (run-case c path)]]
      (is (empty? (violations c path)) (pr-str rows path))
      (is (= want (sort (keep #(when (= :r (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r)))))))
  (let [rows-of (fn [r] (sort (keep #(when (= :r (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r))))]
    (testing "REV4-TEXT-1: a row over whole sentences follows the sentence that takes text typed in its whitespace"
      (doseq [[o sents rows at v want] [["Hi.  The end." [[0 5] [5 13]] [[0 5] [5 13]] 4 "So" [[0 4] [4 15]]]
                                        ["Hi.   The end." [[0 6] [6 14]] [[0 6] [6 14]] 4 "So" [[0 4] [4 16]]]
                                        ["Hi.   The end." [[0 6] [6 14]] [[0 6] [6 14]] 5 "So" [[0 5] [5 16]]]
                                        ["Hi.  The end." [[0 5] [5 13]] [[0 5] [5 13]] 4 "So " [[0 4] [4 16]]]
                                        ["Hi.  The end." [[0 5] [5 13]] [[0 3] [5 13]] 4 "So" [[0 3] [4 15]]]]
              path [:edits :body]
              :let [c {:o o :sents sents :words [[0 3] [5 8] [9 13]] :rows rows :gaps [{:start at :end at :value v}]}
                    {r :r} (run-case c path)]]
        (is (empty? (violations c path)) (pr-str o rows at path))
        (is (= want (rows-of r)) (pr-str o rows at path))))
    (testing "REV5-TEXT-1: the next row follows its sentence over text typed in a row's trailing whitespace"
      (doseq [[o sents words rows at v want] [["Hi.   The end." [[0 6] [6 14]] [[0 3] [6 9] [10 14]] [[0 5] [6 14]] 4 "So" [[0 4] [4 16]]]
                                              ["Ab cd.   Ef gh." [[0 9] [9 15]] [[0 2] [3 6] [9 11] [12 15]] [[3 9] [9 15]] 7 "So" [[3 7] [7 17]]]
                                              ["Ab cd.\n Ef gh." [[0 8] [8 14]] [[0 2] [3 6] [8 10] [11 14]] [[3 8] [8 14]] 7 "So" [[3 7] [7 16]]]
                                              ;; a typed line, which the sentence before takes, stays
                                              ["Ab cd.   Ef gh." [[0 9] [9 15]] [[0 2] [3 6] [9 11] [12 15]] [[3 9] [9 15]] 7 "So.\n" [[3 13] [13 19]]]
                                              ;; the next row over part of the sentence: the row keeps it
                                              ["Ab cd.   Ef gh." [[0 9] [9 15]] [[0 2] [3 6] [9 11] [12 15]] [[3 9] [12 15]] 7 "So" [[3 11] [14 17]]]
                                              ;; a row ending on its letters takes nothing
                                              ["Ab cd.   Ef gh." [[0 9] [9 15]] [[0 2] [3 6] [9 11] [12 15]] [[3 7]] 7 "So" [[3 7]]]]
              path [:edits :body]
              :let [c {:o o :sents sents :words words :rows rows :gaps [{:start at :end at :value v}]}
                    {r :r} (run-case c path)]]
        (is (empty? (violations c path)) (pr-str o rows at path))
        (is (= want (rows-of r)) (pr-str o rows at path))))
    (testing "REV4-TEXT-2: with splitOnSpace a typed space leaves every letter in its row"
      (doseq [[o sents words rows at want] [["ab cd." [[0 6]] [[0 2] [3 6]] [[0 2]] 1 [[0 3]]]
                                            ["ab cd." [[0 6]] [[0 2] [3 6]] [[0 5]] 4 [[0 6]]]
                                            ["ab cd. Ef gh." [[0 7] [7 13]] [[0 2] [3 6] [7 9] [10 13]] [[0 9]] 8 [[0 10]]]
                                            ["ab cd. Ef gh." [[0 7] [7 13]] [[0 2] [3 6] [7 9] [10 13]] [[3 6]] 4 [[3 7]]]]
              sos [true false]
              path [:edits :body]
              :let [c {:o o :sents sents :words words :rows rows :sos sos :gaps [{:start at :end at :value " "}]}
                    {r :r} (run-case c path)]]
        (is (empty? (violations c path)) (pr-str o rows sos path))
        (is (= want (rows-of r)) (pr-str o rows sos path))))
    (testing "REV4-TEXT-3: a row over part of a sentence takes text typed at its edge that the gap-fill gives the sentence"
      (doseq [[o sents words rows at v want] [["Ab cd." [[0 6]] [[0 2] [3 6]] [[0 2] [3 6]] 6 " X" [[0 2] [3 8]]]
                                              ["Ab cd.\nEf." [[0 7] [7 10]] [[0 2] [3 6] [7 10]] [[0 2] [3 6] [7 10]] 6 " X" [[0 2] [3 8] [9 12]]]
                                              ["Ab cd.\nEf." [[0 7] [7 10]] [[0 2] [3 6] [7 10]] [[0 2] [3 7] [7 10]] 7 "X\n" [[0 2] [3 9] [9 12]]]
                                              ["Ab cd." [[0 6]] [[0 2] [3 6]] [[0 2] [3 6]] 0 "So " [[0 5] [6 9]]]
                                              ;; a text with no word yet, whose rows decide in their place
                                              ["ab cd? ef." [[0 10]] [] [[0 2] [3 6] [7 10]] 10 "\nX" [[0 2] [3 6] [7 12]]]]
              path [:edits :body]
              :let [c {:o o :sents sents :words words :rows rows :gaps [{:start at :end at :value v}]}
                    {r :r} (run-case c path)]]
        (is (empty? (violations c path)) (pr-str o rows at path))
        (is (= want (rows-of r)) (pr-str o rows at path))))))

(deftest the-rev7-text-shapes
  (let [texts (fn [r] (let [b (:text/body (:text r))]
                        (vec (sort-by first (keep #(when (= :r (:token/layer %)) [(:token/begin %) (subs b (:token/begin %) (:token/end %))]) (:tokens r))))))]
    (doseq [[label o sents words rows gaps want]
            [;; REV7-TEXT-1: a NEL reads as whitespace at a row's edge, as LF does
             ["mirror, LF" "Hi. \nThe end." [[0 5] [5 13]] [[0 2] [5 8] [9 12]] [[0 3] [3 13]] [[4 4 "So"]] ["Hi. So" "\nThe end."]]
             ["mirror, NEL" "Hi. \u0085The end." [[0 5] [5 13]] [[0 2] [5 8] [9 12]] [[0 3] [3 13]] [[4 4 "So"]] ["Hi. So" "\u0085The end."]]
             ["at the end, NEL" "Hi.\u0085The end." [[0 4] [4 12]] [[0 2] [4 7] [8 11]] [[0 3] [3 12]] [[3 3 " So"]] ["Hi. So" "\u0085The end."]]
             ;; REV7-TEXT-4: in a text with no word the rows decide, and the
             ;; edits and the body read a replace over a line break alike
             ["no words, a replace over a line break" "abcd Ef ŋa \u2028ฉันไปตลาด" [[0 12] [12 21]] [] [[0 10] [10 21]] [[9 12 "x y"]] ["abcd Ef ŋx y" "ฉันไปตลาด"]]]
            path [:edits :body]
            :let [c {:o o :sents sents :words words :rows rows :gaps (mapv (fn [[a z v]] {:start a :end z :value v}) gaps)}
                  {r :r} (run-case c path)]]
      (is (= want (mapv second (texts r))) (str label " " path)))))
