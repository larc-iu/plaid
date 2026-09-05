(ns plaid.rest-api.v1.comment-test
  "Tests for comments — the social layer that sits beside the annotation
  record without becoming part of it.

  Four properties carry the design and each gets its own coverage here:

    1. ANCHORING works for every commentable type, and only those.
    2. Comments are INERT with respect to annotation data: no document
       version bump, no audit rows, nothing on the document read path.
    3. AUTHORSHIP is enforced server-side. This is the property that could
       not have been had from `entity_metadata`, so it gets the most tests.
    4. A comment OUTLIVES its anchor and dies only with its owner; a comment
       on a vocabulary entry is owned by the vocab layer and takes its gates."
  (:require [clojure.set]
            [clojure.string]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request user1-request user2-request
                                    api-call assert-status db rest-handler]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        create-text-layer create-text create-token-layer
                                        create-token create-span-layer create-span
                                        create-relation-layer create-relation
                                        add-project-reader add-project-writer
                                        create-vocab-layer create-vocab-item
                                        add-vocab-maintainer link-vocab-to-project]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ============================================================
;; Setup
;; ============================================================

(defn- setup-corpus
  "Build one project holding a document with a text, a token, two spans and
  a relation — one instance of every commentable type."
  [name]
  (let [proj (create-test-project admin-request name)
        doc (create-test-document admin-request proj "Doc")
        txtl (-> (create-text-layer admin-request proj "TL") :body :id)
        text (-> (create-text admin-request txtl doc "hello world") :body :id)
        tokl (-> (create-token-layer admin-request txtl "TokL") :body :id)
        tok1 (-> (create-token admin-request tokl text 0 5) :body :id)
        tok2 (-> (create-token admin-request tokl text 6 11) :body :id)
        sl (-> (create-span-layer admin-request tokl "SL") :body :id)
        span1 (-> (create-span admin-request sl [tok1] "s1") :body :id)
        span2 (-> (create-span admin-request sl [tok2] "s2") :body :id)
        rl (-> (create-relation-layer admin-request sl "RL") :body :id)
        rel (-> (create-relation admin-request rl span1 span2 "r") :body :id)]
    {:project proj :document doc :text text :token tok1 :token2 tok2
     :span span1 :span2 span2 :relation rel
     :token-layer tokl :span-layer sl}))

(defn- post-comment
  ([req entity-type entity-id body] (post-comment req entity-type entity-id body nil))
  ([req entity-type entity-id body anchor-label]
   (api-call req {:method :post
                  :path "/api/v1/comments"
                  :body (cond-> {:entity-type entity-type :entity-id entity-id :body body}
                          anchor-label (assoc :anchor-label anchor-label))})))

(defn- status-of
  "Run a request and return ONLY its status. `api-call` slurps the response
  body, which blows up on reitit's coercion-failure responses (their body is
  a data map, not a stream) — so any assertion about a schema-level rejection
  has to go through here."
  [req-fn method path body]
  (:status (rest-handler (cond-> (req-fn method path)
                           body (mock/json-body body)))))

(defn- post-comment-status [req-fn entity-type entity-id body]
  (status-of req-fn :post "/api/v1/comments"
             {:entity-type entity-type :entity-id entity-id :body body}))

(defn- query-string [query]
  (when (seq query)
    (str "?" (clojure.string/join "&" (map (fn [[k v]] (str (name k) "=" v)) query)))))

(defn- list-comments
  [req project-id & {:as query}]
  (api-call req {:method :get :path (str "/api/v1/projects/" project-id "/comments" (query-string query))}))

(defn- list-vocab-comments
  [req vocab-id & {:as query}]
  (api-call req {:method :get :path (str "/api/v1/vocab-layers/" vocab-id "/comments" (query-string query))}))

(defn- setup-vocab
  "A vocabulary with one entry, linked to a fresh project. The admin creates
  it and so maintains it."
  [name]
  (let [vocab (-> (create-vocab-layer admin-request name) :body :id)
        item (-> (create-vocab-item admin-request vocab "gam") :body :id)
        proj (create-test-project admin-request (str name " Proj"))]
    (link-vocab-to-project admin-request proj vocab)
    {:vocab vocab :item item :project proj}))

(defn- comment-count-rows
  "Raw row count straight from SQL. Used where the REST surface can't answer
  (after the owning project is deleted, there is no endpoint left to ask)."
  ([] (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:comments]})))
  ([where] (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:comments] :where where}))))

