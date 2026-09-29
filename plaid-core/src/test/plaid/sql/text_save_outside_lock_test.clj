(ns plaid.sql.text-save-outside-lock-test
  "A body save works out its diff before it takes the write lock, and writes
  what it worked out only when nothing it read has changed since.

  Each case runs a write between the save's reads and its transaction (a
  token layer delete, a new partitioning layer with its tokens, another body
  save of the same text, token writes in the same document, a write in
  another document of the project) and compares the result with a twin
  project where the same write simply came first. A write in another project
  leaves the worked-out save standing. The write itself answering 2xx from
  inside the save shows the save did not hold the lock while it worked."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler admin-request api-call
                                    assert-created assert-ok with-admin with-clean-db]]
            [plaid.sql.text :as st]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private old-body "the cat sat on the mat.\nthe dog ran.\n")
(def ^:private new-body "oh, the cow sat on a mat.\nthe dog ran far.\n")

(defn- extents-of
  "[begin end] of each word of `body`."
  [body]
  (map (fn [m] [(.start m) (.end m)])
       (let [m (re-matcher #"[a-z]+" body)]
         (take-while some? (repeatedly #(when (.find m) (.toMatchResult m)))))))

(defn- id-of [res] (-> res :body :id))

(defn- setup
  "A project with a document holding `old-body`: sentences (a partition),
  words under them, a morpheme per word under those, nodes (any overlap) on
  the first two words, a gloss span on every word. A second document holds
  the same body without tokens."
  [name]
  (let [req admin-request
        proj (create-test-project req name)
        doc (create-test-document req proj "Doc")
        other (create-test-document req proj "Other")
        tl (id-of (create-text-layer req proj "TL"))
        s (id-of (create-token-layer-opts req tl "Sentences" {:overlap-mode "partitioning"}))
        w (id-of (create-token-layer-opts req tl "Words" {:overlap-mode "non-overlapping"
                                                          :parent-token-layer-id s}))
        m (id-of (create-token-layer-opts req tl "Morphemes" {:overlap-mode "non-overlapping"
                                                              :parent-token-layer-id w}))
        n (id-of (create-token-layer-opts req tl "Nodes" {:overlap-mode "any"}))
        gloss (id-of (create-span-layer req w "Gloss"))
        text (id-of (create-text req tl doc old-body))
        other-text (id-of (create-text req tl other old-body))
        words (extents-of old-body)
        mk (fn [layer exts]
             (-> (bulk-create-tokens req (mapv (fn [[b e]] {:token-layer-id layer :text text :begin b :end e}) exts))
                 :body :ids))
        _ (mk s [[0 24] [24 37]])
        w-ids (mk w words)
        _ (mk m words)
        n-ids (mk n (take 2 words))]
    (assert (= (count words) (count w-ids)))
    (assert-created (bulk-create-spans req (mapv (fn [id] {:span-layer-id gloss :tokens [id] :value "gl"}) w-ids)))
    {:project proj :doc doc :text text :other-text other-text :text-layer tl
     :layers {:s s :w w :m m :n n} :words (vec w-ids) :nodes (vec n-ids)}))

(defn- snapshot
  "The document as layer names and extents, so two projects compare."
  [{:keys [doc text]}]
  (let [body (-> (get-text admin-request text) :body :text/body)
        tls (->> (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc "?include-body=true")})
                 :body :document/text-layers
                 (mapcat :text-layer/token-layers))
        where (into {} (for [tl tls t (:token-layer/tokens tl)]
                         [(:token/id t) [(:token-layer/name tl) (:token/begin t) (:token/end t)]]))]
    {:body body
     :tokens (sort (vals where))
     :spans (sort (for [tl tls sl (:token-layer/span-layers tl) sp (:span-layer/spans sl)]
                    [(:span-layer/name sl) (:span/value sp) (mapv where (:span/tokens sp))]))}))

(def ^:private writes
  "Writes that change what a save of `doc` reads, each given the setup."
  {:token-layer-delete
   (fn [{:keys [layers]}]
     (api-call admin-request {:method :delete :path (str "/api/v1/token-layers/" (:m layers))}))
   :new-partitioning-layer
   (fn [{:keys [text-layer text]}]
     (let [c (id-of (create-token-layer-opts admin-request text-layer "Clauses" {:overlap-mode "partitioning"}))]
       (bulk-create-tokens admin-request [{:token-layer-id c :text text :begin 0 :end 8}
                                          {:token-layer-id c :text text :begin 8 :end 37}])))
   :body-save
   (fn [{:keys [text]}]
     (update-text admin-request text "the cat sat.\nthe dog ran.\n"))
   :token-delete
   (fn [{:keys [words]}]
     (delete-token admin-request (nth words 1)))
   :token-shift
   (fn [{:keys [nodes]}]
     (update-token admin-request (nth nodes 1) :begin 4 :end 11))
   :token-create
   (fn [{:keys [layers text]}]
     (create-token admin-request (:n layers) text 4 7))
   :other-document
   (fn [{:keys [other-text]}]
     (update-text admin-request other-text "another body"))})

(defn- save-with-write
  "Save `new-body` over the setup's text, running `write` in the middle of
  the save: after it read the newest operation and before it reads the text
  (`:before`), or after it worked the save out (`:after`). Returns the
  save's response, the write's, and the connection each plan read from."
  [ctx write at]
  (let [plan-save @#'st/save-plan
        calls (atom [])
        write-res (atom nil)
        writing? (atom false)
        run-write! #(do (reset! writing? true)
                        (reset! write-res (write ctx))
                        (reset! writing? false))]
    (with-redefs [st/save-plan (fn [db eid body]
                                 (if @writing?
                                   (plan-save db eid body)
                                   (let [first? (empty? @calls)
                                         _ (swap! calls conj (instance? java.sql.Connection db))
                                         _ (when (and first? (= at :before)) (run-write!))
                                         r (plan-save db eid body)]
                                     (when (and first? (= at :after)) (run-write!))
                                     r)))]
      {:save (update-text admin-request (:text ctx) new-body)
       :write @write-res
       :calls @calls})))

(deftest a-write-between-the-reads-and-the-lock-makes-the-save-work-it-out-again
  (doseq [[k write] writes
          at [:before :after]]
    (testing (str k " " at)
      (let [twin (setup (str "Twin " (name k) (name at)))
            _ (is (< (:status (write twin)) 300))
            _ (assert-ok (update-text admin-request (:text twin) new-body))
            ctx (setup (str "Raced " (name k) (name at)))
            {:keys [save write calls]} (save-with-write ctx write at)]
        (assert-ok save)
        (is (< (:status write) 300) "the write went through while the save worked")
        (is (= [false true] calls) "worked out before the lock, then again under it")
        (is (= (snapshot twin) (snapshot ctx)))))))

(deftest a-write-in-another-project-leaves-the-worked-out-save-standing
  (doseq [at [:before :after]]
    (let [elsewhere (setup (str "Elsewhere " (name at)))
          twin (setup (str "Twin " (name at)))
          _ (assert-ok (update-text admin-request (:text twin) new-body))
          ctx (setup (str "Here " (name at)))
          {:keys [save write calls]}
          (save-with-write ctx (fn [_] (update-text admin-request (:text elsewhere) "changed elsewhere")) at)]
      (assert-ok save)
      (is (< (:status write) 300))
      (is (= [false] calls) "worked out once, before the lock")
      (is (= (snapshot twin) (snapshot ctx)))
      (is (= new-body (-> (get-text admin-request (:text ctx)) :body :text/body))))))

(deftest a-save-the-plan-refuses-is-refused-under-the-lock
  (let [ctx (setup "Refused")
        res (api-call admin-request {:method :patch
                                     :path (str "/api/v1/texts/" (:text ctx))
                                     :body {:body (str "a" (char 0) "b")}})]
    (is (= 400 (:status res)))
    (is (= old-body (-> (get-text admin-request (:text ctx)) :body :text/body)))))

(deftest a-save-in-an-atomic-batch-is-worked-out-once-under-the-batch-lock
  (let [twin (setup "Batch twin")
        _ (assert-ok (update-token admin-request (nth (:nodes twin) 1) :begin 4 :end 11))
        _ (assert-ok (update-text admin-request (:text twin) new-body))
        ctx (setup "Batch")
        plan-save @#'st/save-plan
        calls (atom [])
        res (with-redefs [st/save-plan (fn [db eid body]
                                         (swap! calls conj (instance? java.sql.Connection db))
                                         (plan-save db eid body))]
              (api-call admin-request {:method :post :path "/api/v1/batch"
                                       :body [{:path (str "/api/v1/tokens/" (nth (:nodes ctx) 1))
                                               :method "patch" :body {:begin 4 :end 11}}
                                              {:path (str "/api/v1/texts/" (:text ctx))
                                               :method "patch" :body {:body new-body}}]}))]
    (is (= 200 (:status res)))
    (is (= [true] @calls))
    (is (= (snapshot twin) (snapshot ctx)))))

(defn- rows [sql & params]
  (plaid.sql.common/q plaid.fixtures/db (into [sql] params)))

(deftest every-write-to-texts-tokens-and-token-layers-names-its-project
  ;; What the save's check relies on: a write that changes a text, a token or
  ;; a token layer records an operation naming the project they belong to.
  (let [ctx (setup "Writers")
        {:keys [project doc text text-layer layers words nodes]} ctx
        req admin-request
        ok (fn [label res] (is (< (:status res) 300) (str label " " (:status res) " " (:body res))) res)
        _ (Thread/sleep 5)
        before (java.time.Instant/now)
        _ (Thread/sleep 5)
        t1 (id-of (ok "create" (create-token req (:n layers) text 0 7)))
        _ (ok "update" (update-token req t1 :begin 0 :end 11))
        _ (ok "split" (split-token req t1 4))
        _ (ok "shift-boundary" (shift-token-boundary req (nth words 2) :end 10))
        _ (ok "merge" (merge-tokens req (nth nodes 0) (nth nodes 1)))
        _ (ok "bulk-update" (bulk-update-tokens req [{:id (nth words 0) :metadata [{:op "set" :path ["k"] :value 1}]}]))
        _ (ok "delete" (delete-token req (nth words 4)))
        _ (ok "bulk-delete" (bulk-delete-tokens req [(nth words 5)]))
        _ (ok "body save" (update-text req text new-body))
        _ (ok "body ops" (api-call req {:method :patch :path (str "/api/v1/texts/" text)
                                        :body {:body [{:type "insert" :index 0 :value "x"}]}}))
        _ (ok "layer rename" (api-call req {:method :patch :path (str "/api/v1/token-layers/" (:n layers))
                                            :body {:name "Nodes2"}}))
        _ (ok "layer shift" (api-call req {:method :post :path (str "/api/v1/token-layers/" (:n layers) "/shift")
                                           :body {:direction "up"}}))
        copy (-> (ok "copy" (api-call req {:method :post :path (str "/api/v1/documents/" doc "/copy")
                                           :body {:name "Copy"}}))
                 :body :id)
        _ (ok "restore" (api-call req {:method :post
                                       :path (str "/api/v1/documents/" doc "/restore?as-of=" before)}))
        _ (ok "layer delete" (api-call req {:method :delete :path (str "/api/v1/token-layers/" (:m layers))}))
        _ (ok "text delete" (delete-text req text))
        _ (ok "document delete" (api-call req {:method :delete :path (str "/api/v1/documents/" copy)}))
        _ (ok "text layer delete" (api-call req {:method :delete :path (str "/api/v1/text-layers/" text-layer)}))
        audited (rows (str "SELECT a.target_table AS t, count(*) AS n FROM audit_writes a"
                           " JOIN operations o ON o.id = a.op_id"
                           " WHERE a.target_table IN ('texts', 'tokens', 'token_layers') AND o.ts > ?"
                           " GROUP BY a.target_table")
                      (plaid.sql.common/instant->iso before))
        stray (rows (str "SELECT o.op_type AS op, a.target_table AS t FROM audit_writes a"
                         " JOIN operations o ON o.id = a.op_id"
                         " WHERE a.target_table IN ('texts', 'tokens', 'token_layers')"
                         " AND (o.project_id IS NULL OR o.project_id <> ?)")
                    project)]
    (is (= #{"texts" "tokens" "token_layers"} (set (map :t audited))) "every table was written")
    (is (empty? stray))))
