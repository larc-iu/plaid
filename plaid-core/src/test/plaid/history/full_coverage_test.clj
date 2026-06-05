(ns plaid.history.full-coverage-test
  "Exhaustive audit-log → history coverage.

  The history replica is fed ENTIRELY from `audit_writes`, and the replayer
  dispatches on (target_table, change_type). The risk surface is therefore
  every distinct OPERATION TYPE (the `:type` passed to `submit-operation!`),
  because each one produces a particular set of audit rows. This namespace
  gives two layers of assurance:

  BREADTH (`exhaustive-op-type-coverage-and-parity`):
    - Exercise EVERY one of the known operation types at least once through
      the REST surface.
    - Mechanically prove coverage: `SELECT DISTINCT op_type FROM operations`
      must equal the known set (any miss is named; any NEW op type the source
      grows without updating this test also fails — a deliberate guard that
      forces the author to consider history replay for new ops).
    - Prove the tailer never stalled and drained fully.
    - Prove OLTP == history (`?as-of=`) deep-read for the richly-populated
      survivor document — one reconciliation that validates the cumulative
      replay of all those op types working together.

  DEPTH (the `depth-*` deftests): the op families most susceptible to replay
  bugs (metadata nil-strip, precedence clear, cascade delete, token
  split/merge, junction-to-empty), each repeated with varied shapes AND
  asserted at INTERMEDIATE timestamps. End-state parity has a blind spot —
  a wrong replay that a later op overwrites still reconciles at the end — so
  the depth scenarios time-travel to the instant right after each risky
  mutation, where an overwritten bug is still visible.

  Regenerate `known-op-types` after adding an operation:
    grep -rhoE \":type :[a-z-]+/[a-z-]+\" src/main/plaid/sql/*.clj | sort -u"
  (:require [clojure.core.async :as async]
            [clojure.data.json :as json]
            [clojure.set :as set]
            [clojure.test :refer :all]
            [clojure.walk :as walk]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request api-call assert-created assert-ok
                                    assert-status assert-no-content
                                    with-admin with-test-users with-clean-db]]
            [plaid.history.core :as history]
            [plaid.history.replayer :as replayer]
            [plaid.history.tailer :as tailer]
            [plaid.sql.project :as sql-project]
            [plaid.sql.user :as sql-user]
            [plaid.sql.vocab-layer :as sql-vocab]
            [plaid.test-helpers :refer :all]
            [xtdb.api :as xt]
            [xtdb.node :as xtn]))

;; ============================================================
;; Per-test history node + tailer (mirrors integration-test harness)
;; ============================================================

(def ^:dynamic ^:private *history-node* nil)