;; ============================================================
;; 1. Anchoring
;; ============================================================

(deftest comments-anchor-to-every-commentable-type
  (testing "document, text, token, span and relation each accept a comment"
    (let [{:keys [project document] :as c} (setup-corpus "AnchorProj")]
      (doseq [[entity-type k] [["document" :document] ["text" :text] ["token" :token]
                               ["span" :span] ["relation" :relation]]]
        (let [resp (post-comment admin-request entity-type (get c k) (str "on a " entity-type))]
          (assert-status 201 resp)
          (is (= entity-type (-> resp :body :comment/entity-type)))
          (is (= (get c k) (-> resp :body :comment/entity-id)))
          (is (= project (-> resp :body :comment/project-id))
              "project is denormalized off the anchor, not supplied by the client")
          (is (= document (-> resp :body :comment/document-id))
              "document is denormalized off the anchor for every type, not just documents")
          (is (= "admin@example.com" (-> resp :body :comment/author-id))
              "author comes from the authenticated caller"))))))

(deftest uncommentable-entity-type-is-a-400-not-a-403
  ;; The enum lives in the route schema precisely so this fails at coercion,
  ;; BEFORE the ACL middleware. Resolved via a non-admin writer: for an admin
  ;; the privilege check passes regardless, which would hide a regression here.
  (testing "a type outside the commentable set is rejected as a bad request"
    (let [{:keys [project document]} (setup-corpus "BadTypeProj")]
      (add-project-writer admin-request project "user1@example.com")
      (is (= 400 (post-comment-status user1-request "vocab_item" document "nope")))
      (is (= 400 (post-comment-status user1-request "banana" document "nope"))))))

(deftest anchor-label-is-stored-trimmed-and-bounded
  (testing "the caption a client posts comes back on the comment"
    (let [{:keys [span]} (setup-corpus "LabelProj")
          created (-> (post-comment admin-request "span" span "hi" "  Gloss of ktab, sentence 4 ") :body)]
      (is (= "Gloss of ktab, sentence 4" (:comment/anchor-label created)) "trimmed")
      (is (nil? (-> (post-comment admin-request "span" span "no label") :body :comment/anchor-label)))
      (is (nil? (-> (post-comment admin-request "span" span "blank label" "   ") :body :comment/anchor-label))
          "a blank caption is stored as none")
      (assert-status 400 (post-comment admin-request "span" span "too long" (apply str (repeat 201 \x))))
      (assert-status 201 (post-comment admin-request "span" span "at the ceiling" (apply str (repeat 200 \x)))))))

(deftest comment-on-missing-anchor-does-not-create
  (testing "an anchor id that resolves to no project fails closed"
    (let [{:keys [project]} (setup-corpus "MissingAnchorProj")
          ghost (str (psc/new-uuid))]
      (add-project-writer admin-request project "user1@example.com")
      ;; A non-member can't be told whether the id is real, so this is a 403
      ;; rather than a 404 — the same trade every create route makes.
      (assert-status 403 (post-comment user1-request "span" ghost "nope"))
      (is (= 0 (comment-count-rows))))))

;; ============================================================
;; 2. Comments are inert with respect to annotation data
;; ============================================================

(deftest commenting-does-not-bump-the-document-version
  ;; The load-bearing one. If a comment bumped the version, every open editor
  ;; would see its OCC token invalidated by someone else's chatter.
  (testing "posting, editing and deleting a comment leave documents.version alone"
    (let [{:keys [document span]} (setup-corpus "VersionProj")
          version-of #(-> (api-call admin-request {:method :get
                                                   :path (str "/api/v1/documents/" document)})
                          :body :document/version)
          before (version-of)
          cid (-> (post-comment admin-request "span" span "hi") :body :comment/id)]
      (is (= before (version-of)) "create must not bump")
      (api-call admin-request {:method :patch
                               :path (str "/api/v1/comments/" cid)
                               :body {:body "edited"}})
      (is (= before (version-of)) "edit must not bump")
      (api-call admin-request {:method :delete :path (str "/api/v1/comments/" cid)})
      (is (= before (version-of)) "delete must not bump"))))

