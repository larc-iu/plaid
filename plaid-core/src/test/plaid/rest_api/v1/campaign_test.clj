(ns plaid.rest-api.v1.campaign-test
  "TEMPORARY token-layer-configuration campaign harness.

   Systematically exercises every meaningfully-different token-layer configuration
   (overlap-mode x hierarchy shape) on real-ish data with randomized op sequences,
   asserting the product's invariants after every op.

   ENV-GATED: a no-op unless CAMPAIGN is set, so the normal `clojure -M:test` skips
   it. Run a slice with, e.g.:
     CAMPAIGN=1 CAMPAIGN_CONFIGS=d1-any,d2-no-no CAMPAIGN_SEEDS=15 CAMPAIGN_OPS=30 \\
       clojure -M:test --namespace plaid.rest-api.v1.campaign-test

   The invariant checker mirrors the PRODUCT's exact predicates (this is the part the
   earlier scratch harness got wrong):
   - overlap is strict on both sides: t1,t2 overlap iff begin1<end2 AND begin2<end1,
     so a zero-width token is overlap-immune at a boundary but a zero-width token
     strictly inside another DOES overlap.
   - zero-width is legal on :any and on a non-overlapping ROOT; forbidden on nested
     and partitioning layers.
   - partitioning (root-only) = empty OR a gap-free/overlap-free/zero-width-free
     cover of [0, text-len).
   - containment is inclusive (child==parent counts as contained).
   On a flagged violation the state is RE-READ and RE-CHECKED; only persistent
   violations are reported (filters any transient read glitch)."
  (:require [clojure.test :refer :all]
            [clojure.string :as str]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request api-call with-admin with-test-users
                                    assert-created with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ---------------------------------------------------------------------------
;; Real-ish text + canonical word offsets
;; ---------------------------------------------------------------------------

(def the-text "the cat sat on the dog")                 ; len 22
;; words (gaps at the spaces) and a contiguous cover (spaces folded into preceding)
(def word-offsets [[0 3] [4 7] [8 11] [12 14] [15 18] [19 22]])
(def cover-offsets [[0 4] [4 8] [8 12] [12 15] [15 19] [19 22]])
(def text-len (count the-text))

;; ---------------------------------------------------------------------------
;; Read full doc state
;; ---------------------------------------------------------------------------

(defn- doc-layers
  "id -> {:overlap-mode :parent :tokens [{:id :begin :end}..]}"
  [doc]
  (let [r (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc "?include-body=true")})
        tls (->> r :body :document/text-layers (mapcat :text-layer/token-layers))]
    (into {}
          (map (fn [tl]
                 [(:token-layer/id tl)
                  {:overlap-mode (:token-layer/overlap-mode tl)
                   :parent (:token-layer/parent-token-layer tl)
                   :tokens (mapv (fn [t] {:id (:token/id t)
                                          :begin (:token/begin t)
                                          :end (:token/end t)})
                                 (:token-layer/tokens tl))}]))
          tls)))

;; ---------------------------------------------------------------------------
;; Invariant checker — mirrors the product's exact predicates
;; ---------------------------------------------------------------------------

(defn- overlaps? [a b]
  ;; strict both sides: zero-width is overlap-immune at a boundary, but a
  ;; zero-width token strictly inside another overlaps (matches find-overlapping-tokens)
  (and (< (:begin a) (:end b)) (< (:begin b) (:end a))))

