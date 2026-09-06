(ns plaid.history.restore-test
  "Restoring a document to an earlier state on the server
  (plaid.history.restore, POST /documents/:id/restore).

  The central claim: after a restore to T, the live deep read equals
  the deep read that was served at T, ids included, and history stays
  coherent (reconstruction at the new latest op equals the live read).
  Checked on a hand-built scenario touching every entity kind, on a
  seeded run of random edits, and for what a restore must skip."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    with-test-users user1-request user2-request
                                    assert-created assert-ok assert-no-content
                                    assert-status with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- latest-op-ts []
  (:ts (psc/q1 db {:select [:ts] :from [:operations]
                   :order-by [[:ts :desc]] :limit 1})))

(defn- op-count []
  (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:operations]})))

(defn- restore! [req doc-id ts & {:keys [dry-run version]}]
  (api-call req {:method :post
                 :path (str "/api/v1/documents/" doc-id "/restore?as-of="
                            (java.net.URLEncoder/encode (str ts) "UTF-8")
                            (when dry-run "&dry-run=true")
                            (when version (str "&document-version=" version)))}))

(defn- rename-document! [req doc-id name]
  (api-call req {:method :patch :path (str "/api/v1/documents/" doc-id) :body {:name name}}))

;; The deep read minus what a restore rightly changes: the version and
;; the modification time.
(defn- comparable [deep]
  (dissoc deep :document/version :document/time-modified :document/media-url))

(defn- live [doc-id] (comparable (doc/get-with-layer-data db doc-id)))

(defn- token-layer [deep layer-id]
  (first (for [tl (:document/text-layers deep)
               tkl (:text-layer/token-layers tl)
               :when (= layer-id (:token-layer/id tkl))]
           tkl)))

(defn- tokens-in [deep layer-id]
  (vec (:token-layer/tokens (token-layer deep layer-id))))

(defn- spans-in [deep layer-id]
  (vec (for [tl (:document/text-layers deep)
             tkl (:text-layer/token-layers tl)
             sl (:token-layer/span-layers tkl)
             :when (= layer-id (:span-layer/id sl))
             s (:span-layer/spans sl)]
         s)))

(defn- ids [rows k] (set (map k rows)))

;; ============================================================
;; The scenario: every entity kind, then every kind of damage
;; ============================================================

(defn- build-scenario!
  "A project with a partitioning sentence layer, a nested non-overlapping
  word layer, a nested morpheme layer, span layers on each, a relation
  layer, a linked vocabulary, and metadata everywhere. Returns the ids."
  []
  (let [proj (create-test-project admin-request "Restore")
        doc-id (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "Text") :body :id)
        ;; "the quick brown fox jumps": the 0-3, quick 4-9, brown 10-15,
        ;; fox 16-19, jumps 20-25.
        text-id (-> (create-text admin-request tl doc-id "the quick brown fox jumps" {"lang" "en"})
                    :body :id)
        sent (-> (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"})
                 :body :id)
        word (-> (create-token-layer-opts admin-request tl "Words"
                                          {:overlap-mode "non-overlapping" :parent-token-layer-id sent})
                 :body :id)
        morph (-> (create-token-layer-opts admin-request tl "Morphemes"
                                           {:overlap-mode "any" :parent-token-layer-id word})
                  :body :id)
        pos (-> (create-span-layer admin-request word "POS") :body :id)
        gloss (-> (create-span-layer admin-request morph "Gloss") :body :id)
        trans (-> (create-span-layer admin-request sent "Translation") :body :id)
        dep (-> (create-relation-layer admin-request pos "Dependencies") :body :id)
        [s1] (-> (bulk-create-tokens admin-request
                                     [{:token-layer-id sent :text text-id :begin 0 :end 25}])
                 :body :ids)
        words (-> (bulk-create-tokens admin-request
                                      (mapv (fn [[b e]] {:token-layer-id word :text text-id :begin b :end e})
                                            [[0 3] [4 9] [10 15] [16 19] [20 25]]))
                  :body :ids)
        [m1 m2] (-> (bulk-create-tokens admin-request
                                        [{:token-layer-id morph :text text-id :begin 20 :end 25
                                          :precedence 1 :metadata {"form" "jump"}}
                                         {:token-layer-id morph :text text-id :begin 20 :end 25
                                          :precedence 2 :metadata {"form" "s"}}])
                    :body :ids)
        pos-spans (-> (bulk-create-spans admin-request
                                         (mapv (fn [t v] {:span-layer-id pos :tokens [t] :value v})
                                               words ["DET" "ADJ" "ADJ" "NOUN" "VERB"]))
                      :body :ids)
        [g1 g2] (-> (bulk-create-spans admin-request
                                       [{:span-layer-id gloss :tokens [m1] :value "jump"}
                                        {:span-layer-id gloss :tokens [m2] :value "3SG"}])
                    :body :ids)
        tr (-> (create-span admin-request trans [s1] "Le renard brun rapide saute" {"src" "human"})
               :body :id)
        rel (-> (create-relation admin-request dep (nth pos-spans 3) (nth pos-spans 4) "nsubj" {"conf" 0.9})
                :body :id)
        vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        _ (assert-status 204 (link-vocab-to-project admin-request proj vocab))
        fox-item (-> (create-vocab-item admin-request vocab "fox") :body :id)
        link (-> (create-vocab-link admin-request fox-item [(nth words 3)] {"prov" "human"}) :body :id)
        _ (assert-ok (update-document-metadata admin-request doc-id {"genre" "fable"}))
        _ (assert-ok (update-token-metadata admin-request (nth words 1) {"orthog:IPA" "kwɪk"}))]
    {:proj proj :doc-id doc-id :text-id text-id
     :sent sent :word word :morph morph :pos pos :gloss gloss :trans trans :dep dep
     :s1 s1 :words words :m1 m1 :m2 m2 :pos-spans pos-spans :g1 g1 :g2 g2 :tr tr
     :rel rel :vocab vocab :fox-item fox-item :link link}))

