(ns plaid.algos.row-follow-oracle-test
  "A seeded property test of where the rows go when a text is edited: the
  tokens of a layer that forbids overlap beside the words (time-alignment
  segments), over sentences with or without their whitespace, over several
  sentences, inside one, or cut anywhere (FX-D-TEXT, after REV3-TEXT). Each
  case is one to three changes near the sentence boundaries, judged on the
  edits path and on a whole-body save, against the gaps the server reads
  the change as. The invariant, for every row layer, with no exemptions:
  1. no edit of a text whose rows did not overlap makes them overlap (so the
     save never answers 409),
  2. text typed strictly inside a row stays in that row (but for
     whitespace at an edge that was on a letter, which the plain rule moves
     the edge off),
  3. text typed where a row's edge meets a sentence boundary (a sentence's
     begin or first letter, its end or the end of its last letter) goes
     with the sentence the partition rule chooses, and the row on that
     sentence's side holds it,
  4. a row edge not on a sentence boundary stays where it was, among the
     text a gap typed there, or moved off whitespace onto the row's text,
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
  [{:keys [o gaps] :as c} path]
  (let [tokens (tokens-of c)
        ops (ta/gap-ops gaps)]
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
            ;; the sentence the partition rule put new position p in, before
            ;; the gap-fill sweeps the text between sentences into one
            sentence-at (fn [p] (some (fn [t] (when (and (= :s (:token/layer t)) (<= (:token/begin t) p) (< p (:token/end t)))
                                                (second (:token/id t))))
                                      (:tokens r)))
            ;; old sentence boundaries: begins (with and without whitespace)
            ;; and ends, each naming its sentence
            sb (into {} (mapcat (fn [i [b e]] (let [[x y] (trim-ws oc [b e])] (cond-> [[b i]] (< x y) (conj [x i])))) (range) sents))
            se (into {} (mapcat (fn [i [b e]] (let [[x y] (trim-ws oc [b e])] (cond-> [[e i]] (< x y) (conj [y i])))) (range) sents))
            out (transient [])
            v! (fn [k msg] (conj! out [k msg]))]
        ;; 1. no overlap
        (let [rs (sort (vals new-rows))]
          (doseq [[b e] rs :when (>= b e)] (v! 1 (str "empty row " [b e])))
          (doseq [[[_ e] [b _]] (partition 2 1 rs) :when (> e b)] (v! 1 (str "rows overlap " (vec rs)))))
        (doseq [[i [b e]] (map-indexed vector rows)
                :let [[nb* ne*] (new-rows i)]
                :when nb*]
          ;; 2. text typed strictly inside
          (doseq [[gi {a :start z :end :as g}] (map-indexed vector gaps)
                  :when (and (< b a) (if (= a z) (< a e) (< z e)) (pos? (vlen g)))
                  :let [x (new-at gi)
                        ;; whitespace at an edge on a letter before is moved off
                        out (remove (fn [p] (or (<= nb* p (dec ne*))
                                                (and (< p nb*) (not (ws? (aget oc b))) (every? #(ws? (aget nc %)) (range p nb*)))
                                                (and (>= p ne*) (not (ws? (aget oc (dec e)))) (every? #(ws? (aget nc %)) (range ne* (inc p))))))
                                    (range x (+ x (vlen g))))]
                  :when (seq out)]
            (v! 2 (str "row " i " " [b e] "->" [nb* ne*] " left out " (pr-str (:value g)) " typed inside at " a)))
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
(def shapes [:full :trim :mixed :midws :span :span-trim :short :midws-begin :random])

(defn gen-case
  "A case as REV3-TEXT's generator made them: two to four sentences, with
  whitespace between them (some of only whitespace), words, rows of one of
  `shapes`, and one to three changes near the sentence boundaries."
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
    {:o body :sents sents :words words :rows rows :shape shape :gaps (vec (sort-by (juxt :start :end) gaps))}))

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
  (testing "REV3-TEXT-2: text typed inside a row stays in it"
    (doseq [[o sents rows want] [["Ab.  Cd. Ef." [[0 5] [5 9] [9 12]] [[0 5] [5 12]] [[0 6] [6 13]]]
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
      (is (= want (sort (keep #(when (= :r (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r))))))))