(defn- with-test-history-node [f]
  (async/poll! history/nudge-chan)
  (with-open [node (xtn/start-node {})]
    (binding [*history-node* node]
      (with-redefs [history/enabled? (constantly true)
                    history/node node]
        (let [done (#'tailer/run-loop! plaid.fixtures/db node (history/history-config))]
          (try
            (f)
            (finally
              (when-let [stop @@#'tailer/stop-chan]
                (async/close! stop))
              (async/alt!! done :done (async/timeout 5000) :timeout))))))))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- drain! []
  (or (tailer/await-drained! plaid.fixtures/db *history-node* 8000)
      (throw (ex-info "tailer drain timed out" {}))))

(defn- latest-op-ts []
  (-> (jdbc/execute-one!
       plaid.fixtures/db
       ["SELECT ts FROM operations ORDER BY ts DESC, id DESC LIMIT 1"]
       {:builder-fn rs/as-unqualified-maps})
      :ts))

(defn- distinct-op-types []
  (->> (jdbc/execute! plaid.fixtures/db ["SELECT DISTINCT op_type FROM operations"]
                      {:builder-fn rs/as-unqualified-maps})
       (map :op_type)
       set))

(defn- distinct-audit-shapes []
  (->> (jdbc/execute! plaid.fixtures/db
                      ["SELECT DISTINCT target_table, change_type FROM audit_writes"]
                      {:builder-fn rs/as-unqualified-maps})
       (map (juxt :target_table :change_type))
       set))

(defn- get-doc-as-of
  ([doc-id ts] (get-doc-as-of doc-id ts true))
  ([doc-id ts include-body?]
   (api-call admin-request
             {:method :get
              :path (str "/api/v1/documents/" doc-id "?as-of=" ts
                         (when include-body? "&include-body=true"))})))

(defn- tailer-running? []
  (= :running (:tailer-status (history/cursor-read *history-node*))))

(defn- created-id
  "Assert a create response is 201 and return its :id. Guards setup so a
  silently-rejected create (4xx) can't leave a nil id that makes a later
  parity comparison reconcile two equally-degenerate trees."
  [resp]
  (assert-created resp)
  (-> resp :body :id))

;; ============================================================
;; Raw helpers for op types without a test-helper wrapper
;; ============================================================

(defn- patch-layer-name [layer-path id name]
  (api-call admin-request {:method :patch
                           :path (str "/api/v1/" layer-path "/" id)
                           :body {:name name}}))

(defn- shift-layer [layer-path id direction]
  (api-call admin-request {:method :post
                           :path (str "/api/v1/" layer-path "/" id "/shift")
                           :body {:direction direction}}))

(defn- delete-layer [layer-path id]
  (api-call admin-request {:method :delete :path (str "/api/v1/" layer-path "/" id)}))

(defn- set-layer-config [layer-path id ns* key* value]
  (api-call admin-request {:method :put
                           :path (str "/api/v1/" layer-path "/" id "/config/" ns* "/" key*)
                           :body value}))

(defn- delete-layer-config [layer-path id ns* key*]
  (api-call admin-request {:method :delete
                           :path (str "/api/v1/" layer-path "/" id "/config/" ns* "/" key*)}))

(defn- create-user! [username admin?]
  (api-call admin-request {:method :post
                           :path "/api/v1/users"
                           :body {:username username :password "correcthorsebatterystaple"
                                  :is-admin admin?}}))

(defn- update-user! [user-id]
  (api-call admin-request {:method :patch
                           :path (str "/api/v1/users/" user-id)
                           :body {:password "newcorrecthorsebatterystaple"}}))

(defn- delete-user! [user-id]
  (api-call admin-request {:method :delete :path (str "/api/v1/users/" user-id)}))

(defn- update-project-name [proj-id name]
  (api-call admin-request {:method :patch
                           :path (str "/api/v1/projects/" proj-id)
                           :body {:name name}}))

(defn- proj-role [method role proj-id user-id]
  (api-call admin-request {:method method
                           :path (str "/api/v1/projects/" proj-id "/" role "/" user-id)}))

(defn- delete-document! [doc-id]
  (api-call admin-request {:method :delete :path (str "/api/v1/documents/" doc-id)}))

(defn- delete-project! [proj-id]
  (api-call admin-request {:method :delete :path (str "/api/v1/projects/" proj-id)}))

;; ============================================================
;; Known operation-type set (the coverage target)
;; ============================================================

(def ^:private known-op-types
  #{"document/create" "document/delete" "document/delete-metadata"
    "document/patch-metadata" "document/set-metadata" "document/update"
    "layer/assoc-editor-config-pair" "layer/dissoc-editor-config-pair"
    "project/add-maintainer" "project/add-reader" "project/add-vocab"
    "project/add-writer" "project/create" "project/delete"
    "project/remove-maintainer" "project/remove-reader" "project/remove-vocab"
    "project/remove-writer" "project/update"
    "relation/bulk-create" "relation/bulk-delete" "relation/create"
    "relation/delete" "relation/delete-metadata" "relation/patch-metadata"
    "relation/set-metadata"
    "relation/update-attributes" "relation/update-endpoint"
    "relation-layer/create" "relation-layer/delete" "relation-layer/shift"
    "relation-layer/update"
    "span/bulk-create" "span/bulk-delete" "span/create" "span/delete"
    "span/delete-metadata" "span/patch-metadata" "span/remove-token"
    "span/set-metadata"
    "span/update-attributes" "span/update-tokens"
    "span-layer/create" "span-layer/delete" "span-layer/shift" "span-layer/update"
    "text/create" "text/delete" "text/delete-metadata" "text/patch-metadata"
    "text/set-metadata"
    "text/update-body"
    "text-layer/create" "text-layer/delete" "text-layer/shift" "text-layer/update"
    "token/bulk-create" "token/bulk-delete" "token/create" "token/delete"
    "token/delete-metadata" "token/merge" "token/patch-metadata"
    "token/set-metadata"
    "token/shift-boundary" "token/split" "token/update"
    "token-layer/create" "token-layer/delete" "token-layer/shift"
    "token-layer/update"
    "user/create" "user/delete" "user/update"
    "api-token/create" "api-token/revoke"
    "vocab/add-maintainer" "vocab/create" "vocab/delete"
    "vocab/remove-maintainer" "vocab/update"
    "vocab-item/create" "vocab-item/delete" "vocab-item/delete-metadata"
    "vocab-item/merge" "vocab-item/patch-metadata" "vocab-item/set-metadata"
    "vocab-link/create" "vocab-link/delete" "vocab-link/delete-metadata"
    "vocab-link/patch-metadata" "vocab-link/set-metadata"})

;; Operation types defined in source but NOT reachable through any REST route
;; on the SQL port — they cannot be exercised, so they're excluded from the
;; coverage target. Keep this list TINY and justified; each entry is a latent
;; dead-code smell worth revisiting.
;;   span/remove-token: `plaid.sql.span/remove-token` (the only emitter) has no
;;     caller. PUT /spans/:id/tokens routes to `set-tokens` (→ span/update-tokens),
;;     and the token-delete cascade folds span-token removal under :token/delete.
;;     Verified 2026-05-29: a token-in-a-span delete produces 0 span/remove-token
;;     rows. Vestigial from the v2 port.
(def ^:private rest-unreachable-op-types
  #{"span/remove-token"})

(def ^:private expected-op-types
  (set/difference known-op-types rest-unreachable-op-types))

;; Handled by the replayer: 14 mirrored tables × {insert,update,delete} plus
;; the documents-only doc-version-bump sentinel. Anything outside this stalls
;; the tailer, so a new (table, change_type) pair should surface here loudly.
(def ^:private mirrored-tables
  #{"users" "projects" "documents" "text_layers" "token_layers" "span_layers"
    "relation_layers" "texts" "tokens" "spans" "relations" "vocab_layers"
    "vocab_items" "vocab_links" "api_tokens"})

(def ^:private handled-change-types
  #{"insert" "update" "delete" "doc-version-bump"})

;; ============================================================
;; Parity comparison (mirrors integration-test normalization)
;; ============================================================

(defn- normalize-for-compare [body]
  (walk/postwalk
   (fn [x]
     (if (and (map? x) (contains? x :vocab-layer/vocab-links))
       (update x :vocab-layer/vocab-links (fn [vs] (vec (sort-by :vocab-link/id vs))))
       x))
   body))

(defn- spans-from-body [body]
  (for [tl (:document/text-layers body)
        tkl (:text-layer/token-layers tl)
        sl (:token-layer/span-layers tkl)
        s (:span-layer/spans sl)]
    s))

(defn- tokens-from-body [body]
  (for [tl (:document/text-layers body)
        tkl (:text-layer/token-layers tl)
        t (:token-layer/tokens tkl)]
    t))

;; ============================================================
;; BREADTH: every op type, coverage proof, parity, no stall
;; ============================================================

(deftest ^:integration exhaustive-op-type-coverage-and-parity
  (with-test-history-node
    (fn []
      ;; ---- throwaway user for ACL + user lifecycle ----
      (let [u-acl (str "fc-acl-" (random-uuid) "@example.com")
            u-maint2 (str "fc-maint2-" (random-uuid) "@example.com")
            u-throw (str "fc-throw-" (random-uuid) "@example.com")
            _ (assert-created (create-user! u-acl false))           ; user/create
            _ (assert-created (create-user! u-maint2 false))
            _ (assert-created (create-user! u-throw false))
            _ (assert-ok (update-user! u-throw))                    ; user/update

            ;; ---- API tokens: mint + revoke (these are audited, so the history
            ;;      replayer must mirror the api_tokens table or the tailer
            ;;      stalls — see mirrored-tables / replayer/table->spec) ----
            fc-tok-resp (api-call admin-request
                                  {:method :post
                                   :path (str "/api/v1/users/" u-throw "/tokens")
                                   :body {:name "FC API Token"}})
            _ (assert-created fc-tok-resp)                          ; api-token/create
            _ (assert-status 204 (api-call admin-request
                                           {:method :delete
                                            :path (str "/api/v1/users/" u-throw
                                                       "/tokens/" (-> fc-tok-resp :body :id))})) ; api-token/revoke

            ;; ---- survivor project (parity target) ----
            proj (create-test-project admin-request "FC-Survivor")   ; project/create
            _ (assert-ok (update-project-name proj "FC-Survivor-2")) ; project/update

            ;; project ACL lifecycle (folds :readers/:writers/:maintainers)
            _ (assert-status 204 (proj-role :post "readers" proj u-acl))     ; add-reader
            _ (assert-status 204 (proj-role :delete "readers" proj u-acl))   ; remove-reader
            _ (assert-status 204 (proj-role :post "writers" proj u-acl))     ; add-writer
            _ (assert-status 204 (proj-role :delete "writers" proj u-acl))   ; remove-writer
            ;; Two maintainers, then remove one: admins are NOT auto-added to a
            ;; project's maintainer list, and projects refuse to drop the LAST
            ;; maintainer (data-loss guard in remove-role!), so we need u-maint2
            ;; present for the remove to succeed and emit project/remove-maintainer.
            _ (assert-status 204 (proj-role :post "maintainers" proj u-acl))    ; add-maintainer
            _ (assert-status 204 (proj-role :post "maintainers" proj u-maint2)) ; add-maintainer
            _ (assert-status 204 (proj-role :delete "maintainers" proj u-acl))  ; remove-maintainer (u-maint2 remains)

            ;; ---- text layers (create/update/shift) + a throwaway to delete ----
            tlA (-> (create-text-layer admin-request proj "TLA") :body :id)  ; text-layer/create
            tlB (-> (create-text-layer admin-request proj "TLB") :body :id)
            tl-throw (-> (create-text-layer admin-request proj "TLthrow") :body :id)
            _ (assert-ok (patch-layer-name "text-layers" tlA "TLA-2"))       ; text-layer/update
            _ (assert-status 204 (shift-layer "text-layers" tlB "up"))       ; text-layer/shift
            ;; layer config assoc/dissoc
            _ (assert-no-content (set-layer-config "text-layers" tlA "ed" "color" {:hex "#00f"})) ; assoc
            _ (assert-no-content (delete-layer-config "text-layers" tlA "ed" "color"))     ; dissoc
            _ (assert-no-content (delete-layer "text-layers" tl-throw))      ; text-layer/delete

            ;; ---- token layers under tlA ----
            tklA (-> (create-token-layer admin-request tlA "TKLA" "any") :body :id) ; token-layer/create
            tklB (-> (create-token-layer admin-request tlA "TKLB" "any") :body :id)
            tkl-throw (-> (create-token-layer admin-request tlA "TKLthrow" "any") :body :id)
            _ (assert-ok (patch-layer-name "token-layers" tklA "TKLA-2"))    ; token-layer/update
            _ (assert-status 204 (shift-layer "token-layers" tklB "up"))     ; token-layer/shift
            _ (assert-no-content (delete-layer "token-layers" tkl-throw))    ; token-layer/delete

            ;; ---- span layers under tklA ----
            slA (-> (create-span-layer admin-request tklA "SLA") :body :id)  ; span-layer/create
            slB (-> (create-span-layer admin-request tklA "SLB") :body :id)
            sl-throw (-> (create-span-layer admin-request tklA "SLthrow") :body :id)
            _ (assert-ok (patch-layer-name "span-layers" slA "SLA-2"))       ; span-layer/update
            _ (assert-status 204 (shift-layer "span-layers" slB "up"))       ; span-layer/shift
            _ (assert-no-content (delete-layer "span-layers" sl-throw))      ; span-layer/delete

            ;; ---- relation layers under slA ----
            rlA (-> (create-relation-layer admin-request slA "RLA") :body :id) ; relation-layer/create
            rlB (-> (create-relation-layer admin-request slA "RLB") :body :id)
            rl-throw (-> (create-relation-layer admin-request slA "RLthrow") :body :id)
            _ (assert-ok (patch-layer-name "relation-layers" rlA "RLA-2"))   ; relation-layer/update
            _ (assert-status 204 (shift-layer "relation-layers" rlB "up"))   ; relation-layer/shift
            _ (assert-no-content (delete-layer "relation-layers" rl-throw))  ; relation-layer/delete

            ;; ---- survivor document ----
            doc (create-test-document admin-request proj "FC-Doc")           ; document/create
            _ (assert-ok (api-call admin-request {:method :patch
                                                  :path (str "/api/v1/documents/" doc)
                                                  :body {:name "FC-Doc-2"}})) ; document/update
            _ (assert-ok (update-document-metadata admin-request doc {"author" "alice"})) ; doc/set-metadata
            _ (assert-ok (patch-document-metadata admin-request doc {"editor" "bob"})) ; document/patch-metadata

            ;; ---- text (survivor + throwaway for delete/update-body/delete-metadata) ----
            text-id (-> (create-text admin-request tlA doc "alpha beta gamma delta epsilon zeta") :body :id) ; text/create
            _ (assert-ok (update-text-metadata admin-request text-id {"lang" "xx"}))  ; text/set-metadata
            _ (assert-ok (patch-text-metadata admin-request text-id {"reviewed" "yes"})) ; text/patch-metadata
            text-throw (-> (create-text admin-request tlB doc "throwaway body") :body :id)
            _ (assert-ok (update-text admin-request text-throw "throwaway body edited")) ; text/update-body
            _ (assert-ok (update-text-metadata admin-request text-throw {"k" "v"}))
            _ (assert-ok (delete-text-metadata admin-request text-throw))     ; text/delete-metadata
            _ (assert-status 204 (delete-text admin-request text-throw))              ; text/delete

            ;; ---- tokens (offsets: alpha0-5 beta6-10 gamma11-16 delta17-22 epsilon23-30 zeta31-35) ----
            t1 (-> (create-token admin-request tklA text-id 0 5) :body :id)  ; token/create
            t2 (-> (create-token admin-request tklA text-id 6 10) :body :id)
            t3 (-> (create-token admin-request tklA text-id 11 16) :body :id)
            t4 (-> (create-token admin-request tklA text-id 17 22) :body :id)
            t5 (-> (create-token admin-request tklA text-id 23 30) :body :id)
            t6 (-> (create-token admin-request tklA text-id 31 35) :body :id)
            _ (assert-ok (update-token admin-request t2 :precedence 1))      ; token/update
            _ (assert-ok (shift-token-boundary admin-request t6 :begin 32)) ; token/shift-boundary (returns 200 + token)
            ;; split t1 (0-5) at 2 -> t1 keeps 0-2, new token 2-5; then merge back
            split-new (-> (split-token admin-request t1 2) :body :id)        ; token/split
            _ (assert-ok (merge-tokens admin-request t1 split-new))          ; token/merge
            _ (assert-ok (update-token-metadata admin-request t2 {"pos" "NOUN"})) ; token/set-metadata
            _ (assert-ok (patch-token-metadata admin-request t2 {"lemma" "greet"})) ; token/patch-metadata
            _ (assert-ok (update-token-metadata admin-request t3 {"pos" "X"}))
            _ (assert-ok (delete-token-metadata admin-request t3))   ; token/delete-metadata
            ;; bulk-create + bulk-delete throwaway tokens (in throwaway layer to avoid overlap fuss)
            bulk-toks (-> (bulk-create-tokens admin-request
                                              [{:token-layer-id tklB :text text-id :begin 0 :end 3}
                                               {:token-layer-id tklB :text text-id :begin 3 :end 6}])
                          :body :ids)                                        ; token/bulk-create
            _ (assert-status 204 (bulk-delete-tokens admin-request bulk-toks)) ; token/bulk-delete
            tok-throw (-> (create-token admin-request tklB text-id 7 9) :body :id)
            _ (assert-no-content (delete-token admin-request tok-throw))     ; token/delete

            ;; ---- spans ----
            s1 (-> (create-span admin-request slA [t2] "GREETING") :body :id) ; span/create
            s2 (-> (create-span admin-request slA [t3] "PLACE") :body :id)
            _ (assert-ok (update-span admin-request s1 :value "INTERJECTION")) ; span/update-attributes
            _ (assert-ok (update-span-tokens admin-request s1 [t2 t4]))      ; span/update-tokens (add)
            _ (assert-ok (update-span-tokens admin-request s1 [t2]))         ; span/update-tokens (shrink; remove-token is vestigial)
            _ (assert-ok (update-span-metadata admin-request s1 {"conf" "hi"})) ; span/set-metadata
            _ (assert-ok (patch-span-metadata admin-request s1 {"src" "auto"})) ; span/patch-metadata
            _ (assert-ok (update-span-metadata admin-request s2 {"conf" "lo"}))
            _ (assert-ok (delete-span-metadata admin-request s2))    ; span/delete-metadata
            bulk-spans (-> (bulk-create-spans admin-request
                                              [{:span-layer-id slA :tokens [t5] :value "B1"}])
                           :body :ids)                                       ; span/bulk-create
            _ (assert-status 204 (bulk-delete-spans admin-request bulk-spans)) ; span/bulk-delete
            span-throw (-> (create-span admin-request slA [t6] "THROW") :body :id)
            _ (assert-status 204 (delete-span admin-request span-throw))     ; span/delete

            ;; ---- relations ----
            r1 (-> (create-relation admin-request rlA s1 s2 "modifies") :body :id) ; relation/create
            _ (assert-ok (update-relation admin-request r1 "governs"))       ; relation/update-attributes
            _ (assert-ok (update-relation-target admin-request r1 s1))       ; relation/update-endpoint
            _ (assert-ok (update-relation-target admin-request r1 s2))       ; (re-point back)
            _ (assert-ok (update-relation-metadata admin-request r1 {"w" "1"})) ; relation/set-metadata
            _ (assert-ok (patch-relation-metadata admin-request r1 {"note" "x"})) ; relation/patch-metadata
            r2 (-> (create-relation admin-request rlA s2 s1 "tmp") :body :id)
            _ (assert-ok (update-relation-metadata admin-request r2 {"w" "2"}))
            _ (assert-ok (delete-relation-metadata admin-request r2)) ; relation/delete-metadata
            bulk-rels (-> (bulk-create-relations admin-request
                                                 [{:relation-layer-id rlA :source s1 :target s2 :value "BR"}])
                          :body :ids)                                        ; relation/bulk-create
            _ (assert-status 204 (bulk-delete-relations admin-request bulk-rels)) ; relation/bulk-delete
            _ (assert-status 204 (delete-relation admin-request r2))         ; relation/delete

            ;; ---- vocab ----
            vS (-> (create-vocab-layer admin-request "FC-Vocab") :body :id)  ; vocab/create
            _ (assert-ok (update-vocab-layer admin-request vS {:name "FC-Vocab-2"})) ; vocab/update
            _ (assert-status 204 (link-vocab-to-project admin-request proj vS)) ; project/add-vocab
            _ (assert-status 204 (add-vocab-maintainer admin-request vS u-acl)) ; vocab/add-maintainer
            _ (assert-status 204 (remove-vocab-maintainer admin-request vS u-acl)) ; vocab/remove-maintainer
            viS (-> (create-vocab-item admin-request vS "hello") :body :id)  ; vocab-item/create
            _ (assert-ok (update-vocab-item admin-request viS "hallo"))      ; vocab-item/merge (PATCH form)
            _ (assert-ok (update-vocab-item-metadata admin-request viS {"gloss" "hi"})) ; vocab-item/set-metadata
            _ (assert-ok (patch-vocab-item-metadata admin-request viS {"ipa" "həˈloʊ"})) ; vocab-item/patch-metadata
            vi-throw (-> (create-vocab-item admin-request vS "tmpform") :body :id)
            _ (assert-ok (update-vocab-item-metadata admin-request vi-throw {"x" "y"}))
            _ (assert-ok (delete-vocab-item-metadata admin-request vi-throw)) ; vocab-item/delete-metadata
            _ (assert-status 204 (delete-vocab-item admin-request vi-throw)) ; vocab-item/delete
            vlS (-> (create-vocab-link admin-request viS [t2]) :body :id)    ; vocab-link/create
            _ (assert-ok (update-vocab-link-metadata admin-request vlS {"src" "manual"})) ; vocab-link/set-metadata
            _ (assert-ok (patch-vocab-link-metadata admin-request vlS {"score" "9"})) ; vocab-link/patch-metadata
            vl-throw (-> (create-vocab-link admin-request viS [t3]) :body :id)
            _ (assert-ok (update-vocab-link-metadata admin-request vl-throw {"a" "b"}))
            _ (assert-ok (delete-vocab-link-metadata admin-request vl-throw)) ; vocab-link/delete-metadata
            _ (assert-status 204 (delete-vocab-link admin-request vl-throw)) ; vocab-link/delete

            ;; throwaway vocab to exercise vocab/delete + project/remove-vocab
            vT (-> (create-vocab-layer admin-request "FC-VocabThrow") :body :id)
            _ (assert-status 204 (link-vocab-to-project admin-request proj vT))
            _ (assert-status 204 (unlink-vocab-from-project admin-request proj vT)) ; project/remove-vocab
            _ (assert-status 204 (delete-vocab-layer admin-request vT))      ; vocab/delete

            ;; ---- throwaway document for document/delete-metadata + document/delete ----
            doc-throw (create-test-document admin-request proj "FC-DocThrow")
            _ (assert-ok (update-document-metadata admin-request doc-throw {"k" "v"}))
            _ (assert-ok (delete-document-metadata admin-request doc-throw)) ; document/delete-metadata
            _ (assert-no-content (delete-document! doc-throw))               ; document/delete

            ;; ---- throwaway project + user for project/delete + user/delete ----
            proj-throw (create-test-project admin-request "FC-ProjThrow")
            _ (assert-no-content (delete-project! proj-throw))               ; project/delete
            _ (assert-no-content (delete-user! u-throw))                     ; user/delete

            ts (latest-op-ts)
            _ (drain!)]

        ;; NOTE: this is an OLTP-side fact — `operations` rows exist for every
        ;; op type. It proves we EXERCISED each op, not that history replayed it
        ;; correctly. The replay-correctness bridge is the "tailer not stalled"
        ;; + "audit shapes handled" + "OLTP==history parity" assertions below; this
        ;; one only guarantees the breadth of what those then validate.
        (testing "every REST-reachable operation type was exercised (OLTP-side breadth)"
          (let [actual (distinct-op-types)
                missing (set/difference expected-op-types actual)
                unexpected (set/difference actual known-op-types)]
            (is (empty? missing)
                (str "operation types expected but NOT exercised by this test: " missing))
            (is (empty? unexpected)
                (str "operation types exercised but NOT in known-op-types — source grew a new "
                     "op type; confirm history replay handles it, then add it here: " unexpected))))

        (testing "every emitted audit shape is one the replayer handles"
          (doseq [[table change] (distinct-audit-shapes)]
            (is (contains? mirrored-tables table)
                (str "audit row targets un-mirrored table (would stall tailer): " table))
            (is (contains? handled-change-types change)
                (str "audit row has un-handled change_type (would stall tailer): " change))))

        (testing "tailer applied everything without stalling"
          (is (tailer-running?) "tailer status is :running after replaying every op type"))

        (testing "OLTP == history deep-read for the fully-populated survivor doc"
          (let [oltp (-> (api-call admin-request
                                   {:method :get
                                    :path (str "/api/v1/documents/" doc "?include-body=true")})
                         :body normalize-for-compare)
                history (-> (get-doc-as-of doc ts true) :body normalize-for-compare)]
            (is (= oltp history)
                "survivor document reconstructs identically through history after every op type fired")))

        (testing "deleted throwaway doc is absent from both OLTP and history at latest ts"
          (is (= 404 (:status (api-call admin-request
                                        {:method :get
                                         :path (str "/api/v1/documents/" doc-throw)}))))
          (is (= 404 (:status (get-doc-as-of doc-throw ts false)))))))))

;; ============================================================
;; DEPTH: metadata set -> clear -> reset, asserted at each ts
;; ============================================================

(deftest ^:integration depth-metadata-clear-cycle-time-travels
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "FC-MetaProj")
            doc (create-test-document admin-request proj "D")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL" "any") :body :id)
            sl (-> (create-span-layer admin-request tkl "SL") :body :id)
            text-id (-> (create-text admin-request tl doc "hello world") :body :id)
            t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
            s1 (-> (create-span admin-request sl [t1] "V") :body :id)
            span-meta-at (fn [ts]
                           (-> (get-doc-as-of doc ts) :body spans-from-body first :metadata))]
        ;; set
        (assert-ok (update-span-metadata admin-request s1 {"a" "1"}))
        (let [ts-set (latest-op-ts)] (drain!)
          ;; clear  (the nil-strip-susceptible direction)
             (assert-ok (delete-span-metadata admin-request s1))
             (let [ts-clear (latest-op-ts)] (drain!)
            ;; reset to a different value
                  (assert-ok (update-span-metadata admin-request s1 {"b" "2"}))
                  (let [ts-reset (latest-op-ts)] (drain!)
                       (testing "as_of right after SET shows the metadata"
                         (is (= {"a" "1"} (span-meta-at ts-set))))
                       (testing "as_of right after CLEAR shows it gone (not the overwritten end-state)"
                         (is (nil? (span-meta-at ts-clear))))
                       (testing "as_of right after RESET shows the new metadata"
                         (is (= {"b" "2"} (span-meta-at ts-reset)))))))))))