(defn- check-layers [layers context]
  (let [violations (atom [])
        add! (fn [s] (swap! violations conj (str context " :: " s)))]
    (doseq [[lid {:keys [overlap-mode parent tokens]}] layers]
      ;; bounds: 0 <= begin <= end <= text-len
      (doseq [t tokens]
        (when (> (:begin t) (:end t)) (add! (str "INVERTED " (:id t) " [" (:begin t) "," (:end t) "]")))
        (when (< (:begin t) 0) (add! (str "NEGATIVE-begin " (:id t))))
        (when (> (:end t) text-len) (add! (str "OUT-OF-BOUNDS " (:id t) " end=" (:end t) " > " text-len))))
      ;; zero-width: forbidden on nested layers and partitioning layers
      (when (or parent (= :partitioning overlap-mode))
        (doseq [t tokens]
          (when (= (:begin t) (:end t))
            (add! (str "ZERO-WIDTH " (:id t) " in layer " lid " (parent=" (boolean parent) " mode=" overlap-mode ")")))))
      ;; containment: each nested token sits inside SOME parent-layer token (inclusive)
      (when parent
        (let [ptoks (:tokens (get layers parent))]
          (doseq [t tokens]
            (when-not (some (fn [p] (and (<= (:begin p) (:begin t)) (>= (:end p) (:end t)))) ptoks)
              (add! (str "ORPHAN " (:id t) " [" (:begin t) "," (:end t) "] layer " lid
                         " parents=" (mapv (juxt :begin :end) ptoks)))))))
      ;; non-overlapping: no two tokens overlap (strict predicate)
      (when (= :non-overlapping overlap-mode)
        (doseq [[a b] (for [a tokens b tokens :when (neg? (compare (:id a) (:id b)))] [a b])]
          (when (overlaps? a b)
            (add! (str "OVERLAP layer " lid ": " (:id a) "[" (:begin a) "," (:end a) "] & "
                       (:id b) "[" (:begin b) "," (:end b) "]")))))
      ;; partitioning root: empty OR gap-free/overlap-free/zero-width-free cover of [0,len)
      (when (= :partitioning overlap-mode)
        (let [sorted (sort-by :begin tokens)]
          (when (seq sorted)
            (when (not= 0 (:begin (first sorted))) (add! (str "PARTITION not@0 layer " lid)))
            (when (not= text-len (:end (last sorted))) (add! (str "PARTITION not@end layer " lid)))
            (doseq [[a b] (partition 2 1 sorted)]
              (when (not= (:end a) (:begin b))
                (add! (str "PARTITION gap/overlap layer " lid " " (:end a) "/" (:begin b)))))))))
    @violations))

(defn- persistent-violations
  "Check, and if anything is flagged re-read + re-check after a tiny pause; return
   only violations present BOTH times (filters transient read glitches)."
  [doc context]
  (let [v1 (check-layers (doc-layers doc) context)]
    (if (empty? v1)
      []
      (do (Thread/sleep 60)
          (let [v2 (set (check-layers (doc-layers doc) context))]
            (filterv v2 v1))))))

;; ---------------------------------------------------------------------------
;; Hierarchy builder + establishment of real-ish initial tokens
;; ---------------------------------------------------------------------------

(defn- mk-hierarchy [proj-name layer-specs]
  (let [proj (create-test-project admin-request proj-name)
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc the-text) :body :id)
        layer-ids (reduce
                   (fn [acc {:keys [name overlap-mode parent]}]
                     (let [opts (cond-> {:overlap-mode overlap-mode}
                                  (some? parent) (assoc :parent-token-layer-id (nth acc parent)))
                           res (create-token-layer-opts admin-request tl name opts)]
                       (when (not= 201 (:status res))
                         (throw (ex-info "layer creation failed" {:res res :spec name})))
                       (conj acc (-> res :body :id))))
                   [] layer-specs)]
    {:proj proj :doc doc :text-id text-id :layers layer-ids :specs layer-specs}))

(defn- child-chunks [[pb pe]]
  (let [w (- pe pb)]
    (if (<= w 1) [[pb pe]] (let [mid (+ pb (quot w 2))] [[pb mid] [mid pe]]))))

(defn- establish!
  "Seed realistic initial tokens for each layer (parents already established since
   layer order is parent-before-child). Returns nil; ops asserted created."
  [{:keys [doc text-id layers specs]}]
  (doseq [[i {:keys [overlap-mode parent]}] (map-indexed vector specs)]
    (let [lid (nth layers i)
          mk (fn [pairs] (mapv (fn [[b e]] {:token-layer-id lid :text text-id :begin b :end e}) pairs))]
      (if (nil? parent)
        ;; root
        (case overlap-mode
          "partitioning" (assert-created (bulk-create-tokens admin-request (mk cover-offsets)))
          "non-overlapping" (assert-created (bulk-create-tokens admin-request (mk word-offsets)))
          "any" (assert-created (bulk-create-tokens admin-request
                                                    (mk (conj word-offsets [0 7]))))) ; +1 overlapping
        ;; nested: for each parent token, create children inside it
        (let [ptoks (:tokens (get (doc-layers doc) (nth layers parent)))
              base (vec (mapcat (fn [p] (child-chunks [(:begin p) (:end p)])) ptoks))
              pairs (if (= overlap-mode "any")
                      ;; add a contained-but-overlapping child for one parent
                      (into base (when-let [p (first ptoks)] [[(:begin p) (:end p)]]))
                      base)]
          (when (seq pairs)
            (assert-created (bulk-create-tokens admin-request (mk pairs)))))))))

;; ---------------------------------------------------------------------------
;; Randomized op driver (token ops only; identical surface to real clients)
;; ---------------------------------------------------------------------------

