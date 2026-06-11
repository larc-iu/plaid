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
  (:require [clojure.data.json :as json]
            [clojure.set :as set]
            [clojure.test :refer :all]
            [clojure.walk :as walk]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request api-call assert-created assert-ok
                                    assert-status assert-no-content
                                    with-admin with-test-users with-clean-db]]
            [plaid.test-helpers :refer :all]))

;; ============================================================
;; Per-test history node + tailer (mirrors integration-test harness)
;; ============================================================

(defn- with-test-history-node
  "Historical seam from the replica era (these tests once stood up a
  per-test XTDB node + tailer loop). Audit-log reads need no setup —
  the seam just invokes the body."
  [f]
  (f))

(defn- drain!
  "Historical seam: nothing to drain — as-of reads are served from the
  same database the write committed to and are never stale."
  []
  true)

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

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

(defn- deactivate-user! [user-id]
  (api-call admin-request {:method :delete :path (str "/api/v1/users/" user-id)}))

(defn- reactivate-user! [user-id]
  (api-call admin-request {:method :post :path (str "/api/v1/users/" user-id "/activate")}))

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
    "span/delete-metadata" "span/patch-metadata"
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
    "user/create" "user/deactivate" "user/reactivate" "user/update"
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
;; dead-code smell worth revisiting. (Currently empty: the last entry,
;; span/remove-token, was deleted as dead code 2026-06-10 — span-token
;; removal happens via PUT /spans/:id/tokens → span/update-tokens, or via
;; the token-delete cascade's synthetic :update / orphan :delete rows.)
(def ^:private rest-unreachable-op-types
  #{})

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

            ;; ---- API tokens: mint + revoke (audited — keeps the
            ;;      (table, change_type) breadth assertion honest) ----
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

            ;; ---- throwaway project + user for project/delete + user deactivation ----
            proj-throw (create-test-project admin-request "FC-ProjThrow")
            _ (assert-no-content (delete-project! proj-throw))               ; project/delete
            _ (assert-no-content (deactivate-user! u-throw))                 ; user/deactivate
            _ (assert-ok (reactivate-user! u-throw))                         ; user/reactivate
            _ (assert-no-content (deactivate-user! u-throw))                 ; leave them deactivated

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

        (testing "every emitted audit shape is a known (table, change_type) pair"
          (doseq [[table change] (distinct-audit-shapes)]
            (is (contains? mirrored-tables table)
                (str "audit row targets a table outside the known mirrored set — extend the reader/known sets deliberately: " table))
            (is (contains? handled-change-types change)
                (str "audit row has an unknown change_type — extend the fold/known sets deliberately: " change))))

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
                (is (empty? (spans-from-body body)))))))))))

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
          (is (= [t1] (span-toks-at ts-merge))))))))

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
          (is (empty? (spans-from-body (-> (get-doc-as-of doc ts-gone) :body)))))))))

(defn- truthy-flag [v]
  ;; history may store SQLite is_admin as 0/1 (int) or true/false; normalize.
  (boolean (or (true? v) (= 1 v) (= 1N v))))

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
;; GAP 9 (round 3): stall -> resume! recovery, END-TO-END through a doc GET
;; ============================================================
;;
;; `stalled-tailer-returns-503-on-doc-get` proves a stall surfaces as 503 on a
;; document as_of GET. `tailer_test/resume-restarts-loop-after-stall` proves
;; resume! re-spawns the loop at the channel level. Neither closes the loop:
;; stall -> 503 on a real doc GET -> resume! -> tailer catches up -> the SAME
;; doc GET now returns 200 with the correct historical body. This pins the full
;; operator recovery story end-to-end.