(deftest commenting-writes-no-audit-rows
  (testing "comments are social data and leave the audit log untouched"
    (let [{:keys [span]} (setup-corpus "AuditProj")
          ops-before (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:operations]}))
          writes-before (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:audit_writes]}))
          cid (-> (post-comment admin-request "span" span "hi") :body :comment/id)]
      (api-call admin-request {:method :patch
                               :path (str "/api/v1/comments/" cid)
                               :body {:body "edited"}})
      (api-call admin-request {:method :delete :path (str "/api/v1/comments/" cid)})
      (is (= ops-before (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:operations]})))
          "no operations rows")
      (is (= writes-before (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:audit_writes]})))
          "no audit_writes rows"))))

(deftest comments-stay-off-the-document-read-path
  (testing "a deep document read carries no comment payload"
    (let [{:keys [document span]} (setup-corpus "ReadPathProj")]
      (post-comment admin-request "span" span "should not appear in the doc read")
      (let [body (-> (api-call admin-request
                               {:method :get
                                :path (str "/api/v1/documents/" document "?include-body=true")})
                     :body pr-str)]
        (is (not (clojure.string/includes? body "should not appear in the doc read"))
            "comment bodies must not ride the hot document read")))))

;; ============================================================
;; 3. Authorship and permissions
;; ============================================================

(deftest readers-cannot-comment-writers-can
  (testing "commenting takes the same standing as annotating"
    (let [{:keys [project span]} (setup-corpus "RoleProj")]
      (add-project-reader admin-request project "user1@example.com")
      (add-project-writer admin-request project "user2@example.com")
      (assert-status 403 (post-comment user1-request "span" span "reader tries"))
      (assert-status 201 (post-comment user2-request "span" span "writer posts"))
      (testing "but a reader can still READ the thread"
        (assert-status 200 (list-comments user1-request project))))))

(deftest only-the-author-may-edit
  (testing "no other writer, maintainer or admin can rewrite someone's words"
    (let [{:keys [project span]} (setup-corpus "EditAuthProj")]
      (add-project-writer admin-request project "user1@example.com")
      (api-call admin-request {:method :post
                               :path (str "/api/v1/projects/" project
                                          "/maintainers/user2@example.com")})
      (let [cid (-> (post-comment user1-request "span" span "mine") :body :comment/id)
            patch (fn [req] (api-call req {:method :patch
                                           :path (str "/api/v1/comments/" cid)
                                           :body {:body "rewritten"}}))]
        (assert-status 403 (patch user2-request))
        (assert-status 403 (patch admin-request))
        (assert-status 200 (patch user1-request))
        (is (= "rewritten" (-> (api-call user1-request {:method :get
                                                        :path (str "/api/v1/comments/" cid)})
                               :body :comment/body)))))))

(deftest editing-marks-the-comment-edited
  (testing "edited is derived from updated-at moving past created-at"
    (let [{:keys [span]} (setup-corpus "EditedFlagProj")
          created (-> (post-comment admin-request "span" span "v1") :body)]
      (is (false? (:comment/edited created)))
      (let [updated (-> (api-call admin-request
                                  {:method :patch
                                   :path (str "/api/v1/comments/" (:comment/id created))
                                   :body {:body "v2"}})
                        :body)]
        (is (true? (:comment/edited updated)))
        (is (= (:comment/created-at created) (:comment/created-at updated))
            "created-at is immutable")))))

(deftest delete-is-author-or-maintainer
  (testing "a plain writer cannot delete another's comment, a maintainer can"
    (let [{:keys [project span]} (setup-corpus "DeleteAuthProj")]
      (add-project-writer admin-request project "user1@example.com")
      (add-project-writer admin-request project "user2@example.com")
      (let [cid (-> (post-comment user1-request "span" span "mine") :body :comment/id)
            del (fn [req] (api-call req {:method :delete :path (str "/api/v1/comments/" cid)}))]
        (assert-status 403 (del user2-request))
        (testing "promoting user2 to maintainer grants the recourse"
          (api-call admin-request {:method :post
                                   :path (str "/api/v1/projects/" project
                                              "/maintainers/user2@example.com")})
          (assert-status 204 (del user2-request))))))
  (testing "an author may always delete their own"
    (let [{:keys [project span]} (setup-corpus "DeleteOwnProj")]
      (add-project-writer admin-request project "user1@example.com")
      (let [cid (-> (post-comment user1-request "span" span "mine") :body :comment/id)]
        (assert-status 204 (api-call user1-request {:method :delete
                                                    :path (str "/api/v1/comments/" cid)}))
        ;; 403, not 404: a deleted comment no longer resolves to a project, so
        ;; the reader check fails closed. Identical to GET on a deleted span —
        ;; existence is not confirmed to someone whose access can't be checked.
        (assert-status 403 (api-call user1-request {:method :get
                                                    :path (str "/api/v1/comments/" cid)}))
        (is (= 0 (comment-count-rows)))))))