;; ============================================================
;; DEPTH: precedence set -> null -> set (D2 regression), per-ts
;; ============================================================

(deftest ^:integration depth-precedence-clear-cycle-time-travels
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "FC-PrecProj")
            doc (create-test-document admin-request proj "D")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL" "any") :body :id)
            text-id (-> (create-text admin-request tl doc "hello world") :body :id)
            t1 (-> (create-token admin-request tkl text-id 0 5 100) :body :id)
            prec-at (fn [ts]
                      (->> (get-doc-as-of doc ts) :body tokens-from-body
                           (filter #(= t1 (:token/id %))) first :token/precedence))]
        (let [ts-set (latest-op-ts)] (drain!)
          ;; clear precedence via explicit null
             (assert-ok (api-call admin-request {:method :patch
                                                 :path (str "/api/v1/tokens/" t1)
                                                 :body {:precedence nil}}))
             (let [ts-clear (latest-op-ts)] (drain!)
                  (assert-ok (update-token admin-request t1 :precedence 7))
                  (let [ts-reset (latest-op-ts)] (drain!)
                       (testing "precedence 100 at set ts" (is (= 100 (prec-at ts-set))))
                       (testing "precedence cleared (nil) at clear ts" (is (nil? (prec-at ts-clear))))
                       (testing "precedence 7 at reset ts" (is (= 7 (prec-at ts-reset)))))))))))

