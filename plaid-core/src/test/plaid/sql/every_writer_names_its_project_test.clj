(ns plaid.sql.every-writer-names-its-project-test
  "Every writer of texts, tokens and token layers records an operation naming
  the project they belong to, and for a text or token write its document
  (for a token layer write no document). A standing rule (R2-RULES, Text
  edits) that these read the operation's project and document for:
  - the being-deleted guard in `plaid.sql.operation/submit-operation*`, which
    refuses a write to a project being deleted only when the operation names
    its project,
  - project History (`plaid.sql.audit`, by `project_id`) and per-document
    History and the per-user last-edited column (by `document_id`),
  - the history purge of a deleted project (`plaid.sql.project/history-to-purge`
    and `stranded-history-project-ids`, by `project_id`),
  - the operation-group grant rule (`ensure-group-row!`, D27), which treats a
    write naming no project otherwise."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler admin-request api-call
                                    assert-created with-admin with-clean-db]]
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
  the first two words, a gloss span on every word."
  [name]
  (let [req admin-request
        proj (create-test-project req name)
        doc (create-test-document req proj "Doc")
        tl (id-of (create-text-layer req proj "TL"))
        s (id-of (create-token-layer-opts req tl "Sentences" {:overlap-mode "partitioning"}))
        w (id-of (create-token-layer-opts req tl "Words" {:overlap-mode "non-overlapping"
                                                          :parent-token-layer-id s}))
        m (id-of (create-token-layer-opts req tl "Morphemes" {:overlap-mode "non-overlapping"
                                                              :parent-token-layer-id w}))
        n (id-of (create-token-layer-opts req tl "Nodes" {:overlap-mode "any"}))
        gloss (id-of (create-span-layer req w "Gloss"))
        text (id-of (create-text req tl doc old-body))
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
    {:project proj :doc doc :text text :text-layer tl
     :layers {:s s :w w :m m :n n} :words (vec w-ids) :nodes (vec n-ids)}))

(defn- rows [sql & params]
  (plaid.sql.common/q plaid.fixtures/db (into [sql] params)))

(deftest every-write-to-texts-tokens-and-token-layers-names-its-project
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
        _ (ok "body edits" (api-call req {:method :patch :path (str "/api/v1/texts/" text)
                                          :body {:edits [{:type "delete" :index 0 :value 1}]}}))
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
        ;; A text or token write names the row's document (or none), and a
        ;; token layer write names no document.
        stray (rows (str "SELECT o.op_type AS op, a.target_table AS t FROM audit_writes a"
                         " JOIN operations o ON o.id = a.op_id"
                         " WHERE a.target_table IN ('texts', 'tokens', 'token_layers')"
                         " AND (o.project_id IS NULL OR o.project_id <> ?"
                         "      OR (a.target_table = 'token_layers' AND o.document_id IS NOT NULL)"
                         "      OR (a.target_table <> 'token_layers' AND o.document_id IS NOT NULL"
                         "          AND o.document_id IS NOT a.document_id))")
                    project)]
    (is (= #{"texts" "tokens" "token_layers"} (set (map :t audited))) "every table was written")
    (is (empty? stray))))