(deftest body-validation
  (testing "a comment body must be non-blank prose within the length ceiling"
    (let [{:keys [span]} (setup-corpus "BodyProj")]
      (assert-status 400 (post-comment admin-request "span" span ""))
      (assert-status 400 (post-comment admin-request "span" span "   \n  "))
      (assert-status 400 (post-comment admin-request "span" span (apply str (repeat 10001 \x))))
      (assert-status 201 (post-comment admin-request "span" span (apply str (repeat 10000 \x)))))))

;; ============================================================
;; 4. Reads
;; ============================================================

(deftest document-and-entity-filters
  (testing "a project list narrows to one document or one entity"
    (let [{:keys [project document span token]} (setup-corpus "FilterProj")
          other-doc (create-test-document admin-request project "Doc2")]
      (post-comment admin-request "span" span "on span")
      (post-comment admin-request "token" token "on token")
      (post-comment admin-request "document" other-doc "on the other doc")
      (is (= 3 (count (-> (list-comments admin-request project) :body :entries))))
      (is (= 2 (count (-> (list-comments admin-request project :document-id document)
                          :body :entries))))
      (is (= 1 (count (-> (list-comments admin-request project :document-id other-doc)
                          :body :entries))))
      (is (= ["on span"] (map :comment/body
                              (-> (list-comments admin-request project
                                                 :entity-type "span" :entity-id span)
                                  :body :entries)))))))

(deftest filters-cannot-read-across-projects
  (testing "a document id from another project matches nothing under this project's scope"
    (let [a (setup-corpus "IsolationA")
          b (setup-corpus "IsolationB")]
      (post-comment admin-request "span" (:span b) "secret from B")
      (let [resp (list-comments admin-request (:project a) :document-id (:document b))]
        (assert-status 200 resp)
        (is (empty? (-> resp :body :entries))
            "filters AND under the project scope the ACL was checked against")))))

(deftest counts-endpoint-summarizes-a-document
  (testing "counts returns {entity-id -> n} without shipping bodies"
    (let [{:keys [project document span token]} (setup-corpus "CountsProj")]
      (post-comment admin-request "span" span "one")
      (post-comment admin-request "span" span "two")
      (post-comment admin-request "token" token "three")
      (let [resp (api-call admin-request
                           {:method :get
                            :path (str "/api/v1/projects/" project
                                       "/comments/counts?document-id=" document)})]
        (assert-status 200 resp)
        ;; Normalize keys to strings: the counts map is keyed by entity id,
        ;; which the EDN and JSON encoders render differently.
        (is (= {(str span) 2 (str token) 1}
               (into {} (map (fn [[k v]] [(str k) v])) (:body resp))))))))

(deftest list-is-paginated-with-the-uniform-envelope
  (testing "entries + next-cursor, and the cursor walks the rest"
    (let [{:keys [project span]} (setup-corpus "PageProj")]
      (dotimes [i 5] (post-comment admin-request "span" span (str "c" i)))
      (let [page1 (-> (list-comments admin-request project :limit 2) :body)]
        (is (= 2 (count (:entries page1))))
        (is (some? (:next-cursor page1)))
        (let [page2 (-> (list-comments admin-request project :limit 2
                                       :cursor (:next-cursor page1))
                        :body)]
          (is (= 2 (count (:entries page2))))
          (is (empty? (clojure.set/intersection
                       (set (map :comment/id (:entries page1)))
                       (set (map :comment/id (:entries page2)))))
              "pages do not overlap"))))))

;; ============================================================
;; 5. A comment outlives its anchor, and dies only with its owner
;; ============================================================