;; ============================================================
;; DEPTH: cascade delete preserves history, removes at later ts
;; ============================================================

(deftest ^:integration depth-cascade-delete-token-layer-time-travels
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "FC-CascadeProj")
            doc (create-test-document admin-request proj "D")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL" "any") :body :id)
            sl (-> (create-span-layer admin-request tkl "SL") :body :id)
            rl (-> (create-relation-layer admin-request sl "RL") :body :id)
            text-id (-> (create-text admin-request tl doc "hello world foo") :body :id)
            t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
            t2 (-> (create-token admin-request tkl text-id 6 11) :body :id)
            s1 (-> (create-span admin-request sl [t1] "A") :body :id)
            s2 (-> (create-span admin-request sl [t2] "B") :body :id)
            _r1 (-> (create-relation admin-request rl s1 s2 "rel") :body :id)
            ts-full (latest-op-ts)
            _ (drain!)]
        (let [token-ids-at (fn [ts] (->> (get-doc-as-of doc ts) :body tokens-from-body
                                         (map :token/id) set))
              span-vals-at (fn [ts] (->> (get-doc-as-of doc ts) :body spans-from-body
                                         (map :span/value) set))]
          (testing "full subtree present at ts-full (by id/value, not just count)"
            (is (= #{t1 t2} (token-ids-at ts-full)))
            (is (= #{"A" "B"} (span-vals-at ts-full))))
          ;; Delete the token layer — cascades tokens -> spans -> relations.
          (assert-no-content (delete-layer "token-layers" tkl))
          (let [ts-after (latest-op-ts)]
            (drain!)
            (testing "ts-full STILL shows the complete pre-delete subtree (no retroactive loss)"
              (is (= #{t1 t2} (token-ids-at ts-full)))
              (is (= #{"A" "B"} (span-vals-at ts-full))))
            (testing "ts-after shows the whole subtree gone (cascade replayed)"
              (let [body (-> (get-doc-as-of doc ts-after) :body)]
                (is (empty? (tokens-from-body body)))
                (is (empty? (spans-from-body body)))))
            (testing "tailer did not stall on the cascade delete"
              (is (tailer-running?)))))))))

;; ============================================================
;; DEPTH: token split / merge with an attached span, per-ts
;; ============================================================

(deftest ^:integration depth-token-split-merge-time-travels
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "FC-SplitProj")
            doc (create-test-document admin-request proj "D")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL" "any") :body :id)
            sl (-> (create-span-layer admin-request tkl "SL") :body :id)
            text-id (-> (create-text admin-request tl doc "alpha beta") :body :id)
            t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
            _s1 (-> (create-span admin-request sl [t1] "ON-T1") :body :id)
            ts-pre (latest-op-ts)
            _ (drain!)
            new-tok (-> (split-token admin-request t1 2) :body :id)
            ts-split (latest-op-ts)
            _ (drain!)
            _ (assert-ok (merge-tokens admin-request t1 new-tok))
            ts-merge (latest-op-ts)
            _ (drain!)
            toks-at (fn [ts] (->> (get-doc-as-of doc ts) :body tokens-from-body
                                  (map (juxt :token/id (juxt :token/begin :token/end)))
                                  (into {})))
            span-toks-at (fn [ts] (-> (get-doc-as-of doc ts) :body spans-from-body first :span/tokens))]
        ;; Value-level (not count-only): a split/merge that produced the wrong
        ;; offsets or dropped the span off the retained half must fail here.
        (testing "pre-split: exactly t1 at (0,5), span on t1"
          (is (= {t1 [0 5]} (toks-at ts-pre)))
          (is (= [t1] (span-toks-at ts-pre))))
        (testing "post-split: t1 keeps its id at (0,2), new token at (2,5), span still on t1"
          (is (= {t1 [0 2] new-tok [2 5]} (toks-at ts-split))
              "split retains the left-half id and offsets, creates the right half")
          (is (= [t1] (span-toks-at ts-split))
              "the span stays on the retained left half across the split"))
        (testing "post-merge: single token t1 back at (0,5), span intact"
          (is (= {t1 [0 5]} (toks-at ts-merge)))
          (is (= [t1] (span-toks-at ts-merge))))
        (testing "tailer healthy throughout"
          (is (tailer-running?)))))))

;; ============================================================
;; DEPTH: junction shrink to empty (span auto-deletes), per-ts
;; ============================================================

(deftest ^:integration depth-span-tokens-shrink-to-empty-time-travels
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "FC-ShrinkProj")
            doc (create-test-document admin-request proj "D")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL" "any") :body :id)
            sl (-> (create-span-layer admin-request tkl "SL") :body :id)
            text-id (-> (create-text admin-request tl doc "alpha beta gamma") :body :id)
            t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
            t2 (-> (create-token admin-request tkl text-id 6 10) :body :id)
            s1 (-> (create-span admin-request sl [t1 t2] "TWO") :body :id)
            ts-two (latest-op-ts)
            _ (drain!)
            ;; remove one token (remove-token); span still has t1
            _ (assert-ok (update-span-tokens admin-request s1 [t1]))
            ts-one (latest-op-ts)
            _ (drain!)
            ;; delete the last token -> span auto-deletes (cascade)
            _ (assert-no-content (delete-token admin-request t1))
            ts-gone (latest-op-ts)
            _ (drain!)
            span-tokens-at (fn [ts]
                             (-> (get-doc-as-of doc ts) :body spans-from-body first :span/tokens))]
        (testing "ts-two: span covers both tokens"
          (is (= #{t1 t2} (set (span-tokens-at ts-two)))))
        (testing "ts-one: span covers only t1 after remove-token"
          (is (= [t1] (span-tokens-at ts-one))))
        (testing "ts-gone: span auto-deleted when its last token was removed"
          (is (empty? (spans-from-body (-> (get-doc-as-of doc ts-gone) :body)))))
        (testing "tailer healthy throughout"
          (is (tailer-running?)))))))

