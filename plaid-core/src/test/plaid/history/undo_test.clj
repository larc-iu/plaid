(ns plaid.history.undo-test
  "Undo one History entry (plaid.history.undo, POST
  /audit/entries/:entry-id/undo).

  The central claim: for an entry nobody built on, undo gives back exactly
  the state before it, every row of every table restore covers, its
  documents and its vocabulary together. Then: what is left and why, when
  someone did build on it, and that what is left keeps the database valid."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    with-test-users user1-request user2-request
                                    assert-created assert-ok assert-no-content with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.sql.job]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all]
            [ring.mock.request :as mock])
  (:import (java.util Random)))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ============================================================
;; Helpers
;; ============================================================

(defn- assert-done [resp]
  (is (< (:status resp) 300) (pr-str (:body resp)))
  resp)

(defn- in-group
  "`req` with every write joining logical operation `group`."
  [req group]
  (fn [method path]
    (req method (str path (if (str/includes? path "?") "&" "?") "group-id=" group))))

(defn- undo [req entry-id & {:keys [dry-run document-id vocab-layer-id]}]
  (api-call req {:method :post
                 :path (str "/api/v1/audit/entries/" entry-id "/undo?"
                            (str/join "&" (cond-> []
                                            dry-run (conj "dry-run=true")
                                            document-id (conj (str "document-id=" document-id))
                                            vocab-layer-id (conj (str "vocab-layer-id=" vocab-layer-id)))))}))

(defn- undone! [req entry-id & opts]
  (let [resp (apply undo req entry-id opts)]
    (assert-ok resp)
    (:body resp)))

(defn- last-op-id [op-type]
  (:id (psc/q1 db {:select [:id] :from [:operations] :where [:= :op_type op-type]
                   :order-by [[:ts :desc]] :limit 1})))

(defn- op-count [] (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:operations]})))

(defn- reasons [summary] (into {} (map (juxt :id :reason)) (:skipped summary)))

(defn- setup!
  "A project with one document: a text, a word layer (any overlap), a span
  layer on it, a relation layer, a vocabulary with entries, and a few rows
  of each made outside any entry under test."
  []
  (let [proj (create-test-project admin-request "Undo")
        doc-id (create-test-document admin-request proj "Doc")
        tl (id (create-text-layer admin-request proj "Text"))
        text (id (create-text admin-request tl doc-id "the quick brown fox jumps" {"lang" "en"}))
        word (id (create-token-layer admin-request tl "Words"))
        pos (id (create-span-layer admin-request word "POS"))
        dep (id (create-relation-layer admin-request pos "Dependencies"))
        toks (-> (bulk-create-tokens admin-request
                                     (mapv (fn [[b e]] {:token-layer-id word :text text :begin b :end e})
                                           [[0 3] [4 9] [10 15] [16 19] [20 25]]))
                 :body :ids)
        spans (-> (bulk-create-spans admin-request
                                     (mapv (fn [t v] {:span-layer-id pos :tokens [t] :value v})
                                           toks ["DET" "ADJ" "ADJ" "NOUN" "VERB"]))
                  :body :ids)
        rel (id (create-relation admin-request dep (nth spans 3) (nth spans 4) "nsubj"))
        vocab (id (create-vocab-layer admin-request proj "Lexicon"))
        fox (id (create-vocab-item admin-request vocab "fox"))
        jump (id (create-vocab-item admin-request vocab "jump"))
        link (id (create-vocab-link admin-request fox [(nth toks 3)]))]
    {:proj proj :doc doc-id :tl tl :text text :word word :pos pos :dep dep :toks toks
     :spans spans :rel rel :vocab vocab :fox fox :jump jump :link link}))

;; The state compared: every row of the documents and the vocabulary, as the
;; deep reads serve them, a link's entry named by id alone.

(defn- flat-document [deep]
  (let [layers (:document/text-layers deep)
        tkls (mapcat :text-layer/token-layers layers)
        sls (mapcat :token-layer/span-layers tkls)]
    (into {["document" (:document/id deep)]
           (cond-> (select-keys deep [:document/id :document/name :document/project])
             (:metadata deep) (assoc :metadata (:metadata deep)))}
          (concat
           (for [l layers :let [t (:text-layer/text l)] :when t] [["text" (:text/id t)] t])
           (for [k tkls t (:token-layer/tokens k)] [["token" (:token/id t)] t])
           (for [s sls x (:span-layer/spans s)] [["span" (:span/id x)] x])
           (for [s sls rl (:span-layer/relation-layers s) x (:relation-layer/relations rl)]
             [["relation" (:relation/id x)] x])
           (for [k tkls v (:token-layer/vocabs k) x (:vocab-layer/vocab-links v)]
             [["vocab-link" (:vocab-link/id x)]
              (update x :vocab-link/vocab-item select-keys [:vocab-item/id])])))))

(defn- flat-vocab [v]
  (into {["vocab-layer" (:vocab/id v)] (select-keys v [:vocab/id :vocab/name :vocab/project :config])}
        (for [i (:vocab/items v)] [["vocab-item" (:vocab-item/id i)] i])))

(defn- state
  "The documents `doc-ids` (absent ones left out) and the vocabularies
  `vocab-ids`, as they are now."
  [doc-ids vocab-ids]
  (apply merge
         (concat (for [d doc-ids :let [deep (doc/get-with-layer-data db d)] :when deep] (flat-document deep))
                 (for [v vocab-ids] (flat-vocab (hread/get-vocab-at db v (latest-op-ts) true))))))

;; ============================================================
;; Every kind of row
;; ============================================================