(deftest deleting-an-entity-leaves-its-comments-in-place
  ;; The rule that replaced the sweep: an edit that removes the word a remark
  ;; was about must not silently un-say the remark. The app shows such a
  ;; comment as outdated, captioned by anchor-label.
  (testing "span, token and relation deletes each leave their comments listed"
    (let [{:keys [project document span token relation]} (setup-corpus "OutliveProj")]
      (post-comment admin-request "span" span "about the span" "s1 of hello, sentence 1")
      (post-comment admin-request "token" token "about the token" "hello, sentence 1")
      (post-comment admin-request "relation" relation "about the relation")
      (api-call admin-request {:method :delete :path (str "/api/v1/relations/" relation)})
      (api-call admin-request {:method :delete :path (str "/api/v1/spans/" span)})
      (api-call admin-request {:method :delete :path (str "/api/v1/tokens/" token)})
      (is (= 3 (comment-count-rows)) "nothing swept")
      (let [listed (-> (list-comments admin-request project :document-id document) :body :entries)]
        (is (= 3 (count listed)) "still listed under the document")
        (is (= "hello, sentence 1"
               (->> listed (filter #(= "token" (:comment/entity-type %))) first :comment/anchor-label))
            "the caption is what is left to show")))))

(deftest a-comment-on-a-deleted-anchor-can-still-be-read-edited-and-deleted
  ;; Ownership is read off the comment row, never off the anchor, so the
  ;; usual rules keep working once the anchor is gone.
  (testing "the owner comes from the comment row, not the (now missing) anchor"
    (let [{:keys [project span]} (setup-corpus "OrphanAuthProj")]
      (add-project-writer admin-request project "user1@example.com")
      (add-project-reader admin-request project "user2@example.com")
      (let [cid (-> (post-comment user1-request "span" span "mine") :body :comment/id)]
        (api-call admin-request {:method :delete :path (str "/api/v1/spans/" span)})
        (assert-status 200 (api-call user2-request {:method :get :path (str "/api/v1/comments/" cid)}))
        (assert-status 200 (api-call user1-request {:method :patch
                                                    :path (str "/api/v1/comments/" cid)
                                                    :body {:body "edited after the span went"}}))
        (assert-status 403 (api-call user2-request {:method :delete :path (str "/api/v1/comments/" cid)}))
        (assert-status 204 (api-call user1-request {:method :delete :path (str "/api/v1/comments/" cid)}))))
    (testing "but nothing can be POSTED to an anchor that no longer exists"
      (let [{:keys [project span]} (setup-corpus "OrphanPostProj")]
        (add-project-writer admin-request project "user1@example.com")
        (api-call admin-request {:method :delete :path (str "/api/v1/spans/" span)})
        ;; A member gets the fail-closed 403 every unresolvable anchor gets; an
        ;; admin passes the gate and is told the anchor is gone. Neither posts.
        (assert-status 403 (post-comment user1-request "span" span "too late"))
        (assert-status 404 (post-comment admin-request "span" span "too late"))
        (is (= 0 (comment-count-rows)))))))

(deftest deleting-a-document-takes-every-comment-in-it
  (testing "a document delete clears comments at every depth beneath it (FK cascade)"
    (let [{:keys [document text token span relation]} (setup-corpus "DocSweepProj")]
      (doseq [[t id] [["document" document] ["text" text] ["token" token]
                      ["span" span] ["relation" relation]]]
        (post-comment admin-request t id (str "on " t)))
      (is (= 5 (comment-count-rows)))
      (api-call admin-request {:method :delete :path (str "/api/v1/documents/" document)})
      (is (= 0 (comment-count-rows))))))

(deftest deleting-a-project-takes-every-comment-in-it
  (testing "a project delete clears its comments via FK cascade"
    (let [{:keys [project document span]} (setup-corpus "ProjSweepProj")
          keeper (setup-corpus "ProjKeeper")]
      (post-comment admin-request "document" document "doomed")
      (post-comment admin-request "span" span "also doomed")
      (post-comment admin-request "span" (:span keeper) "survives")
      (is (= 3 (comment-count-rows)))
      (api-call admin-request {:method :delete :path (str "/api/v1/projects/" project)})
      (is (= 1 (comment-count-rows)) "only the other project's comment remains")
      (is (= 1 (comment-count-rows [:= :project_id (:project keeper)]))))))

;; ============================================================
;; 6. Comments on vocabulary entries
;; ============================================================

(deftest vocab-item-comments-are-owned-by-the-vocab-layer
  (testing "a comment on an entry carries the vocab layer and no project"
    (let [{:keys [vocab item]} (setup-vocab "VocabOwn")
          created (-> (post-comment admin-request "vocab-item" item "is this really a noun?" "gam") :body)]
      (assert-status 201 {:status 201})
      (is (= "vocab-item" (:comment/entity-type created)))
      (is (= vocab (:comment/vocab-layer-id created)))
      (is (nil? (:comment/project-id created)))
      (is (nil? (:comment/document-id created)))
      (is (= "gam" (:comment/anchor-label created))))))

(deftest vocab-item-comments-take-the-vocab-gates
  (testing "who may post: a vocab maintainer, a writer through a linking project; not a reader, not a stranger"
    (let [{:keys [vocab item project]} (setup-vocab "VocabGates")]
      (add-project-reader admin-request project "user1@example.com")
      (add-project-writer admin-request project "user2@example.com")
      (assert-status 403 (post-comment user1-request "vocab-item" item "reader through project"))
      (assert-status 201 (post-comment user2-request "vocab-item" item "writer through project"))
      (testing "a reader through a project can still read the thread"
        (assert-status 200 (list-vocab-comments user1-request vocab)))
      (testing "a user with no route to the vocabulary is refused on every surface"
        ;; user1 loses the project role that gave them a route.
        (api-call admin-request {:method :delete
                                 :path (str "/api/v1/projects/" project "/readers/user1@example.com")})
        (assert-status 403 (post-comment user1-request "vocab-item" item "stranger"))
        (assert-status 403 (list-vocab-comments user1-request vocab)))
      (testing "a vocab maintainer with no project at all may post"
        (add-vocab-maintainer admin-request vocab "user1@example.com")
        (assert-status 201 (post-comment user1-request "vocab-item" item "maintainer posts"))))))

(deftest vocab-item-comment-delete-is-author-or-vocab-maintainer
  (testing "another writer cannot delete; the vocabulary's maintainer can; a project maintainer cannot"
    (let [{:keys [vocab item project]} (setup-vocab "VocabDel")]
      (add-project-writer admin-request project "user1@example.com")
      (add-project-writer admin-request project "user2@example.com")
      (let [cid (-> (post-comment user1-request "vocab-item" item "mine") :body :comment/id)
            del (fn [req] (api-call req {:method :delete :path (str "/api/v1/comments/" cid)}))]
        (assert-status 403 (del user2-request))
        (testing "maintaining the PROJECT is not enough: the vocabulary is the owner"
          (api-call admin-request {:method :post
                                   :path (str "/api/v1/projects/" project "/maintainers/user2@example.com")})
          (assert-status 403 (del user2-request)))
        (testing "maintaining the vocabulary is"
          (add-vocab-maintainer admin-request vocab "user2@example.com")
          (assert-status 204 (del user2-request)))))))

(deftest vocab-comments-are-listed-and-counted-per-vocabulary-not-per-project
  (testing "the vocabulary list and counts see them; the linking project's list does not"
    (let [{:keys [vocab item project]} (setup-vocab "VocabList")
          item2 (-> (create-vocab-item admin-request vocab "ar") :body :id)]
      (post-comment admin-request "vocab-item" item "one")
      (post-comment admin-request "vocab-item" item "two")
      (post-comment admin-request "vocab-item" item2 "three")
      (is (= 3 (count (-> (list-vocab-comments admin-request vocab) :body :entries))))
      (is (= ["three"] (map :comment/body (-> (list-vocab-comments admin-request vocab :entity-id item2)
                                              :body :entries))))
      (is (empty? (-> (list-comments admin-request project) :body :entries))
          "a project that links the vocabulary does not list its comments")
      (let [counts (-> (api-call admin-request {:method :get
                                                :path (str "/api/v1/vocab-layers/" vocab "/comments/counts")})
                       :body)]
        (is (= {(str item) 2 (str item2) 1}
               (into {} (map (fn [[k v]] [(str k) v])) counts)))))))

(deftest vocab-item-delete-leaves-the-comment-and-vocab-layer-delete-takes-it
  (testing "an entry delete leaves its comment (outdated); deleting the vocabulary cascades"
    (let [{:keys [vocab item]} (setup-vocab "VocabCascade")]
      (post-comment admin-request "vocab-item" item "on an entry" "gam")
      (api-call admin-request {:method :delete :path (str "/api/v1/vocab-items/" item)})
      (is (= 1 (comment-count-rows)) "entry delete does not sweep")
      (is (= "gam" (-> (list-vocab-comments admin-request vocab) :body :entries first :comment/anchor-label)))
      (api-call admin-request {:method :delete :path (str "/api/v1/vocab-layers/" vocab)})
      (is (= 0 (comment-count-rows)) "the owner's deletion takes it"))))