;; ============================================================
;; GAP 1: non-document entity rows reconcile OLTP <-> history
;; ============================================================
;;
;; Every parity test elsewhere reconciles a DOCUMENT deep-read. Projects
;; (intrinsic cols + folded :readers/:writers/:maintainers + :config),
;; users (:is-admin, :password-changes), and vocab-layers (folded
;; :maintainers + :config) are replayed into history but their stored rows
;; were never compared to OLTP — a wrong col-rename, dropped ACL fold, or
;; mis-coerced :is-admin would sit silently wrong. This reads the raw
;; history.* rows and compares to the OLTP getters.

(defn- history-row [node sql params]
  (first (xt/q node (into [sql] params))))

(defn- truthy-flag [v]
  ;; history may store SQLite is_admin as 0/1 (int) or true/false; normalize.
  (boolean (or (true? v) (= 1 v) (= 1N v))))

(deftest ^:integration history-entity-row-parity-projects-users-vocab
  (with-test-history-node
    (fn []
      (let [db plaid.fixtures/db
            node *history-node*
            ;; Distinct user per role: project roles are one-per-user, so
            ;; granting the same user two roles just moves it (leaving a role
            ;; empty). ua is is-admin TRUE so the is-admin truthy branch is
            ;; exercised (not just the falsy default).
            ur (str "ep-r-" (random-uuid) "@example.com")
            uw (str "ep-w-" (random-uuid) "@example.com")
            um (str "ep-m-" (random-uuid) "@example.com")
            ua (str "ep-admin-" (random-uuid) "@example.com")
            _ (assert-created (create-user! ur false))
            _ (assert-created (create-user! uw false))
            _ (assert-created (create-user! um false))
            _ (assert-created (create-user! ua true))
            proj (create-test-project admin-request "EntityParityProj")
            _ (assert-status 204 (proj-role :post "readers" proj ur))
            _ (assert-status 204 (proj-role :post "writers" proj uw))
            _ (assert-status 204 (proj-role :post "maintainers" proj um))
            _ (assert-no-content (set-layer-config "projects" proj "ed" "k" {:v 1}))
            vS (-> (create-vocab-layer admin-request "EP-Vocab") :body :id)
            _ (assert-status 204 (link-vocab-to-project admin-request proj vS))
            _ (assert-status 204 (add-vocab-maintainer admin-request vS ur))
            _ (assert-status 204 (add-vocab-maintainer admin-request vS uw))
            _ (drain!)]
        (testing "project: name + folded ACLs + config reconcile"
          (let [oltp (sql-project/get db proj)
                history (history-row node (str "SELECT _id AS id, project$name AS name, "
                                               "readers, writers, maintainers, config "
                                               "FROM history.projects WHERE _id = ?") [proj])]
            (is (some? history) "project row present in history")
            (is (= (:project/name oltp) (:name history)))
            ;; non-empty guards: a silently-dropped grant/config would make a
            ;; side empty and these assertions vacuous; pin them non-empty first.
            (is (seq (:project/readers oltp)) "readers actually granted (not vacuously empty)")
            (is (seq (:project/maintainers oltp)) "maintainers actually granted")
            (is (seq (json/read-str (:config history))) "config actually set (not {} both sides)")
            (is (= (set (:project/readers oltp)) (set (:readers history))) "readers fold")
            (is (= (set (:project/writers oltp)) (set (:writers history))) "writers fold")
            (is (= (set (:project/maintainers oltp)) (set (:maintainers history))) "maintainers fold")
            (is (= (:config oltp) (json/read-str (:config history))) "project config round-trips")))
        (testing "vocab-layer: name + folded maintainers reconcile"
          (let [oltp (sql-vocab/get db vS)
                history (history-row node (str "SELECT _id AS id, vocab$name AS name, "
                                               "maintainers, config FROM history.vocab_layers WHERE _id = ?") [vS])]
            (is (some? history) "vocab-layer row present in history")
            (is (= (:vocab/name oltp) (:name history)))
            (is (= (set (:vocab/maintainers oltp)) (set (:maintainers history))) "vocab maintainers fold")))
        (testing "user: username + is-admin + password-changes reconcile (both polarities)"
          ;; Aliases are underscore-free: xt/q kebab-cases result keys, so
          ;; `AS is_admin` would surface as `:is-admin` (a casing trap that made
          ;; the original test read nil and pass vacuously). `AS isadmin` keeps
          ;; the key stable.
          (let [sel (str "SELECT _id AS id, user$username AS username, "
                         "user$is_admin AS isadmin, user$password_changes AS pwchanges "
                         "FROM history.users WHERE _id = ?")]
            (doseq [uid [ur ua]]
              (let [oltp (sql-user/get db uid)
                    history (history-row node sel [uid])]
                (is (some? history) (str "user row present in history: " uid))
                (is (= (:user/username oltp) (:username history)))
                (is (= (boolean (:user/is-admin oltp)) (truthy-flag (:isadmin history)))
                    (str "is-admin coerces equal for " uid))
                ;; nil (OLTP getter omits a zero counter) and 0 (history stores the
                ;; column) both mean "no password changes" — normalize.
                (is (= (or (:user/password-changes oltp) 0) (or (:pwchanges history) 0))
                    "password-changes reconciles")))
            ;; Pin BOTH polarities so the comparison can't pass by the falsy
            ;; default alone (a dropped is_admin column would read nil->false
            ;; and silently match the non-admin user — exactly the original bug).
            (is (false? (truthy-flag (:isadmin (history-row node sel [ur])))) "non-admin reads false")
            (is (true? (truthy-flag (:isadmin (history-row node sel [ua])))) "admin reads true")))))))