(deftest every-kind-of-row-goes-back
  (let [{:keys [doc text word pos dep toks spans rel vocab fox jump link]} (setup!)
        before (state [doc] [vocab])
        g (str (random-uuid))
        r (in-group admin-request g)
        new-tok (id (create-token r word text 0 9))
        _ (id (create-span r pos [new-tok] "NP"))
        new-rel (id (create-relation r dep (nth spans 0) (nth spans 1) "det"))
        kai (id (create-vocab-item r vocab "kai" {"gloss" "and"}))
        _ (id (create-vocab-link r kai [(nth toks 0)]))
        _ (assert-ok (update-token r (nth toks 4) :precedence 2))
        _ (assert-ok (update-span r (nth spans 1) :value "ADJ2"))
        _ (assert-ok (update-relation r rel "obj"))
        _ (assert-ok (update-vocab-item r jump "jumps"))
        _ (assert-ok (update-vocab-link-metadata r link {"prov" "machine"}))
        _ (assert-ok (update-text-metadata r text {"lang" "fr"}))
        _ (assert-ok (update-document-metadata r doc {"genre" "fable"}))
        _ (assert-done (delete-relation r new-rel))
        _ (assert-done (delete-span r (nth spans 0)))
        _ (assert-done (delete-vocab-link r link))
        _ (assert-done (delete-vocab-item r fox))
        after (state [doc] [vocab])
        dry (undone! admin-request g :dry-run true)
        _ (is (= after (state [doc] [vocab])) "a dry run writes nothing")
        ops (op-count)
        real (undone! admin-request g)]
    (is (= before (state [doc] [vocab])))
    (is (= (dissoc dry :dry-run) (dissoc real :dry-run :operation)) "the dry run said what the call did")
    (is (zero? (:skipped-count real)))
    (is (= {:inserted 1 :updated 1 :deleted 1} (-> real :undone :vocab-items)) "fox back, jump renamed back, kai gone")
    (is (= {:inserted 0 :updated 1 :deleted 0} (-> real :undone :texts)))
    (is (= (inc ops) (op-count)) "one operation")
    (is (= (str (:operation real)) (str (last-op-id "audit-entry/undo"))))
    (is (str/includes? (:description (psc/q1 db {:select [:description] :from [:operations]
                                                 :where [:= :id (str (:operation real))]}))
                       g)
        "its description names the entry")
    (testing "undone twice: nothing is left to undo, and nothing is written"
      (let [again (undone! admin-request g)
            ops (op-count)]
        (is (zero? (:total again)))
        (is (= (:rows real) (:skipped-count again)))
        (is (every? #{"changed-since"} (map :reason (:skipped again))))
        (is (nil? (:operation again)))
        (is (= ops (op-count)))))
    (testing "the undo is an entry: undoing it gives the state after the first entry"
      (undone! admin-request (:operation real))
      (is (= after (state [doc] [vocab]))))))

;; ============================================================
;; The property: for an entry nobody built on, undo gives the state before
;; ============================================================

(defn- random-unit!
  "`n` random writes of every kind under group `g`, chosen by `rng`."
  [^Random rng {:keys [doc text word pos dep vocab toks spans rel fox jump link]} g n]
  (let [r (in-group admin-request g)
        pick (fn [xs] (when (seq xs) (nth (vec xs) (.nextInt rng (count xs)))))
        tokens (atom (set toks))
        span-of (atom (into {} (map vector spans toks)))
        rels (atom {rel [(nth spans 3) (nth spans 4)]})
        items (atom #{fox jump})
        links (atom {link [fox (nth toks 3)]})
        busy-tokens (fn [] (into (set (vals @span-of)) (map second (vals @links))))
        busy-spans (fn [] (set (mapcat identity (vals @rels))))
        busy-items (fn [] (set (map first (vals @links))))]
    (dotimes [_ n]
      (case (.nextInt rng 15)
        0 (let [b (.nextInt rng 20)]
            (swap! tokens conj (id (create-token r word text b (+ b 1 (.nextInt rng 5))))))
        1 (when-let [t (pick @tokens)]
            (assert-ok (update-token r t :precedence (.nextInt rng 4))))
        2 (when-let [t (pick (remove (busy-tokens) @tokens))]
            (assert-done (delete-token r t))
            (swap! tokens disj t))
        3 (when-let [t (pick @tokens)]
            (swap! span-of assoc (id (create-span r pos [t] (str "v" (.nextInt rng 3)))) t))
        4 (when-let [s (pick (keys @span-of))]
            (assert-ok (update-span r s :value (str "v" (.nextInt rng 3)))))
        5 (when-let [s (pick (remove (busy-spans) (keys @span-of)))]
            (assert-done (delete-span r s))
            (swap! span-of dissoc s))
        6 (when-let [[a b] (seq (take 2 (shuffle (keys @span-of))))]
            (when b (swap! rels assoc (id (create-relation r dep a b "r")) [a b])))
        7 (when-let [x (pick (keys @rels))]
            (if (.nextBoolean rng)
              (assert-ok (update-relation r x (str "r" (.nextInt rng 3))))
              (do (assert-done (delete-relation r x)) (swap! rels dissoc x))))
        8 (swap! items conj (id (create-vocab-item r vocab (str "e" (.nextInt rng 100)))))
        9 (when-let [i (pick @items)]
            (if (and (.nextBoolean rng) (not ((busy-items) i)))
              (do (assert-done (delete-vocab-item r i)) (swap! items disj i))
              (assert-ok (update-vocab-item r i (str "f" (.nextInt rng 100))))))
        10 (when-let [i (pick @items)]
             (when-let [t (pick @tokens)]
               (swap! links assoc (id (create-vocab-link r i [t])) [i t])))
        11 (when-let [l (pick (keys @links))]
             (if (.nextBoolean rng)
               (assert-ok (update-vocab-link-metadata r l {"k" (.nextInt rng 3)}))
               (do (assert-done (delete-vocab-link r l)) (swap! links dissoc l))))
        12 (assert-ok (patch-document-metadata r doc [{:op "set" :path ["k"] :value (.nextInt rng 3)}]))
        13 (when-let [t (pick @tokens)]
             (assert-ok (update-token-metadata r t {"m" (.nextInt rng 3)})))
        14 (when-let [i (pick @items)]
             (assert-ok (update-vocab-item-metadata r i {"gloss" (str "g" (.nextInt rng 3))})))))))

(deftest undo-gives-back-the-state-before-an-entry-nobody-built-on
  (doseq [seed [1 2 3 4 5 6 7 8]]
    (testing (str "seed " seed)
      (with-clean-db
        (fn []
          (let [{:keys [doc vocab] :as s} (setup!)
                before (state [doc] [vocab])
                g (str (random-uuid))
                _ (random-unit! (Random. seed) s g 40)
                after (state [doc] [vocab])
                dry (undone! admin-request g :dry-run true)
                real (undone! admin-request g)]
            (is (zero? (:skipped-count real)) (pr-str (:skipped real)))
            (is (= before (state [doc] [vocab])))
            (is (= (dissoc dry :dry-run) (dissoc real :dry-run :operation)))
            (testing "and its undo gives the state after"
              (undone! admin-request (:operation real))
              (is (= after (state [doc] [vocab]))))))))))

;; ============================================================
;; Built on since (REV-UC-1): a made row someone used stays
;; ============================================================

(deftest a-made-row-someone-built-on-stays
  (let [{:keys [doc text word pos dep spans vocab toks]} (setup!)
        g (str (random-uuid))
        r (in-group admin-request g)
        t1 (id (create-token r word text 0 3))
        t2 (id (create-token r word text 4 9))
        t3 (id (create-token r word text 10 15))
        e1 (id (create-vocab-item r vocab "e1"))
        e2 (id (create-vocab-item r vocab "e2"))
        e3 (id (create-vocab-item r vocab "e3"))
        s1 (id (create-span r pos [t3] "N"))
        plain (id (create-token r word text 16 19))
        ;; afterwards a person builds on t1, t2 (a link), e1, e2 (a reference), s1
        _ (create-span admin-request pos [t1] "mine")
        _ (create-vocab-link admin-request e1 [t2])
        e4 (id (create-vocab-item admin-request vocab "e4" {"parent" (str e2)}))
        _ (create-relation admin-request dep s1 (nth spans 0) "rel")
        _ (assert-created (api-call admin-request {:method :post :path "/api/v1/comments"
                                                   :body {:entity-type "vocab-item" :entity-id e3 :body "hm"}}))
        summary (undone! admin-request g)
        why (reasons summary)
        by (into {} (map (juxt :id (comp :kind :by))) (:skipped summary))]
    (is (= {t1 "built-on" t2 "built-on" t3 "built-on" e1 "built-on" e2 "built-on" e3 "built-on" s1 "built-on"} why))
    (is (= {t1 "span" t2 "vocab-link" t3 "span" e1 "vocab-link" e2 "vocab-item" e3 nil s1 "relation"} by)
        "t3 stays under s1, which a relation holds: the closure names the span")
    (is (= 1 (:total summary)) "the plain token goes")
    (is (= 404 (:status (get-token admin-request plain))))
    (is (= 200 (:status (get-token admin-request t1))))
    (is (some? (psc/fetch-by-id db :vocab_items e4)))))

(deftest a-child-token-and-a-made-text
  (let [proj (create-test-project admin-request "Child")
        d (create-test-document admin-request proj "D")
        tl (id (create-text-layer admin-request proj "Text"))
        words (id (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}))
        morphs (id (create-token-layer-opts admin-request tl "Morphemes" {:parent-token-layer-id words}))
        g (str (random-uuid))
        r (in-group admin-request g)
        text (id (create-text r tl d "ab cd"))
        w1 (id (create-token r words text 0 2))
        w2 (id (create-token r words text 3 5))
        ;; a person segments w1
        m (id (create-token admin-request morphs text 0 1))
        summary (undone! admin-request g)]
    (is (= {w1 "built-on" text "built-on"} (reasons summary)))
    (is (= {:kind "token" :id m} (:by (first (filter #(= w1 (:id %)) (:skipped summary))))))
    (is (contains? #{{:kind "token" :id w1} {:kind "token" :id m}}
                   (:by (first (filter #(= text (:id %)) (:skipped summary)))))
        "the text stays, since a token that stays is on it")
    (is (= 404 (:status (get-token admin-request w2))))
    (is (= 200 (:status (get-token admin-request m))))))

;; ============================================================
;; Changed since and between: a job's group interleaved with a person
;; ============================================================

(deftest a-job-shaped-group-interleaved-with-a-person
  (let [{:keys [proj doc spans pos toks]} (setup!)
        _ (assert-done (add-project-writer admin-request proj "user1@example.com"))
        g (str (random-uuid))
        batch (fn [subs]
                (assert-ok (api-call admin-request {:method :post :path (str "/api/v1/batch?group-id=" g)
                                                    :body subs})))
        patch (fn [s v] {:path (str "/api/v1/spans/" s "?group-id=" g) :method "patch" :body {:value v}})
        _ (batch [(patch (nth spans 0) "J0") (patch (nth spans 1) "J1")])
        ;; the person writes between the job's batches: a row of the job's, and one of their own
        _ (assert-ok (update-span user1-request (nth spans 1) :value "P1"))
        own (id (create-span user1-request pos [(nth toks 2)] "P"))
        _ (batch [(patch (nth spans 2) "J2") (patch (nth spans 1) "J1b")])
        ;; and after the job, on one of its rows
        _ (assert-ok (update-span user1-request (nth spans 2) :value "P2"))
        summary (undone! admin-request g)]
    (is (= {(nth spans 1) "changed-between" (nth spans 2) "changed-since"} (reasons summary)))
    (is (= "DET" (-> (get-span admin-request (nth spans 0)) :body :span/value)))
    (is (= "J1b" (-> (get-span admin-request (nth spans 1)) :body :span/value)))
    (is (= "P2" (-> (get-span admin-request (nth spans 2)) :body :span/value)))
    (is (= 200 (:status (get-span admin-request own))) "the person's own span is not the job's")))

;; ============================================================
;; Text
;; ============================================================

(defn- text-world! []
  (let [proj (create-test-project admin-request "Text")
        d (create-test-document admin-request proj "D")
        tl (id (create-text-layer admin-request proj "Text"))
        words (id (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}))
        other (id (create-token-layer admin-request tl "Other"))
        pos (id (create-span-layer admin-request words "POS"))
        text (id (create-text admin-request tl d "the cat sat"))
        toks (-> (bulk-create-tokens admin-request (mapv (fn [[b e]] {:token-layer-id words :text text :begin b :end e})
                                                         [[0 3] [4 7] [8 11]]))
                 :body :ids)]
    {:proj proj :doc d :text text :words words :other other :pos pos :toks toks}))

(deftest a-text-edit-nobody-touched-since-goes-back-with-its-offsets
  (let [{:keys [doc text toks]} (text-world!)
        before (state [doc] [])
        g (str (random-uuid))
        _ (assert-ok (update-text (in-group admin-request g) text "a black cat sat"))
        summary (undone! admin-request g)]
    (is (zero? (:skipped-count summary)) (pr-str (:skipped summary)))
    (is (= before (state [doc] [])))
    (is (= 11 (-> (get-token admin-request (nth toks 2)) :body :token/end)))))

(deftest a-text-edit-with-later-writes-in-its-document-stays
  (testing "the text written again"
    (let [{:keys [text toks]} (text-world!)
          g (str (random-uuid))
          _ (assert-ok (update-text (in-group admin-request g) text "a black cat sat"))
          _ (assert-ok (update-text admin-request text "a black cat sat down"))
          summary (undone! admin-request g)
          why (reasons summary)]
      (is (= "changed-since" (why text)))
      (is (every? #{"text-changed-since" "changed-since"} (vals why)))
      (is (= "a black cat sat down" (-> (get-text admin-request text) :body :text/body)))
      (is (= 15 (-> (get-token admin-request (nth toks 2)) :body :token/end)) "the tokens keep the text's offsets")))
  (testing "a token made since on the text"
    (let [{:keys [text other]} (text-world!)
          g (str (random-uuid))
          _ (assert-ok (update-text (in-group admin-request g) text "a black cat sat"))
          mine (id (create-token admin-request other text 0 1))
          summary (undone! admin-request g)
          why (reasons summary)]
      (is (= "text-changed-since" (why text)))
      (is (= "a black cat sat" (-> (get-text admin-request text) :body :text/body)))
      (is (= 1 (-> (get-token admin-request mine) :body :token/end)))))
  (testing "a span written since does not hold the text"
    (let [{:keys [doc text pos toks]} (text-world!)
          before (state [doc] [])
          g (str (random-uuid))
          _ (assert-ok (update-text (in-group admin-request g) text "a black cat sat"))
          s (id (create-span admin-request pos [(nth toks 1)] "N"))
          summary (undone! admin-request g)]
      (is (zero? (:skipped-count summary)))
      (is (= before (dissoc (state [doc] []) ["span" s]))))))

;; ============================================================
;; A merge, the proving case
;; ============================================================

(defn- merge-world!
  "The home project's document with two words, a borrowing project's
  document with one, a vocabulary of the home with entries fox (the
  survivor) and foxes and fuchs (the losers). Links: fox on home word 0,
  foxes on home word 0 too (a duplicate the merge deletes), foxes on home
  word 1 and on the borrower's word, fuchs on nothing. A sense entry names
  foxes as its parent, a span in each document names fuchs in its metadata."
  []
  (let [home (create-test-project admin-request "Home")
        hd (create-test-document admin-request home "H")
        htl (id (create-text-layer admin-request home "Text"))
        hw (id (create-token-layer admin-request htl "Words"))
        hpos (id (create-span-layer admin-request hw "POS"))
        ht (id (create-text admin-request htl hd "fox foxes"))
        [h0 h1] (-> (bulk-create-tokens admin-request [{:token-layer-id hw :text ht :begin 0 :end 3}
                                                       {:token-layer-id hw :text ht :begin 4 :end 9}])
                    :body :ids)
        borrower (create-test-project admin-request "Borrower")
        bd (create-test-document admin-request borrower "B")
        btl (id (create-text-layer admin-request borrower "Text"))
        bw (id (create-token-layer admin-request btl "Words"))
        bpos (id (create-span-layer admin-request bw "POS"))
        bt (id (create-text admin-request btl bd "foxes"))
        b0 (id (create-token admin-request bw bt 0 5))
        vocab (id (create-vocab-layer admin-request home "Lexicon"))
        _ (assert-done (link-vocab-to-project admin-request borrower vocab))
        fox (id (create-vocab-item admin-request vocab "fox" {"gloss" "fox"}))
        foxes (id (create-vocab-item admin-request vocab "foxes" {"gloss" "foxes"}))
        fuchs (id (create-vocab-item admin-request vocab "fuchs"))
        sense (id (create-vocab-item admin-request vocab "sense" {"parent" (str foxes)}))
        l-fox (id (create-vocab-link admin-request fox [h0]))
        l-dup (id (create-vocab-link admin-request foxes [h0] {"note" "dup"}))
        l-h1 (id (create-vocab-link admin-request foxes [h1]))
        l-b0 (id (create-vocab-link admin-request foxes [b0]))
        hs (id (create-span admin-request hpos [h1] "N" {"see" (str fuchs)}))
        bs (id (create-span admin-request bpos [b0] "N" {"see" [(str fuchs) "x"]}))]
    {:home home :hd hd :borrower borrower :bd bd :vocab vocab :fox fox :foxes foxes :fuchs fuchs
     :sense sense :l-fox l-fox :l-dup l-dup :l-h1 l-h1 :l-b0 l-b0 :hs hs :bs bs :h0 h0 :h1 h1 :b0 b0}))

(defn- merge! [survivor losers]
  (assert-ok (api-call admin-request {:method :post :path (str "/api/v1/vocab-items/" survivor "/merge")
                                      :body {:losers losers}}))
  (last-op-id "vocab-item/merge-into"))

(defn- version [d] (:version (psc/fetch-by-id db :documents d)))

(deftest undoing-a-merge-nobody-built-on
  (let [{:keys [hd bd vocab fox foxes fuchs sense l-dup l-h1 l-b0 hs bs]} (merge-world!)
        before (state [hd bd] [vocab])
        entry (merge! fox [foxes fuchs])
        _ (is (nil? (psc/fetch-by-id db :vocab_items foxes)) "the merge did merge")
        versions [(version hd) (version bd)]
        summary (undone! admin-request entry)]
    (is (zero? (:skipped-count summary)) (pr-str (:skipped summary)))
    (is (= before (state [hd bd] [vocab])) "every table as before the merge")
    (testing "the losers under their old ids with their fields"
      (is (= "foxes" (:form (psc/fetch-by-id db :vocab_items foxes))))
      (is (= {"gloss" "foxes"} (:metadata (:body (get-vocab-item admin-request foxes))))))
    (testing "every moved link points to its old entry under its old id, the duplicate is back"
      (is (= foxes (:vocab_item_id (psc/fetch-by-id db :vocab_links l-h1))))
      (is (= foxes (:vocab_item_id (psc/fetch-by-id db :vocab_links l-b0))) "in the borrowing project too")
      (is (= foxes (:vocab_item_id (psc/fetch-by-id db :vocab_links l-dup)))))
    (testing "every rewritten reference names the loser again, in the home and the borrower"
      (is (= {"parent" (str foxes)} (:metadata (:body (get-vocab-item admin-request sense)))))
      (is (= {"see" (str fuchs)} (-> (get-span admin-request hs) :body :metadata)))
      (is (= {"see" [(str fuchs) "x"]} (-> (get-span admin-request bs) :body :metadata))))
    (testing "the documents' versions moved"
      (is (every? true? (map < versions [(version hd) (version bd)]))))))

(deftest undoing-a-merge-someone-built-on
  (testing "a person relinked one word since: that link is left, the rest undone"
    (let [{:keys [fox foxes l-h1 l-b0 h1 vocab]} (merge-world!)
          entry (merge! fox [foxes])
          other (id (create-vocab-item admin-request vocab "other"))
          _ (assert-done (delete-vocab-link admin-request l-h1))
          mine (id (create-vocab-link admin-request other [h1]))
          summary (undone! admin-request entry)]
      (is (= {l-h1 "changed-since"} (reasons summary)))
      (is (= foxes (:vocab_item_id (psc/fetch-by-id db :vocab_links l-b0))))
      (is (= other (:vocab_item_id (psc/fetch-by-id db :vocab_links mine))))
      (is (some? (psc/fetch-by-id db :vocab_items foxes)))))
  (testing "a person edited the survivor since: the survivor keeps the edit, which the merge never wrote"
    (let [{:keys [fox foxes l-b0]} (merge-world!)
          entry (merge! fox [foxes])
          _ (assert-ok (update-vocab-item admin-request fox "Fox"))
          summary (undone! admin-request entry)]
      (is (zero? (:skipped-count summary)))
      (is (= "Fox" (:form (psc/fetch-by-id db :vocab_items fox))))
      (is (= foxes (:vocab_item_id (psc/fetch-by-id db :vocab_links l-b0))))))
  (testing "a batch that also rewrote the survivor, which a person edited since: that row is left"
    (let [{:keys [fox foxes]} (merge-world!)
          resp (api-call admin-request {:method :post :path "/api/v1/batch"
                                        :body [{:path (str "/api/v1/vocab-items/" fox "/merge") :method "post"
                                                :body {:losers [foxes]}}
                                               {:path (str "/api/v1/vocab-items/" fox "/metadata") :method "put"
                                                :body {"gloss" "fox, foxes"}}]})
          _ (assert-ok resp)
          batch (:batch_id (psc/q1 db {:select [:batch_id] :from [:operations]
                                       :where [:= :op_type "vocab-item/merge-into"]
                                       :order-by [[:ts :desc]] :limit 1}))
          _ (assert-ok (update-vocab-item-metadata admin-request fox {"gloss" "mine"}))
          summary (undone! admin-request batch)]
      (is (= {fox "changed-since"} (reasons summary)))
      (is (= {"gloss" "mine"} (:metadata (:body (get-vocab-item admin-request fox)))))
      (is (some? (psc/fetch-by-id db :vocab_items foxes))))))

;; ============================================================
;; An import, a bulk delete, a document delete, a restore
;; ============================================================

(deftest undoing-an-import
  (let [proj (create-test-project admin-request "Import")
        tl (id (create-text-layer admin-request proj "Text"))
        word (id (create-token-layer admin-request tl "Words"))
        pos (id (create-span-layer admin-request word "POS"))
        import! (fn [name]
                  (let [g (str (random-uuid))
                        r (in-group admin-request g)
                        d (create-test-document r proj name)
                        text (id (create-text r tl d "a b c d"))
                        toks (-> (bulk-create-tokens r (mapv (fn [i] {:token-layer-id word :text text :begin (* 2 i) :end (inc (* 2 i))})
                                                             (range 4)))
                                 :body :ids)
                        spans (-> (bulk-create-spans r (mapv (fn [t] {:span-layer-id pos :tokens [t] :value "X"}) toks)) :body :ids)]
                    {:g g :d d :toks toks :spans spans}))]
    (testing "nobody wrote in it since: the document goes whole"
      (let [{:keys [g d]} (import! "One")
            summary (undone! admin-request g)]
        (is (zero? (:skipped-count summary)))
        (is (= {:inserted 0 :updated 0 :deleted 4} (-> summary :undone :tokens)))
        (is (nil? (psc/fetch-by-id db :documents d)))
        (testing "and its undo brings it back whole, the rows the import never recorded too"
          (undone! admin-request (:operation summary))
          (is (some? (psc/fetch-by-id db :documents d)))
          (is (= 4 (count (psc/q db {:select [:id] :from [:spans] :where [:= :document_id (str d)]})))))))
    (testing "a person wrote in it since: the document and what they built on stay, the rest goes"
      (let [{:keys [g d toks spans]} (import! "Two")
            _ (assert-ok (update-span admin-request (nth spans 0) :value "mine"))
            summary (undone! admin-request g)
            why (reasons summary)]
        (is (= "built-on" (why d)))
        (is (= "changed-since" (why (nth spans 0))))
        (is (= "built-on" (why (nth toks 0))))
        (is (= ["mine"] (map (comp psc/read-json :value) (psc/q db {:select [:value] :from [:spans] :where [:= :document_id (str d)]})))
            "the other spans went")
        (is (= [(nth toks 0)] (map :id (psc/q db {:select [:id] :from [:tokens] :where [:= :document_id (str d)]}))))))))

(deftest undoing-a-bulk-delete-of-entries-with-links-in-two-documents
  (let [{:keys [proj doc vocab fox jump toks word tl]} (setup!)
        d2 (create-test-document admin-request proj "Doc2")
        t2 (id (create-text admin-request tl d2 "fox"))
        k2 (id (create-token admin-request word t2 0 3))
        l2 (id (create-vocab-link admin-request fox [k2]))
        l3 (id (create-vocab-link admin-request jump [(nth toks 4)] {"note" "j"}))
        before (state [doc d2] [vocab])
        _ (assert-done (bulk-delete-vocab-items admin-request [fox jump]))
        entry (last-op-id "vocab-item/bulk-delete")
        summary (undone! admin-request entry)]
    (is (zero? (:skipped-count summary)))
    (is (= {:inserted 2 :updated 0 :deleted 0} (-> summary :undone :vocab-items)))
    (is (= {:inserted 3 :updated 0 :deleted 0} (-> summary :undone :vocab-links)))
    (is (= before (state [doc d2] [vocab])))
    (is (= {"note" "j"} (-> (get-vocab-link admin-request l3) :body :metadata)))
    (is (= fox (:vocab_item_id (psc/fetch-by-id db :vocab_links l2))))))

(deftest undoing-a-document-delete
  (let [{:keys [doc vocab]} (setup!)
        before (state [doc] [vocab])
        v (version doc)
        _ (assert-done (api-call admin-request {:method :delete :path (str "/api/v1/documents/" doc)}))
        entry (last-op-id "document/delete")
        summary (undone! admin-request entry)]
    (is (zero? (:skipped-count summary)) (pr-str (:skipped summary)))
    (is (= {:inserted 1 :updated 0 :deleted 0} (-> summary :undone :documents)))
    (is (= before (state [doc] [vocab])))
    (is (< v (version doc)) "a client holding the old version learns it moved")
    (testing "a deleted document whose name another document took since stays deleted"
      (let [{:keys [proj doc]} (setup!)
            _ (assert-done (api-call admin-request {:method :delete :path (str "/api/v1/documents/" doc)}))
            entry (last-op-id "document/delete")
            _ (create-test-document admin-request proj "Doc")
            summary (undone! admin-request entry)
            why (reasons summary)]
        (is (= "name-taken" (why doc)))
        (is (every? #{"name-taken" "needs"} (vals why)))
        (is (zero? (:total summary)))))))

(deftest undoing-a-restore
  (let [{:keys [doc spans word text vocab]} (setup!)
        t0 (latest-op-ts)
        _ (assert-ok (update-span admin-request (nth spans 1) :value "changed"))
        _ (id (create-token admin-request word text 0 1))
        _ (assert-done (delete-span admin-request (nth spans 4)))
        edited (state [doc] [vocab])
        _ (assert-ok (api-call admin-request {:method :post
                                              :path (str "/api/v1/documents/" doc "/restore?as-of="
                                                         (java.net.URLEncoder/encode (str t0) "UTF-8"))}))
        summary (undone! admin-request (last-op-id "document/restore"))]
    (is (zero? (:skipped-count summary)))
    (is (= edited (state [doc] [vocab])) "undoing the restore gives what it restored over")))

;; ============================================================
;; Who may
;; ============================================================

(deftest who-may-undo
  (let [{:keys [proj spans vocab fox]} (setup!)
        g (str (random-uuid))
        r (in-group admin-request g)
        _ (assert-ok (update-span r (nth spans 0) :value "g"))
        _ (assert-ok (update-vocab-item r fox "foks"))]
    (testing "a writer, a reader, a non-member: 403"
      (assert-done (add-project-writer admin-request proj "user1@example.com"))
      (is (= 403 (:status (undo user1-request g))))
      (is (= 403 (:status (undo user2-request g))))
      (is (= "g" (-> (get-span admin-request (nth spans 0)) :body :span/value)) "and nothing written"))
    (testing "an unknown entry: 404 to an admin, 403 unresolved to anyone else"
      (is (= 404 (:status (undo admin-request (random-uuid)))))
      (let [resp (undo user1-request (random-uuid))]
        (is (= 403 (:status resp)))
        (is (true? (-> resp :body :unresolved)))))
    (testing "a maintainer of the project, whose home holds the vocabulary: both"
      (assert-no-content (api-call admin-request {:method :post :path (str "/api/v1/projects/" proj "/maintainers/user1@example.com")}))
      (let [summary (:body (undo user1-request g :dry-run true))]
        (is (= 2 (:total summary)))))
    (testing "a maintainer of a borrowing project only: its own document's rows, never the entries"
      (let [b (create-test-project admin-request "Borrower")
            _ (assert-done (link-vocab-to-project admin-request b vocab))
            _ (assert-no-content (api-call admin-request {:method :post :path (str "/api/v1/projects/" b "/maintainers/user2@example.com")}))
            btl (id (create-text-layer admin-request b "Text"))
            bw (id (create-token-layer admin-request btl "Words"))
            bd (create-test-document admin-request b "B")
            bt (id (create-text admin-request btl bd "foks"))
            bk (id (create-token admin-request bw bt 0 4))
            g2 (str (random-uuid))
            r2 (in-group admin-request g2)
            bl (id (create-vocab-link r2 fox [bk]))
            _ (assert-ok (update-vocab-item r2 fox "foxx"))
            summary (undone! user2-request g2)]
        (is (= {fox "not-permitted"} (reasons summary)))
        (is (nil? (psc/fetch-by-id db :vocab_links bl)))
        (is (= "foxx" (:form (psc/fetch-by-id db :vocab_items fox))))))))

(defn- signed [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(deftest delegated-and-job-tokens-undo-document-rows-only
  (let [{:keys [proj spans fox]} (setup!)
        other (create-test-project admin-request "Elsewhere")
        tokens {"a delegated token" (auth/issue-delegated-token! db "fake-secret" "admin@example.com" [proj])
                "a job token" (auth/issue-job-token! db "fake-secret" "admin@example.com" proj
                                                     "0197d1a0-3333-7000-8000-000000000003"
                                                     #uuid "0197d1a0-0000-7000-8000-00000000000a"
                                                     nil nil nil)}]
    (doseq [[what token] tokens]
      (testing what
        (with-redefs [plaid.sql.job/token-live? (constantly true)]
          (let [g (str (random-uuid))
                r (in-group admin-request g)
                _ (assert-ok (update-span r (nth spans 0) :value "g"))
                _ (assert-ok (update-vocab-item r fox (str "f" (rand-int 1000))))
                summary (:body (undo (signed token) g))]
            (is (= {fox "not-permitted"} (reasons summary)))
            (is (= 1 (:total summary)))
            (is (= "DET" (-> (get-span admin-request (nth spans 0)) :body :span/value)))
            (testing "out of its projects: 403"
              (let [d (create-test-document admin-request other (str "O " what))
                    tl (id (create-text-layer admin-request other "T"))
                    g2 (str (random-uuid))
                    _ (create-text (in-group admin-request g2) tl d "x")]
                (is (= 403 (:status (undo (signed token) g2))))))))))))

;; ============================================================
;; What the layers allow now
;; ============================================================

(defn- declare! [kind layer constraints]
  (assert-ok (api-call admin-request {:method :put
                                      :path (str "/api/v1/" kind "-layers/" layer "/constraints/igt")
                                      :body {:constraints constraints}})))

(deftest a-value-a-closed-list-no-longer-allows-is-left
  (let [{:keys [pos spans]} (setup!)
        g (str (random-uuid))
        r (in-group admin-request g)
        _ (assert-ok (update-span r (nth spans 1) :value "A"))
        _ (assert-ok (update-span r (nth spans 2) :value "A"))
        _ (assert-done (delete-span r (nth spans 0)))
        ;; the list closes since: ADJ is still in it, DET is not
        _ (declare! "span" pos [{:type "value-set" :values ["A" "ADJ" "NOUN" "VERB"]}])
        summary (undone! admin-request g)]
    (is (= {(nth spans 0) "value-not-allowed"} (reasons summary)))
    (is (= 2 (:total summary)) "row by row: the other two are set back")
    (is (= "ADJ" (-> (get-span admin-request (nth spans 1)) :body :span/value)))
    (is (= 404 (:status (get-span admin-request (nth spans 0)))))))

(deftest a-document-whose-layers-would-not-hold-is-left-whole
  (testing "restore's final check: a token put back where a word made since now stands"
    (let [proj (create-test-project admin-request "Fit")
          d (create-test-document admin-request proj "D")
          d2 (create-test-document admin-request proj "D2")
          tl (id (create-text-layer admin-request proj "Text"))
          words (id (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}))
          text (id (create-text admin-request tl d "ab cd"))
          text2 (id (create-text admin-request tl d2 "ef"))
          w (id (create-token admin-request words text 0 2))
          w2 (id (create-token admin-request words text2 0 2))
          g (str (random-uuid))
          r (in-group admin-request g)
          _ (assert-done (delete-token r w))
          _ (assert-done (delete-token r w2))
          _ (assert-ok (update-text-metadata r text {"k" "v"}))
          mine (id (create-token admin-request words text 1 3))
          summary (undone! admin-request g)]
      (is (= {w "does-not-fit" text "does-not-fit"} (reasons summary)) "every row of that document")
      (is (= 1 (:total summary)) "the other document's row went back")
      (is (= 200 (:status (get-token admin-request w2))))
      (is (= 200 (:status (get-token admin-request mine))))
      (is (= 404 (:status (get-token admin-request w))))))
  (testing "a rule a layer declares (coextensive): no remedy runs, the document is left"
    (let [proj (create-test-project admin-request "Rules")
          d (create-test-document admin-request proj "D")
          tl (id (create-text-layer admin-request proj "Text"))
          words (id (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}))
          morphs (id (create-token-layer-opts admin-request tl "Morphemes" {:parent-token-layer-id words}))
          _ (declare! "token" morphs [{:type "coextensive"}])
          text (id (create-text admin-request tl d "abcd"))
          w (id (create-token admin-request words text 0 4))
          g (str (random-uuid))
          ;; the entry shrinks the word, a person then makes a morpheme over its new extent
          _ (assert-ok (update-token (in-group admin-request g) w :end 2))
          m (id (create-token admin-request morphs text 0 2))
          ops (op-count)
          summary (undone! admin-request g)]
      (is (= {w "does-not-fit"} (reasons summary)))
      (is (= 200 (:status (get-token admin-request m))) "the person's morpheme stays")
      (is (= 2 (-> (get-token admin-request w) :body :token/end)))
      (is (= ops (op-count)) "nothing written, no rule applied"))))

(deftest a-locked-document-is-left
  (let [{:keys [proj doc spans]} (setup!)
        _ (assert-no-content (api-call admin-request {:method :post :path (str "/api/v1/projects/" proj "/maintainers/user1@example.com")}))
        g (str (random-uuid))
        _ (assert-ok (update-span (in-group admin-request g) (nth spans 0) :value "g"))
        _ (assert-ok (acquire-lock user1-request doc))
        summary (undone! admin-request g)]
    (is (= {(nth spans 0) "locked"} (reasons summary)))))

;; ============================================================
;; Narrowed to a document or a vocabulary
;; ============================================================

(deftest narrowed-to-a-document-or-a-vocabulary
  (let [{:keys [proj doc vocab fox toks word tl spans]} (setup!)
        d2 (create-test-document admin-request proj "Doc2")
        t2 (id (create-text admin-request tl d2 "fox"))
        k2 (id (create-token admin-request word t2 0 3))
        g (str (random-uuid))
        r (in-group admin-request g)
        e (id (create-vocab-item r vocab "new"))
        l1 (id (create-vocab-link r e [(nth toks 0)]))
        l2 (id (create-vocab-link r e [k2]))
        _ (assert-ok (update-span r (nth spans 0) :value "g"))
        _ (assert-ok (update-vocab-item r fox "foks"))]
    (testing "a document: its rows, links included, never an entry"
      (let [summary (:body (undo admin-request g :document-id doc :dry-run true))]
        (is (= 2 (:total summary)))
        (is (= {:inserted 0 :updated 0 :deleted 1} (-> summary :undone :vocab-links)))
        (is (= {:inserted 0 :updated 1 :deleted 0} (-> summary :undone :spans)))))
    (testing "a vocabulary: its entries, and the links naming one of them"
      (let [summary (:body (undo admin-request g :vocab-layer-id vocab :dry-run true))]
        (is (= 4 (:total summary)))
        (is (= {:inserted 0 :updated 1 :deleted 1} (-> summary :undone :vocab-items)))
        (is (= {:inserted 0 :updated 0 :deleted 2} (-> summary :undone :vocab-links)))))
    (testing "the document's part, then the vocabulary's: the entry goes once its links have"
      (undone! admin-request g :document-id d2)
      (let [summary (undone! admin-request g :vocab-layer-id vocab)]
        (is (nil? ((reasons summary) l1)) "l1 went with its document's part")
        (is (nil? (psc/fetch-by-id db :vocab_items e)))
        (is (nil? (psc/fetch-by-id db :vocab_links l2)))
        (is (= "fox" (:form (psc/fetch-by-id db :vocab_items fox))))))))

;; ============================================================
;; What undo does not take back, and its limit
;; ============================================================

(deftest an-entry-of-settings-only-and-a-project-delete
  (let [{:keys [proj tl pos]} (setup!)
        g (str (random-uuid))
        r (in-group admin-request g)
        _ (assert-ok (api-call r {:method :patch :path (str "/api/v1/span-layers/" pos) :body {:name "Tags"}}))
        summary (undone! admin-request g)]
    (is (zero? (:rows summary)))
    (is (zero? (:total summary)))
    (is (= [{:op-type "span-layer/update" :count 1}] (:not-undone summary)))
    (is (nil? (:operation summary)))
    (is (= 403 (:status (undo user1-request g))) "a non-member is refused all the same")
    (testing "a project's deletion"
      (assert-done (delete-test-project admin-request proj))
      (let [entry (last-op-id "project/delete")
            resp (undo admin-request entry)]
        (is (= 422 (:status resp)))
        (is (= "A project's deletion cannot be undone." (-> resp :body :error)))
        (is (= 403 (:status (undo user1-request entry))))))
    (is (some? tl))))

(deftest an-entry-past-the-limit-is-refused
  (let [{:keys [spans]} (setup!)
        g (str (random-uuid))
        r (in-group admin-request g)]
    (doseq [s (take 3 spans)] (assert-ok (update-span r s :value "g")))
    (with-redefs [plaid.history.undo/max-rows 2]
      (let [resp (undo admin-request g)]
        (is (= 413 (:status resp)))
        (is (= "This entry changed 3 rows. An undo takes at most 2." (-> resp :body :error)))))
    (is (= "g" (-> (get-span admin-request (first spans)) :body :span/value)))))

(deftest an-action-inside-a-group-is-undone-alone
  (let [{:keys [doc spans]} (setup!)
        g (str (random-uuid))
        r (in-group admin-request g)
        _ (assert-ok (update-span r (nth spans 0) :value "one"))
        _ (assert-ok (update-span r (nth spans 1) :value "two"))
        group (last (-> (get-document-audit admin-request doc) :body :entries))
        [_ op2] (:audit/ops group)
        summary (undone! admin-request (:op/id op2))]
    (is (= 1 (:total summary)))
    (is (= "one" (-> (get-span admin-request (nth spans 0)) :body :span/value)))
    (is (= "ADJ" (-> (get-span admin-request (nth spans 1)) :body :span/value)))))

(deftest every-other-dependent-holds-a-made-row
  (let [{:keys [proj tl word pos dep spans vocab text]} (setup!)
        comment! (fn [etype eid] (assert-created (api-call admin-request {:method :post :path "/api/v1/comments"
                                                                          :body {:entity-type etype :entity-id eid
                                                                                 :body "hm"}})))
        g (str (random-uuid))
        r (in-group admin-request g)
        tok (id (create-token r word text 0 3))
        rel (id (create-relation r dep (nth spans 0) (nth spans 1) "x"))
        e (id (create-vocab-item r vocab "e"))
        d (create-test-document r proj "Made")
        dt (id (create-text r tl d "z"))
        _ (comment! "token" tok)
        _ (comment! "relation" rel)
        _ (comment! "document" d)
        _ (assert-ok (update-span-metadata admin-request (nth spans 2) {"entry" (str e)}))
        summary (undone! admin-request g)
        why (reasons summary)]
    (is (= {tok "built-on" rel "built-on" e "built-on" d "built-on"} why))
    (is (= {:kind "span" :id (nth spans 2)} (:by (first (filter #(= e (:id %)) (:skipped summary)))))
        "a reference in a document's metadata")
    (is (nil? (psc/fetch-by-id db :texts dt)) "the made document's own text went, the document stays")
    (is (some? (psc/fetch-by-id db :documents d)))
    (is (some? pos))))

(deftest a-layer-or-a-vocabulary-deleted-is-not-undone
  (testing "a span layer's deletion: its spans need the layer, which does not come back"
    (let [{:keys [pos]} (setup!)
          _ (assert-done (api-call admin-request {:method :delete :path (str "/api/v1/span-layers/" pos)}))
          summary (undone! admin-request (last-op-id "span-layer/delete"))]
      (is (zero? (:total summary)))
      (is (= [{:op-type "span-layer/delete" :count 1}] (:not-undone summary)))
      (is (every? #{"needs"} (map :reason (:skipped summary))))
      (is (= #{{:kind "span-layer" :id pos}} (set (keep #(when (= "span" (:kind %)) (:needs %)) (:skipped summary)))))))
  (testing "a vocabulary's deletion: its row is not undone, its entries need it, its links need them"
    (let [{:keys [vocab fox]} (setup!)
          _ (assert-done (delete-vocab-layer admin-request vocab))
          summary (undone! admin-request (last-op-id "vocab/delete"))
          why (reasons summary)]
      (is (zero? (:total summary)))
      (is (= "not-undone" (why vocab)))
      (is (= "needs" (why fox))))))

;; ============================================================
;; Round 2 (REV-UN)
;; ============================================================

(defn- token-text
  "What token `tok-id` reads now, by code points."
  [tok-id]
  (let [t (psc/fetch-by-id db :tokens tok-id)
        body (:body (psc/fetch-by-id db :texts (:text_id t)))]
    (when t
      (let [cps (.toArray (.codePoints ^String body))]
        (String. cps (int (:begin t)) (int (- (:end_ t) (:begin t))))))))

(defn- five-words [overlap]
  (let [proj (create-test-project admin-request "P")
        d (create-test-document admin-request proj "D")
        tl (id (create-text-layer admin-request proj "Text"))
        text (id (create-text admin-request tl d "the quick brown fox jumps"))
        word (id (if overlap
                   (create-token-layer-opts admin-request tl "Words" {:overlap-mode overlap})
                   (create-token-layer admin-request tl "Words")))
        pos (id (create-span-layer admin-request word "POS"))
        toks (-> (bulk-create-tokens admin-request
                                     (mapv (fn [[b e]] {:token-layer-id word :text text :begin b :end e})
                                           [[0 3] [4 9] [10 15] [16 19] [20 25]]))
                 :body :ids)]
    {:proj proj :d d :tl tl :text text :word word :pos pos :toks toks}))

(deftest rev-un-1-offsets-never-go-back-onto-a-text-written-since
  (doseq [overlap [nil "non-overlapping"]]
    (testing (str "a layer of overlap " (or overlap "any"))
      (testing "a deleted token, the text edited since by someone else"
        (let [{:keys [text toks pos]} (five-words overlap)
              brown (nth toks 2)
              g (str (random-uuid))
              r (in-group admin-request g)
              s (id (create-span admin-request pos [brown] "ADJ"))
              _ (assert-done (delete-span r s))
              _ (assert-done (delete-token r brown))
              _ (assert-ok (update-text admin-request text "a the quick brown fox jumps"))
              summary (undone! admin-request g)]
          (is (= {brown "text-changed-since" s "needs"} (reasons summary)))
          (is (nil? (psc/fetch-by-id db :tokens brown)))))
      (testing "an extent set back, characters no token holds deleted since"
        (let [{:keys [text toks]} (five-words overlap)
              brown (nth toks 2)
              g (str (random-uuid))
              _ (assert-ok (update-token (in-group admin-request g) brown :end 13))
              _ (assert-ok (update-text admin-request text "the quick bro fox jumps"))
              summary (undone! admin-request g)]
          (is (= {brown "text-changed-since"} (reasons summary)))
          (is (= "bro" (token-text brown)))))
      (testing "a merge, a split and a boundary shift, the text edited since after them"
        (doseq [[what act] [["merge" (fn [toks] (merge-tokens admin-request (nth toks 1) (nth toks 2)))]
                            ["split" (fn [toks] (split-token admin-request (nth toks 2) 13))]
                            ["shift" (fn [toks] (shift-token-boundary admin-request (nth toks 2) :begin 12))]]]
          (let [{:keys [d text toks]} (five-words overlap)
                _ (assert-done (act toks))
                entry (:id (psc/q1 db {:select [:id] :from [:operations] :order-by [[:ts :desc]] :limit 1}))
                _ (assert-ok (update-text admin-request text "the quick brown fox jumps!"))
                readings (fn [] (into {} (map (fn [t] [(:id t) (token-text (:id t))]))
                                      (psc/q db {:select [:id] :from [:tokens] :where [:= :document_id (str d)]})))
                was (readings)
                summary (undone! admin-request entry)]
            (is (pos? (:skipped-count summary)) what)
            (is (every? #{"text-changed-since" "needs" "built-on"} (map :reason (:skipped summary))) what)
            (is (= was (readings)) (str what ": no token reads other characters"))))))))

(deftest rev-un-2-a-row-is-never-set-back-to-name-a-row-that-will-not-be-there
  (let [mw (fn [] (let [w (merge-world!)] w))]
    (testing "a borrowing project's maintainer: the borrower's span keeps naming the survivor"
      (let [{:keys [borrower fox foxes fuchs bs]} (mw)
            _ (assert-no-content (api-call admin-request {:method :post :path (str "/api/v1/projects/" borrower "/maintainers/user2@example.com")}))
            entry (merge! fox [foxes fuchs])
            summary (undone! user2-request entry)]
        (is (= "needs" ((reasons summary) bs)))
        (is (= {:kind "vocab-item" :id fuchs} (:needs (first (filter #(= bs (:id %)) (:skipped summary))))))
        (is (= {"see" [(str fox) "x"]} (-> (get-span admin-request bs) :body :metadata)))))
    (testing "a document's part: its span keeps naming the survivor, the loser out of scope"
      (let [{:keys [hd fox foxes fuchs hs]} (mw)
            entry (merge! fox [foxes fuchs])
            summary (undone! admin-request entry :document-id hd)]
        (is (= "needs" ((reasons summary) hs)))
        (is (= {"see" (str fox)} (-> (get-span admin-request hs) :body :metadata)))))
    (testing "a vocabulary's part: the sense entry names its loser again, which comes back, the spans stay as they are"
      (let [{:keys [vocab fox foxes fuchs sense hs]} (mw)
            entry (merge! fox [foxes fuchs])
            summary (undone! admin-request entry :vocab-layer-id vocab)]
        (is (zero? (:skipped-count summary)))
        (is (= {"parent" (str foxes)} (:metadata (:body (get-vocab-item admin-request sense)))))
        (is (= {"see" (str fox)} (-> (get-span admin-request hs) :body :metadata)))))
    (testing "a reference to an entry deleted since"
      (let [{:keys [vocab spans]} (setup!)
            e (id (create-vocab-item admin-request vocab "e"))
            _ (assert-ok (update-span-metadata admin-request (nth spans 0) {"entry" (str e)}))
            g (str (random-uuid))
            _ (assert-ok (update-span-metadata (in-group admin-request g) (nth spans 0) {"other" "x"}))
            _ (assert-done (delete-vocab-item admin-request e))
            summary (undone! admin-request g)]
        (is (= {(nth spans 0) "needs"} (reasons summary)))
        (is (= {"other" "x"} (-> (get-span admin-request (nth spans 0)) :body :metadata)))))))

(deftest rev-un-3-a-place-taken-since-is-skipped-never-a-500
  (testing "a text put back where its layer holds another text of the document now"
    (let [{:keys [doc tl text toks spans]} (setup!)
          g (str (random-uuid))
          r (in-group admin-request g)
          _ (assert-ok (update-span r (nth spans 0) :value "g"))
          _ (assert-done (delete-text r text))
          mine (id (create-text admin-request tl doc "a new text"))
          dry (undo admin-request g :dry-run true)
          resp (undo admin-request g)]
      (is (= 200 (:status dry)))
      (is (= 200 (:status resp)))
      (is (= "place-taken" ((reasons (:body resp)) text)))
      (is (= "needs" ((reasons (:body resp)) (first toks))))
      (is (= "a new text" (:body (psc/fetch-by-id db :texts mine))))))
  (testing "a constraint the plan did not foresee leaves its document and plans again, never Internal error"
    (let [{:keys [doc spans]} (setup!)
          g (str (random-uuid))
          _ (assert-ok (update-span (in-group admin-request g) (nth spans 0) :value "g"))
          real-apply plaid.history.restore/apply-plan!
          calls (atom 0)]
      (with-redefs [plaid.history.restore/apply-plan!
                    (fn [tx d p cur]
                      (when (= 1 (swap! calls inc))
                        (throw (org.sqlite.SQLiteException. "[SQLITE_CONSTRAINT_UNIQUE] probe"
                                                            org.sqlite.SQLiteErrorCode/SQLITE_CONSTRAINT_UNIQUE)))
                      (real-apply tx d p cur))]
        (let [resp (undo admin-request g)]
          (is (= 200 (:status resp)))
          (is (= {(nth spans 0) "does-not-fit"} (reasons (:body resp))))
          (is (some? doc)))))))

(deftest rev-un-4-rows-the-caller-cannot-read-are-not-named
  (let [{:keys [proj pos toks]} (setup!)
        other (create-test-project admin-request "Secret")
        od (create-test-document admin-request other "Secret doc")
        otl (id (create-text-layer admin-request other "T"))
        g (str (random-uuid))
        r (in-group admin-request g)
        mine (id (create-span r pos [(nth toks 0)] "X"))
        _ (create-text r otl od "secret words")
        _ (assert-done (add-project-reader admin-request other "user2@example.com"))
        _ (assert-no-content (api-call admin-request {:method :post :path (str "/api/v1/projects/" proj "/maintainers/user1@example.com")}))
        _ (assert-no-content (api-call admin-request {:method :post :path (str "/api/v1/projects/" proj "/maintainers/user2@example.com")}))
        for1 (:body (undo user1-request g :dry-run true))
        for2 (:body (undo user2-request g :dry-run true))]
    (testing "a caller who cannot read the other project: its rows are not counted or named"
      (is (= 1 (:rows for1)))
      (is (zero? (:skipped-count for1)))
      (is (empty? (:skipped for1)))
      (is (= 1 (:total for1))))
    (testing "a caller who reads it but does not maintain it: listed not-permitted"
      (is (= 2 (:rows for2)))
      (is (= ["not-permitted"] (map :reason (:skipped for2)))))
    (is (some? mine))))

(deftest rev-un-1-the-engine-checks-what-every-token-it-put-back-reads
  ;; with the rule off, the check after the writes still finds the token that
  ;; would read other characters, leaves it, and plans again
  (with-redefs [plaid.history.undo/texts-written (fn [& _] #{})]
    (let [{:keys [text toks pos]} (five-words nil)
          brown (nth toks 2)
          g (str (random-uuid))
          r (in-group admin-request g)
          s (id (create-span admin-request pos [brown] "ADJ"))
          _ (assert-done (delete-span r s))
          _ (assert-done (delete-token r brown))
          _ (assert-ok (update-text admin-request text "a the quick brown fox jumps"))
          summary (undone! admin-request g)]
      (is (= {brown "text-changed-since" s "needs"} (reasons summary)))
      (is (nil? (psc/fetch-by-id db :tokens brown))))))