(defn- rand-op! [rng {:keys [doc text-id layers]}]
  (let [pick (fn [coll] (when (seq coll) (nth coll (.nextInt rng (count coll)))))
        lstate (doc-layers doc)
        nlayers (count layers)]
    (case (.nextInt rng 9)
      0 (let [root (first layers)]               ; re-establish a root if it went empty
          (when (empty? (:tokens (get lstate root)))
            (let [mode (:overlap-mode (get lstate root))
                  pairs (if (= mode :partitioning) cover-offsets word-offsets)]
              (bulk-create-tokens admin-request
                                  (mapv (fn [[b e]] {:token-layer-id root :text text-id :begin b :end e}) pairs))))
          :establish-root)
      1 (when (> nlayers 1)                       ; bulk create children in a parent
          (let [lidx (inc (.nextInt rng (dec nlayers)))
                lid (nth layers lidx)
                p (pick (:tokens (get lstate (nth layers (dec lidx)))))]
            (when (and p (> (:end p) (:begin p)))
              (bulk-create-tokens admin-request
                                  (mapv (fn [[b e]] {:token-layer-id lid :text text-id :begin b :end e})
                                        (child-chunks [(:begin p) (:end p)])))))
          :bulk-create-child)
      2 (when (> nlayers 1)                       ; single create child
          (let [lidx (inc (.nextInt rng (dec nlayers)))
                lid (nth layers lidx)
                p (pick (:tokens (get lstate (nth layers (dec lidx)))))]
            (when (and p (>= (- (:end p) (:begin p)) 1))
              (let [b (+ (:begin p) (.nextInt rng (max 1 (- (:end p) (:begin p)))))
                    e (min (:end p) (+ b 1 (.nextInt rng (max 1 (- (:end p) b)))))]
                (when (< b e) (create-token admin-request lid text-id b e)))))
          :create-child)
      3 (let [t (pick (:tokens (get lstate (pick layers))))]   ; split
          (when (and t (> (- (:end t) (:begin t)) 1))
            (split-token admin-request (:id t)
                         (+ (:begin t) 1 (.nextInt rng (max 1 (dec (- (:end t) (:begin t))))))))
          :split)
      4 (let [ts (:tokens (get lstate (pick layers)))]         ; merge
          (when (>= (count ts) 2)
            (let [a (pick ts) b (pick (remove #(= (:id %) (:id a)) ts))]
              (when (and a b) (merge-tokens admin-request (:id a) (:id b)))))
          :merge)
      5 (let [t (pick (:tokens (get lstate (pick layers))))]   ; shift a boundary
          (when t
            (if (zero? (.nextInt rng 2))
              (shift-token-boundary admin-request (:id t) :end (min text-len (max 0 (+ (:end t) (- (.nextInt rng 5) 2)))))
              (shift-token-boundary admin-request (:id t) :begin (min text-len (max 0 (+ (:begin t) (- (.nextInt rng 5) 2)))))))
          :shift)
      6 (let [t (pick (:tokens (get lstate (pick layers))))]   ; PATCH-extent
          (when t
            (let [nb (min text-len (max 0 (+ (:begin t) (- (.nextInt rng 3) 1))))
                  ne (min text-len (max 0 (+ (:end t) (- (.nextInt rng 3) 1))))]
              (when (< nb ne) (update-token admin-request (:id t) :begin nb :end ne))))
          :patch-extent)
      7 (when (> nlayers 1)                       ; delete a non-root token
          (let [t (pick (:tokens (get lstate (nth layers (inc (.nextInt rng (dec nlayers)))))))]
            (when t (delete-token admin-request (:id t))))
          :delete)
      8 (when (> nlayers 1)                       ; bulk delete a subset on a non-root layer
          (let [ts (:tokens (get lstate (nth layers (inc (.nextInt rng (dec nlayers))))))
                subset (->> ts (filter (fn [_] (zero? (.nextInt rng 2)))) (mapv :id))]
            (when (seq subset) (bulk-delete-tokens admin-request subset)))
          :bulk-delete))))

;; ---------------------------------------------------------------------------
;; Config registry (~21 meaningfully-distinct shapes)
;; ---------------------------------------------------------------------------

(defn- L [name mode parent] {:name name :overlap-mode mode :parent parent})

(def configs
  {;; depth 1
   "d1-any"   [(L "R" "any" nil)]
   "d1-no"    [(L "R" "non-overlapping" nil)]
   "d1-part"  [(L "R" "partitioning" nil)]
   ;; depth 2
   "d2-no-any"   [(L "R" "non-overlapping" nil) (L "C" "any" 0)]
   "d2-no-no"    [(L "R" "non-overlapping" nil) (L "C" "non-overlapping" 0)]
   "d2-part-any" [(L "R" "partitioning" nil)    (L "C" "any" 0)]
   "d2-part-no"  [(L "R" "partitioning" nil)    (L "C" "non-overlapping" 0)]
   ;; depth 3 (mid forced non-overlapping)
   "d3-no-any"   [(L "R" "non-overlapping" nil) (L "M" "non-overlapping" 0) (L "Lf" "any" 1)]
   "d3-no-no"    [(L "R" "non-overlapping" nil) (L "M" "non-overlapping" 0) (L "Lf" "non-overlapping" 1)]
   "d3-part-any" [(L "R" "partitioning" nil)    (L "M" "non-overlapping" 0) (L "Lf" "any" 1)]
   "d3-part-no"  [(L "R" "partitioning" nil)    (L "M" "non-overlapping" 0) (L "Lf" "non-overlapping" 1)]
   ;; depth 4
   "d4-no-any"   [(L "R" "non-overlapping" nil) (L "A" "non-overlapping" 0) (L "B" "non-overlapping" 1) (L "Lf" "any" 2)]
   "d4-no-no"    [(L "R" "non-overlapping" nil) (L "A" "non-overlapping" 0) (L "B" "non-overlapping" 1) (L "Lf" "non-overlapping" 2)]
   "d4-part-any" [(L "R" "partitioning" nil)    (L "A" "non-overlapping" 0) (L "B" "non-overlapping" 1) (L "Lf" "any" 2)]
   "d4-part-no"  [(L "R" "partitioning" nil)    (L "A" "non-overlapping" 0) (L "B" "non-overlapping" 1) (L "Lf" "non-overlapping" 2)]
   ;; branching: one parent, two children of differing modes
   "br-no-2kids"   [(L "R" "non-overlapping" nil) (L "C1" "any" 0) (L "C2" "non-overlapping" 0)]
   "br-part-2kids" [(L "R" "partitioning" nil)    (L "C1" "any" 0) (L "C2" "non-overlapping" 0)]
   "br-deep"       [(L "R" "partitioning" nil)    (L "M" "non-overlapping" 0) (L "L1" "any" 1) (L "L2" "non-overlapping" 1)]
   "br-wide"       [(L "R" "partitioning" nil)    (L "W1" "non-overlapping" 0) (L "W2" "non-overlapping" 0) (L "Lf" "any" 1)]
   ;; multiple roots in one text layer
   "multi-roots"      [(L "R1" "partitioning" nil) (L "R2" "any" nil) (L "R3" "non-overlapping" nil)]
   "multi-root-trees" [(L "R1" "partitioning" nil) (L "W" "non-overlapping" 0) (L "R2" "non-overlapping" nil)]})

;; ---------------------------------------------------------------------------
;; Driver
;; ---------------------------------------------------------------------------

(defn- run-config [cfg-id seeds n-ops]
  (let [specs (get configs cfg-id)]
    (doseq [seed (range seeds)]
      (let [rng (java.util.Random. (+ (* 1000 (hash cfg-id)) seed))
            hier (mk-hierarchy (str "C-" cfg-id "-" seed) specs)]
        (establish! hier)
        (let [v0 (persistent-violations (:doc hier) (str cfg-id " seed=" seed " establish"))]
          (when (seq v0) (println "CAMPAIGN-VIOLATION" cfg-id "seed=" seed "establish" (vec v0)))
          (is (empty? v0) (str "establish " cfg-id " seed=" seed)))
        (dotimes [i n-ops]
          (let [op (try (rand-op! rng hier) (catch Exception e (str "EX " (.getMessage e))))
                vs (persistent-violations (:doc hier) (str cfg-id " seed=" seed " op#" i " (" op ")"))]
            (when (seq vs)
              (println "CAMPAIGN-VIOLATION" cfg-id "seed=" seed "op#" i "(" op ")" (vec vs)))
            (is (empty? vs) (str cfg-id " seed=" seed " op#" i " (" op ")"))))))))

(deftest campaign
  (when (System/getenv "CAMPAIGN")
    (let [requested (or (System/getenv "CAMPAIGN_CONFIGS") "all")
          ids (if (= requested "all") (sort (keys configs)) (str/split requested #","))
          seeds (Integer/parseInt (or (System/getenv "CAMPAIGN_SEEDS") "12"))
          n-ops (Integer/parseInt (or (System/getenv "CAMPAIGN_OPS") "30"))]
      (doseq [cfg-id ids]
        (when-not (contains? configs cfg-id)
          (throw (ex-info (str "unknown config " cfg-id) {:known (keys configs)})))
        (println "=== CAMPAIGN config" cfg-id "seeds=" seeds "ops=" n-ops "===")
        (run-config cfg-id seeds n-ops)))))