;; ============================================================
;; GAP 2: atomic batch — committed replays whole; rolled-back is invisible
;; ============================================================

(deftest ^:integration history-batch-commits-all-ops
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "BatchOkProj")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL" "any") :body :id)
            doc (create-test-document admin-request proj "BatchDoc")
            text-id (-> (create-text admin-request tl doc "hello world") :body :id)
            batch [{:path "/api/v1/tokens" :method "post"
                    :body {:token-layer-id tkl :text text-id :begin 0 :end 5}}
                   {:path "/api/v1/tokens" :method "post"
                    :body {:token-layer-id tkl :text text-id :begin 6 :end 11}}]
            res (api-call admin-request {:method :post :path "/api/v1/batch" :body batch})
            _ (assert-ok res)
            ts (latest-op-ts)
            _ (drain!)]
        (testing "both batched tokens replayed; doc reconciles OLTP==history"
          (is (= 2 (count (tokens-from-body (-> (get-doc-as-of doc ts) :body)))))
          (let [oltp (-> (api-call admin-request {:method :get
                                                  :path (str "/api/v1/documents/" doc "?include-body=true")})
                         :body normalize-for-compare)
                history (-> (get-doc-as-of doc ts true) :body normalize-for-compare)]
            (is (= oltp history))))))))

(deftest ^:integration history-batch-rollback-leaves-history-untouched
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "BatchRollbackProj")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL" "any") :body :id)
            doc (create-test-document admin-request proj "BatchDoc")
            text-id (-> (create-text admin-request tl doc "hello world") :body :id)
            _ (drain!)
            ts-before (latest-op-ts)
            ;; First op OK, second op fails (bad token-layer-id) -> the whole
            ;; jdbc tx rolls back -> NO operations/audit rows persist.
            batch [{:path "/api/v1/tokens" :method "post"
                    :body {:token-layer-id tkl :text text-id :begin 0 :end 5}}
                   {:path "/api/v1/tokens" :method "post"
                    :body {:token-layer-id (str (random-uuid)) :text text-id :begin 6 :end 11}}]
            res (api-call admin-request {:method :post :path "/api/v1/batch" :body batch})]
        (testing "batch returns non-2xx (rolled back)"
          (is (>= (:status res) 400)))
        (drain!)
        (testing "no operations row was committed by the rolled-back batch"
          (is (= ts-before (latest-op-ts))
              "operations high-water mark unchanged — rollback wrote nothing"))
        (testing "neither OLTP nor history shows any token from the batch"
          (let [oltp-doc (api-call admin-request {:method :get
                                                  :path (str "/api/v1/documents/" doc "?include-body=true")})]
            (is (zero? (count (tokens-from-body (:body oltp-doc)))) "OLTP has no tokens"))
          (is (zero? (count (tokens-from-body (-> (get-doc-as-of doc ts-before) :body))))
              "history has no tokens at the pre-batch ts (and there is no later ts)"))))))

;; ============================================================
;; GAP 3: schema-drift canary — replayer renames must match live schema
;; ============================================================
;;
;; `table->spec`'s :col-renames keys are OLTP column names. A migration
;; that renames/drops such a column silently desyncs the replayer +
;; read-path SELECTs (the 2026-05-28 "200 with nil fields" bug class).
;; This reads the live SQLite schema and asserts every renamed source
;; column still exists. (It is a tripwire for explicit renames; columns
;; mapped only by the mechanical _id-strip rule auto-adapt and aren't
;; checked here.)