(defn- damage!
  "Every kind of change a restore has to undo: the text moved, a word
  with everything nested in it deleted, a token and annotations added,
  values changed, a relation gone and a new one made, metadata and the
  name changed."
  [{:keys [doc-id text-id word pos dep words pos-spans g2 tr link fox-item]}]
  ;; The text: every offset moves, a word is cut, a word is added.
  (assert-ok (update-text admin-request text-id "a quick fox jumps high"))
  ;; A token for the new word.
  (assert-created (bulk-create-tokens admin-request
                                      [{:token-layer-id word :text text-id :begin 18 :end 22}]))
  ;; The word "jumps" deleted: its morphemes, their glosses, its part of
  ;; speech and the relation on it go with it.
  (assert-no-content (bulk-delete-tokens admin-request [(nth words 4)]))
  (assert-status 404 (get-span admin-request g2))
  (assert-status 404 (get-span admin-request (nth pos-spans 4)))
  ;; Annotations: one changed, one with new metadata.
  (assert-ok (update-span admin-request (nth pos-spans 3) :value "PROPN"))
  (assert-ok (update-span-metadata admin-request tr {"src" "machine"}))
  ;; A new relation, pointing elsewhere.
  (assert-created (create-relation admin-request dep (nth pos-spans 1) (nth pos-spans 3) "amod"))
  ;; The vocabulary link gone, a new one made.
  (assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/vocab-links/" link)}))
  (assert-created (create-vocab-link admin-request fox-item [(nth words 1)]))
  ;; Metadata and the name.
  (assert-ok (update-document-metadata admin-request doc-id {"genre" "news" "extra" 1}))
  (assert-ok (delete-token-metadata admin-request (nth words 1)))
  (assert-ok (update-text-metadata admin-request text-id {"lang" "fr"}))
  (assert-ok (rename-document! admin-request doc-id "Renamed")))

(deftest restore-brings-back-the-state-at-t-with-its-ids
  (let [{:keys [doc-id words m2 pos-spans g2 rel link] :as ids-map} (build-scenario!)
        t (latest-op-ts)
        snapshot (live doc-id)]
    (damage! ids-map)
    (is (not= snapshot (live doc-id)) "the damage changed the document")

    (testing "a dry run reports the changes and writes nothing"
      (let [before (op-count)
            resp (restore! admin-request doc-id t :dry-run true)]
        (assert-ok resp)
        (is (pos? (-> resp :body :total)))
        (is (= [] (-> resp :body :skipped)))
        (is (= before (op-count)))
        (is (not= snapshot (live doc-id)))))

    (testing "the restore lands exactly, under the original ids"
      (let [resp (restore! admin-request doc-id t)]
        (assert-ok resp)
        (is (= [] (-> resp :body :skipped)))
        (is (pos? (-> resp :body :total)))
        (is (get-in resp [:headers "X-Document-Versions"]))
        (is (= snapshot (live doc-id)))
        ;; Deleted entities are back under the ids they had.
        (assert-ok (get-token admin-request (nth words 4)))
        (assert-ok (get-token admin-request m2))
        (assert-ok (get-span admin-request g2))
        (assert-ok (get-span admin-request (nth pos-spans 4)))
        (assert-ok (get-relation admin-request rel))
        (assert-ok (get-vocab-link admin-request link))))

    (testing "history stays coherent: reconstruction at the latest op equals the live read"
      (is (= (live doc-id)
             (comparable (hread/get-with-layer-data-at db doc-id (latest-op-ts))))))

    (testing "the restore is one operation of its own type"
      (is (= "document/restore"
             (:op_type (psc/q1 db {:select [:op_type] :from [:operations]
                                   :order-by [[:ts :desc]] :limit 1})))))

    (testing "restoring again changes nothing"
      (let [resp (restore! admin-request doc-id t :dry-run true)]
        (assert-ok resp)
        (is (zero? (-> resp :body :total)))))

    (testing "the state just before the restore is itself restorable"
      (let [ops (psc/q db {:select [:ts :op_type] :from [:operations] :order-by [[:ts :desc]] :limit 2})
            before-restore (:ts (second ops))
            damaged (comparable (hread/get-with-layer-data-at db doc-id before-restore))
            resp (restore! admin-request doc-id before-restore)]
        (assert-ok resp)
        (is (= damaged (live doc-id)))))))

(deftest restore-skips-what-cannot-come-back
  (let [{:keys [doc-id gloss fox-item vocab proj]} (build-scenario!)
        t (latest-op-ts)
        snapshot (live doc-id)]
    ;; The gloss layer and the vocabulary entry are deleted after T.
    (assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/span-layers/" gloss)}))
    (assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/vocab-items/" fox-item)}))
    (let [resp (restore! admin-request doc-id t)]
      (assert-ok resp)
      (is (= {"span" 2 "vocab-link" 1}
             (into {} (map (juxt :kind :count)) (-> resp :body :skipped))))
      ;; Everything else came back.
      (is (= (-> snapshot
                 (update :document/text-layers
                         (fn [tls]
                           (mapv (fn [tl]
                                   (update tl :text-layer/token-layers
                                           (fn [tkls]
                                             (mapv (fn [tkl]
                                                     (-> tkl
                                                         (update :token-layer/span-layers
                                                                 (fn [sls] (vec (remove #(= gloss (:span-layer/id %)) sls))))
                                                         (assoc :token-layer/vocabs
                                                                (vec (remove #(= vocab (:vocab/id %))
                                                                             (:token-layer/vocabs tkl))))))
                                                   tkls))))
                                 tls))))
             (live doc-id))))
    (is (some? proj))))

(deftest restore-refuses-what-it-should
  (let [{:keys [doc-id proj]} (build-scenario!)
        t (latest-op-ts)]
    (testing "a writer may not restore"
      (assert-no-content (add-project-writer admin-request proj "user1@example.com"))
      (assert-status 403 (restore! user1-request doc-id t)))
    (testing "a reader may not restore"
      (assert-no-content (add-project-reader admin-request proj "user2@example.com"))
      (assert-status 403 (restore! user2-request doc-id t)))
    (testing "a time before the document existed"
      (assert-status 400 (restore! admin-request doc-id "2000-01-01T00:00:00Z")))
    (testing "a malformed time"
      (assert-status 400 (restore! admin-request doc-id "yesterday")))
    (testing "a stale document version"
      (assert-status 409 (restore! admin-request doc-id t :version 1)))))

;; ============================================================
;; Random edits, seeded
;; ============================================================

(defn- word-runs
  "[begin end] of every space-separated run of the body, in code points."
  [^String body]
  (loop [i 0 runs [] start nil]
    (if (= i (count body))
      (if start (conj runs [start i]) runs)
      (let [c (.charAt body i)]
        (cond
          (and (= c \space) start) (recur (inc i) (conj runs [start i]) nil)
          (= c \space) (recur (inc i) runs nil)
          start (recur (inc i) runs start)
          :else (recur (inc i) runs i))))))

(def ^:private lexicon ["todos" "los" "seres" "humanos" "nacen" "libres" "iguales" "dignidad"])
(def ^:private tags ["NOUN" "VERB" "ADJ" "DET"])

(defn- random-edit!
  "One edit against the current state, chosen by `rng`. A rejected edit is
  fine: the document is whatever the server left."
  [^java.util.Random rng {:keys [doc-id text-id word morph pos sent]}]
  (let [deep (doc/get-with-layer-data db doc-id)
        body (-> deep :document/text-layers first :text-layer/text :text/body)
        runs (word-runs body)
        words (tokens-in deep word)
        pick (fn [coll] (nth coll (.nextInt rng (count coll))))]
    (case (.nextInt rng 9)
      0 (when (seq runs)
          (let [[_ e] (pick runs)]
            (update-text admin-request text-id (str (subs body 0 e) " " (pick lexicon) (subs body e)))))
      1 (when (> (count runs) 2)
          (let [[b e] (pick runs)]
            (update-text admin-request text-id
                         (clojure.string/replace (str (subs body 0 b) (subs body e)) #"  +" " "))))
      2 (when (seq words)
          (bulk-delete-tokens admin-request [(:token/id (pick words))]))
      3 (let [missing (remove (fn [[b e]] (some #(and (< (:token/begin %) e) (< b (:token/end %))) words)) runs)]
          (when (seq missing)
            (bulk-create-tokens admin-request
                                (mapv (fn [[b e]] {:token-layer-id word :text text-id :begin b :end e})
                                      missing))))
      4 (when (seq words)
          (let [w (pick words)
                existing (filter #(= [(:token/id w)] (:span/tokens %)) (spans-in deep pos))]
            (if (seq existing)
              (if (.nextBoolean rng)
                (bulk-delete-spans admin-request [(:span/id (first existing))])
                (update-span admin-request (:span/id (first existing)) :value (pick tags)))
              (bulk-create-spans admin-request [{:span-layer-id pos :tokens [(:token/id w)] :value (pick tags)}]))))
      5 (when (seq words)
          (let [w (pick words)
                mine (filter #(and (= (:token/begin %) (:token/begin w)) (= (:token/end %) (:token/end w)))
                             (tokens-in deep morph))]
            (if (seq mine)
              (bulk-delete-tokens admin-request (mapv :token/id mine))
              (bulk-create-tokens admin-request
                                  [{:token-layer-id morph :text text-id :begin (:token/begin w) :end (:token/end w)
                                    :precedence 1 :metadata {"form" (subs body (:token/begin w) (:token/end w))}}]))))
      6 (when (seq words)
          (let [w (pick words)]
            (if (:metadata w)
              (delete-token-metadata admin-request (:token/id w))
              (update-token-metadata admin-request (:token/id w) {"note" (pick lexicon)}))))
      7 (update-document-metadata admin-request doc-id {"note" (pick lexicon)})
      8 (let [sents (tokens-in deep sent)
              inside (filter (fn [p] (some #(and (< (:token/begin %) p) (< p (:token/end %))) sents))
                             (map first runs))]
          (if (and (seq inside) (.nextBoolean rng))
            (split-token admin-request
                         (:token/id (first (filter #(and (< (:token/begin %) (first inside))
                                                         (< (first inside) (:token/end %)))
                                                   sents)))
                         (first inside))
            (when (> (count sents) 1)
              (let [sorted (sort-by :token/begin sents)]
                (merge-tokens admin-request (:token/id (first sorted)) (:token/id (second sorted))))))))))

(deftest restore-after-random-edits-is-exact
  (let [rng (java.util.Random. 2026)
        proj (create-test-project admin-request "Fuzz")
        tl (-> (create-text-layer admin-request proj "Text") :body :id)
        sent (-> (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"}) :body :id)
        word (-> (create-token-layer-opts admin-request tl "Words"
                                          {:overlap-mode "non-overlapping" :parent-token-layer-id sent})
                 :body :id)
        morph (-> (create-token-layer-opts admin-request tl "Morphemes"
                                           {:overlap-mode "any" :parent-token-layer-id word})
                  :body :id)
        pos (-> (create-span-layer admin-request word "POS") :body :id)]
    (dotimes [round 4]
      (let [doc-id (create-test-document admin-request proj (str "Fuzz " round))
            body (clojure.string/join " " (repeatedly (+ 6 (.nextInt rng 5)) #(nth lexicon (.nextInt rng (count lexicon)))))
            text-id (-> (create-text admin-request tl doc-id body) :body :id)
            _ (assert-created (bulk-create-tokens admin-request
                                                  [{:token-layer-id sent :text text-id :begin 0 :end (count body)}]))
            _ (assert-created (bulk-create-tokens admin-request
                                                  (mapv (fn [[b e]] {:token-layer-id word :text text-id :begin b :end e})
                                                        (word-runs body))))
            ctx {:doc-id doc-id :text-id text-id :word word :morph morph :pos pos :sent sent}]
        (dotimes [_ (+ 4 (.nextInt rng 6))] (random-edit! rng ctx))
        (let [t (latest-op-ts)
              snapshot (live doc-id)]
          (dotimes [_ (+ 4 (.nextInt rng 6))] (random-edit! rng ctx))
          (let [resp (restore! admin-request doc-id t)]
            (assert-ok resp)
            (is (= [] (-> resp :body :skipped)) (str "round " round))
            (is (= snapshot (live doc-id)) (str "round " round " restored exactly"))
            (is (= (live doc-id) (comparable (hread/get-with-layer-data-at db doc-id (latest-op-ts))))
                (str "round " round " history coherent"))
            (is (zero? (-> (restore! admin-request doc-id t :dry-run true) :body :total))
                (str "round " round " second restore is a no-op"))))))))