(deftest ^:integration replayer-spec-covers-live-schema
  (let [db plaid.fixtures/db
        spec @#'replayer/table->spec]
    (doseq [[table {:keys [col-renames]}] spec]
      (let [cols (->> (jdbc/execute! db [(str "PRAGMA table_info(" table ")")]
                                     {:builder-fn rs/as-unqualified-maps})
                      (map :name) set)]
        (is (seq cols) (str "mirrored table missing from live schema: " table))
        (doseq [src (keys col-renames)]
          (is (contains? cols (name src))
              (str "replayer table->spec[" table "] renames column '" (name src)
                   "' that is not in the live schema — migration drift")))))))

;; ============================================================
;; GAP 3b: table-completeness canary — every audited table has a spec
;; ============================================================
;;
;; GAP3 above checks COLUMNS of tables already listed; it says nothing
;; about a table that is missing from `table->spec` entirely. Today a new
;; entity table + its audit emit site would replay blind: the tailer hits
;; an audit row whose `target_table` has no spec and stalls (or, if it
;; were ever silently skipped, the parity tests pass vacuously because no
;; fixture builds the new entity). Either way the omission must fail LOUD
;; at the point a developer adds the table, not months later in prod.
;;
;; The three sets that must stay in lockstep:
;;   - `replayer/table->spec` keys  — what the replayer can translate
;;   - `mirrored-tables` (this ns)  — the breadth test's coverage set
;;   - live `audit_writes.target_table` — what the OLTP write path emits
;; This pins all three to each other so adding a table without wiring its
;; spec (or vice versa) breaks here with a named diff.
(deftest ^:integration replayer-spec-covers-all-mirrored-and-audited-tables
  (let [spec-tables (set (keys @#'replayer/table->spec))]
    (testing "table->spec and the breadth-test mirrored-tables set are identical"
      (is (= mirrored-tables spec-tables)
          (str "table->spec keys drifted from mirrored-tables. "
               "only-in-spec=" (set/difference spec-tables mirrored-tables)
               " only-in-mirrored=" (set/difference mirrored-tables spec-tables))))
    (testing "every table the OLTP write path actually audits has a replayer spec"
      ;; Driven off whatever audit rows the breadth test (run earlier in
      ;; this ns) and any prior test left behind. A table that is emitted
      ;; but unspecced would have stalled the tailer; this names it.
      (let [audited (->> (jdbc/execute! plaid.fixtures/db
                                        ["SELECT DISTINCT target_table FROM audit_writes"]
                                        {:builder-fn rs/as-unqualified-maps})
                         (map :target_table)
                         set)]
        (is (empty? (set/difference audited spec-tables))
            (str "audit_writes targets table(s) with no replayer table->spec: "
                 (set/difference audited spec-tables)))))))

;; ============================================================
;; GAP 4: parity with a MULTI-TOKEN span (+metadata), a re-pointed
;; relation, and a 3-level token-layer hierarchy — at the intermediate ts
;; ============================================================
;;
;; Every other parity-reconciled span is single-token; the re-point in the
;; survivor doc is undone by end-state. Here we deep-compare OLTP==history at
;; the ts RIGHT AFTER the re-point, with a 3-token-deep nested hierarchy and
;; a span carrying multiple tokens AND metadata — the exact surface where a
;; token-ordering / UUID-coercion / metadata-fold divergence would hide.

(deftest ^:integration oltp-vs-history-parity-multitoken-span-and-repointed-relation
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "MultiTokParityProj")
            doc (create-test-document admin-request proj "D")
            ;; 3-level nest: all non-overlapping (a non-overlapping layer is a
            ;; valid parent); each child token contained in a parent token.
            ;; Every create is asserted (created-id) so a rejected setup op
            ;; can't leave a nil id and silently degrade the tree to one that
            ;; reconciles trivially.
            tl (created-id (create-text-layer admin-request proj "TL"))
            l1 (created-id (create-token-layer-opts admin-request tl "L1" {:overlap-mode "non-overlapping"}))
            l2 (created-id (create-token-layer-opts admin-request tl "L2"
                                                    {:overlap-mode "non-overlapping" :parent-token-layer-id l1}))
            l3 (created-id (create-token-layer-opts admin-request tl "L3"
                                                    {:overlap-mode "non-overlapping" :parent-token-layer-id l2}))
            sl (created-id (create-span-layer admin-request l3 "SL"))
            rl (created-id (create-relation-layer admin-request sl "RL"))
            text-id (created-id (create-text admin-request tl doc "alpha beta gamma"))
            _a1 (created-id (create-token admin-request l1 text-id 0 16))  ; covers whole
            _a2 (created-id (create-token admin-request l2 text-id 0 5))   ; within a1
            t3a (created-id (create-token admin-request l3 text-id 0 2))   ; within a2
            t3b (created-id (create-token admin-request l3 text-id 2 5))   ; within a2
            ;; multi-token span carrying metadata
            s-multi (created-id (create-span admin-request sl [t3a t3b] "MULTI" {"k" "v"}))
            s2 (created-id (create-span admin-request sl [t3a] "S2"))
            s3 (created-id (create-span admin-request sl [t3b] "S3"))
            r1 (created-id (create-relation admin-request rl s2 s3 "rel"))
            ;; re-point the relation's target onto the multi-token span
            _ (assert-ok (update-relation-target admin-request r1 s-multi))
            ts (latest-op-ts)
            _ (drain!)
            oltp (-> (api-call admin-request {:method :get
                                              :path (str "/api/v1/documents/" doc "?include-body=true")})
                     :body)
            history (-> (get-doc-as-of doc ts true) :body)
            token-layers (->> oltp :document/text-layers (mapcat :text-layer/token-layers))
            tl-by-id (into {} (map (juxt :token-layer/id identity)) token-layers)
            spans (spans-from-body oltp)
            span-by-id (into {} (map (juxt :span/id identity)) spans)
            relations (->> oltp :document/text-layers
                           (mapcat :text-layer/token-layers)
                           (mapcat :token-layer/span-layers)
                           (mapcat :span-layer/relation-layers)
                           (mapcat :relation-layer/relations))]
        ;; The structural facts the test NAME promises — asserted independently
        ;; so a degenerate tree can't reconcile its way to a green `(= …)`.
        (testing "setup actually built the 3-level token-layer hierarchy"
          (is (= 3 (count token-layers)) "three token layers present")
          (is (nil? (:token-layer/parent-token-layer (tl-by-id l1))) "L1 is a root")
          (is (= l1 (:token-layer/parent-token-layer (tl-by-id l2))) "L2's parent is L1")
          (is (= l2 (:token-layer/parent-token-layer (tl-by-id l3))) "L3's parent is L2"))
        (testing "the multi-token span carries 2 tokens + metadata"
          (is (= #{t3a t3b} (set (:span/tokens (span-by-id s-multi)))))
          (is (= {"k" "v"} (:metadata (span-by-id s-multi)))))
        (testing "the relation was re-pointed onto the multi-token span"
          (is (= 1 (count relations)))
          (is (= s-multi (:relation/target (first relations)))))
        (testing "deep-read reconciles OLTP==history at the post-re-point ts"
          (is (= (normalize-for-compare oltp) (normalize-for-compare history))
              "multi-token span + metadata + re-pointed relation + 3-level hierarchy round-trip identically"))))))

;; ============================================================
;; GAP 5: a stalled tailer returns 503 (with reason) on a doc as-of GET
;; ============================================================

(deftest ^:integration stalled-tailer-returns-503-on-doc-get
  (with-test-history-node
    (fn []
      (let [proj (create-test-project admin-request "StallProj")
            doc (create-test-document admin-request proj "D")
            ts (latest-op-ts)
            _ (drain!)
            ;; Force a stall directly on the cursor, then issue a real
            ;; document as-of GET through wrap-route-as-of.
            _ (history/set-stalled! *history-node* {:op-id (random-uuid) :seq 0
                                                    :reason "test-induced stall"})
            res (get-doc-as-of doc ts)]
        (testing "503 with the stall surfaced (not a generic error)"
          (is (= 503 (:status res)))
          (is (re-find #"(?i)stall" (pr-str (:body res)))
              "503 body conveys the stall, not an opaque internal error"))))))

;; ============================================================
;; GAP 6: operations.ts is strictly monotonic — the invariant that makes
;; the (ts, id) keyset safe (same-ts distinct ops can't occur in one JVM)
;; ============================================================
;;
;; The tailer's fetch-batch keyset is `(o.ts, o.id) > cursor`. Steady-state
;; correctness relies on `operations.ts` being strictly increasing so two
;; distinct ops never share a ts (the BUG-12 same-ts-lower-uuid skip is only
;; defended for the cold-start seed, not steady-state pagination).
;;
;; SCOPE: this exercises the SEQUENTIAL commit path — each REST round-trip lets
;; the wall clock advance, so it pins "commit order == ts order, no ties" but
;; canNOT reach `next-monotonic-ts!`'s same-tick tie-break branch. That branch
;; (the actual strict-bump that defends against ties) is covered directly by
;; `plaid.sql.monotonic-ts-test/next-monotonic-ts-strict-tie-break`, which
;; freezes the clock so the tie-break must fire.

(deftest ^:integration operations-ts-sequential-commit-order-has-no-ties
  (let [proj (create-test-project admin-request "MonoTsProj")]
    (dotimes [_ 25]
      (create-test-document admin-request proj "d"))
    (let [tss (->> (jdbc/execute! plaid.fixtures/db
                                  ["SELECT ts FROM operations ORDER BY ts, id"]
                                  {:builder-fn rs/as-unqualified-maps})
                   (mapv :ts))]
      (testing "no two operations share a ts (keyset safety)"
        (is (= (count tss) (count (distinct tss)))
            "all operations.ts are distinct — same-ts-distinct-op can't happen"))
      (testing "operations.ts is already globally sorted (commit order == ts order)"
        (is (= tss (vec (sort tss))))))))

;; ============================================================
;; GAP 7 (round 3): HISTORICAL as_of for NON-document entities
;; ============================================================
;;
;; `history-entity-row-parity-projects-users-vocab` reconciles project / user /
;; vocab history rows against OLTP, but ONLY at the LATEST snapshot. Document
;; reads have rich intermediate-ts coverage (the depth-* tests); non-doc
;; entities had none. A replay bug that wrote the RIGHT end-state but the
;; WRONG intermediate value (e.g. a rename mis-ordered against an ACL grant,
;; or a bitemporal close-out that retroactively clobbers history) would be
;; invisible to a latest-only check. This pins the history at several
;; `{:snapshot-time ts_k}` instants and asserts each historical row matches
;; what OLTP held at that exact step.
;;
;; OLTP has no time-travel, so "what OLTP held at ts_k" is the value we just
;; wrote at step k — captured in-line as the mutation sequence runs.

(defn- history-row-at
  "Like `history-row`, but pins the history read to a historical snapshot via XTDB
  v2's `:snapshot-time` axis. `ts` is an ISO string (an `operations.ts`); we
  coerce it to the Date XTDB wants through the same `history/->date` the tailer
  uses, so the snapshot lands exactly on the committed system-time of that op."
  [node sql params ts]
  (first (xt/q node (into [sql] params) {:snapshot-time (history/->date ts)})))

(deftest ^:integration history-nondoc-entity-row-parity-at-intermediate-ts
  (with-test-history-node
    (fn []
      (let [db plaid.fixtures/db
            node *history-node*
            ;; A reader we grant then revoke, so the folded ACL has a
            ;; non-trivial mid-history presence-then-absence to catch.
            ur (str "hist-r-" (random-uuid) "@example.com")
            _ (assert-created (create-user! ur false))
            proj (create-test-project admin-request "HistProj-v1")
            _ (drain!)
            ts-create (latest-op-ts)
            ;; --- rename #1 ---
            _ (assert-ok (update-project-name proj "HistProj-v2"))
            _ (drain!)
            ts-v2 (latest-op-ts)
            ;; --- grant reader ---
            _ (assert-status 204 (proj-role :post "readers" proj ur))
            _ (drain!)
            ts-granted (latest-op-ts)
            ;; --- rename #2 ---
            _ (assert-ok (update-project-name proj "HistProj-v3"))
            _ (drain!)
            ts-v3 (latest-op-ts)
            ;; --- revoke reader ---
            _ (assert-status 204 (proj-role :delete "readers" proj ur))
            _ (drain!)
            ts-revoked (latest-op-ts)
            proj-sql (str "SELECT _id AS id, project$name AS name, readers "
                          "FROM history.projects WHERE _id = ?")
            name-at (fn [ts] (:name (history-row-at node proj-sql [proj] ts)))
            readers-at (fn [ts] (set (:readers (history-row-at node proj-sql [proj] ts))))]
        ;; Guard: the LATEST OLTP state is what we expect, so a degenerate
        ;; replay can't make the historical asserts vacuous by coincidence.
        (testing "OLTP end-state is the post-revoke shape (setup guard)"
          (let [oltp (sql-project/get db proj)]
            (is (= "HistProj-v3" (:project/name oltp)))
            (is (not (contains? (set (:project/readers oltp)) ur))
                "reader was actually revoked at the end")))
        (testing "name reconstructs correctly at EACH historical ts"
          (is (= "HistProj-v1" (name-at ts-create)) "name at creation ts")
          (is (= "HistProj-v2" (name-at ts-v2)) "name after first rename")
          (is (= "HistProj-v2" (name-at ts-granted)) "name unchanged across the ACL grant")
          (is (= "HistProj-v3" (name-at ts-v3)) "name after second rename")
          (is (= "HistProj-v3" (name-at ts-revoked)) "name unchanged across the ACL revoke"))
        (testing "folded readers ACL reconstructs correctly at EACH historical ts"
          (is (not (contains? (readers-at ts-v2) ur))
              "reader absent BEFORE the grant (no retroactive leak backwards)")
          (is (contains? (readers-at ts-granted) ur)
              "reader PRESENT at the grant ts")
          (is (contains? (readers-at ts-v3) ur)
              "reader still present after the later rename (rename didn't drop the ACL)")
          (is (not (contains? (readers-at ts-revoked) ur))
              "reader absent again at the revoke ts"))
        ;; ---- vocab-layer rename, same intermediate-ts technique ----
        (let [vS (-> (create-vocab-layer admin-request "HistVocab-v1") :body :id)
              _ (drain!)
              vts1 (latest-op-ts)
              _ (assert-ok (update-vocab-layer admin-request vS {:name "HistVocab-v2"}))
              _ (drain!)
              vts2 (latest-op-ts)
              vocab-sql (str "SELECT _id AS id, vocab$name AS name "
                             "FROM history.vocab_layers WHERE _id = ?")
              vname-at (fn [ts] (:name (history-row-at node vocab-sql [vS] ts)))]
          (testing "vocab-layer name reconstructs at each historical ts"
            (is (= "HistVocab-v1" (vname-at vts1)) "vocab name at creation ts")
            (is (= "HistVocab-v2" (vname-at vts2)) "vocab name after rename")
            (is (= "HistVocab-v1" (vname-at vts1))
                "re-reading the earlier ts still shows v1 (rename did not rewrite history)")))))))

;; ============================================================
;; GAP 8 (round 3): MIXED atomic batch — doc-scoped + non-doc ops in one tx
;; ============================================================
;;
;; The batch tests cover an all-token (doc-scoped) batch. A real atomic batch
;; can mix a project rename (non-doc), a token create (doc-scoped), and a
;; document set-metadata (doc-scoped) in ONE transaction that commits (or rolls
;; back) as a unit. This asserts the whole mixed batch replays, the document
;; reconciles OLTP==history after it, AND that an as_of pinned JUST BEFORE the
;; batch differs correctly from one JUST AFTER (project name old→new, token
;; absent→present, doc metadata absent→present) — i.e. the batch's effects all
;; land at the same system-time, atomically, in history too.

(deftest ^:integration history-mixed-doc-and-nondoc-batch-time-travels
  (with-test-history-node
    (fn []
      (let [db plaid.fixtures/db
            node *history-node*
            proj (create-test-project admin-request "MixedBatchProj-old")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL" "any") :body :id)
            doc (create-test-document admin-request proj "MixedBatchDoc")
            text-id (-> (create-text admin-request tl doc "hello world") :body :id)
            _ (drain!)
            ts-before (latest-op-ts)
            ;; one atomic batch: project rename (non-doc) + token create
            ;; (doc-scoped) + document set-metadata (doc-scoped)
            batch [{:path (str "/api/v1/projects/" proj) :method "patch"
                    :body {:name "MixedBatchProj-new"}}
                   {:path "/api/v1/tokens" :method "post"
                    :body {:token-layer-id tkl :text text-id :begin 0 :end 5}}
                   {:path (str "/api/v1/documents/" doc "/metadata") :method "put"
                    :body {"reviewed" "yes"}}]
            res (api-call admin-request {:method :post :path "/api/v1/batch" :body batch})
            _ (assert-ok res)
            _ (drain!)
            ts-after (latest-op-ts)
            proj-sql (str "SELECT _id AS id, project$name AS name FROM history.projects WHERE _id = ?")
            name-at (fn [ts] (:name (history-row-at node proj-sql [proj] ts)))]
        ;; Guard: the batch actually changed all three things in OLTP.
        (testing "OLTP reflects all three mixed-batch effects (setup guard)"
          (is (= "MixedBatchProj-new" (:project/name (sql-project/get db proj))))
          (let [doc-body (-> (api-call admin-request
                                       {:method :get
                                        :path (str "/api/v1/documents/" doc "?include-body=true")})
                             :body)]
            (is (= 1 (count (tokens-from-body doc-body))) "one token created by the batch")
            (is (= {"reviewed" "yes"} (:metadata doc-body)) "doc metadata set by the batch")))
        (testing "the whole batch reconciles OLTP==history at the post-batch ts"
          (let [oltp (-> (api-call admin-request
                                   {:method :get
                                    :path (str "/api/v1/documents/" doc "?include-body=true")})
                         :body normalize-for-compare)
                history (-> (get-doc-as-of doc ts-after true) :body normalize-for-compare)]
            (is (= oltp history)
                "mixed doc+non-doc batch replays as a unit; doc deep-read matches")))
        (testing "non-doc effect (project name) time-travels across the batch boundary"
          (is (= "MixedBatchProj-old" (name-at ts-before)) "project name OLD just before the batch")
          (is (= "MixedBatchProj-new" (name-at ts-after)) "project name NEW just after the batch"))
        (testing "doc-scoped effects appear only AFTER the batch (atomic with the non-doc op)"
          (is (zero? (count (tokens-from-body (-> (get-doc-as-of doc ts-before) :body))))
              "no token at the pre-batch ts")
          (is (= 1 (count (tokens-from-body (-> (get-doc-as-of doc ts-after) :body))))
              "exactly one token at the post-batch ts")
          (is (nil? (:metadata (-> (get-doc-as-of doc ts-before) :body)))
              "doc metadata absent at the pre-batch ts")
          (is (= {"reviewed" "yes"} (:metadata (-> (get-doc-as-of doc ts-after) :body)))
              "doc metadata present at the post-batch ts"))
        (testing "tailer stayed healthy across the mixed batch"
          (is (tailer-running?)))))))

;; ============================================================
;; GAP 9 (round 3): stall -> resume! recovery, END-TO-END through a doc GET
;; ============================================================
;;
;; `stalled-tailer-returns-503-on-doc-get` proves a stall surfaces as 503 on a
;; document as_of GET. `tailer_test/resume-restarts-loop-after-stall` proves
;; resume! re-spawns the loop at the channel level. Neither closes the loop:
;; stall -> 503 on a real doc GET -> resume! -> tailer catches up -> the SAME
;; doc GET now returns 200 with the correct historical body. This pins the full
;; operator recovery story end-to-end.

(deftest ^:integration stalled-tailer-recovers-via-resume-end-to-end
  (with-test-history-node
    (fn []
      (let [db plaid.fixtures/db
            node *history-node*
            proj (create-test-project admin-request "ResumeProj")
            doc (create-test-document admin-request proj "ResumeDoc")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            tkl (-> (create-token-layer admin-request tl "TKL" "any") :body :id)
            text-id (-> (create-text admin-request tl doc "hello world") :body :id)
            t1 (-> (create-token admin-request tkl text-id 0 5) :body :id)
            _ (drain!)
            ts (latest-op-ts)
            ;; The healthy baseline: doc reads at ts BEFORE we stall.
            healthy (-> (get-doc-as-of doc ts true) :body)]
        (testing "before any stall, the as_of doc GET succeeds with the token"
          (is (= 200 (:status (get-doc-as-of doc ts))))
          (is (= #{t1} (set (map :token/id (tokens-from-body healthy))))
              "baseline body carries the created token (non-vacuous target)"))
        ;; Induce a stall directly on the cursor (mirrors what the run-loop's
        ;; catch does on a malformed row), then confirm reads 503.
        (history/set-stalled! node {:op-id (random-uuid) :seq 0
                                    :reason "test-induced stall for resume recovery"})
        (testing "while stalled, the as_of doc GET returns 503"
          (let [res (get-doc-as-of doc ts)]
            (is (= 503 (:status res)))
            (is (re-find #"(?i)stall" (pr-str (:body res)))
                "503 conveys the stall")))
        ;; Operator recovery: clear the stall + restart the loop.
        (tailer/resume! db node {})
        (drain!)
        (testing "after resume!, the tailer is running again"
          (is (tailer-running?) "cursor status flipped back to :running"))
        (testing "after resume!, the SAME as_of doc GET returns 200 with the correct body"
          (let [res (get-doc-as-of doc ts true)]
            (is (= 200 (:status res)) "read recovered from 503 to 200")
            (is (= (normalize-for-compare healthy)
                   (normalize-for-compare (:body res)))
                "post-resume historical body is byte-for-byte the pre-stall body")))))))
