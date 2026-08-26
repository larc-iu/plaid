(ns plaid.rest-api.v1.operation-group-test
  "Logical-operation grouping end to end: `?group-id=` + `?group-message=` on
  writes → `wrap-operation-group` → `operations.group_id` + lazily created
  `operation_groups` row → the grouped audit read (fold precedence group →
  batch → standalone op, keyset-paginated by unit head) → PATCH relabel."
  (:require [clojure.test :refer :all]
            [ring.mock.request :as mock]
            [plaid.fixtures :as f :refer [with-db with-mount-states with-rest-handler
                                          admin-request user1-request user2-request api-call
                                          assert-ok assert-status assert-no-content
                                          with-admin with-test-users with-clean-db]]
            [plaid.test-helpers :refer :all]
            [plaid.sql.common :as psc]
            [plaid.sql.project :as prj]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- setup-span
  "project → doc → text-layer → token-layer → span-layer → text → token → span.
  Returns {:proj :doc :span}."
  [user-request-fn name]
  (let [proj (create-test-project user-request-fn name)
        doc (create-test-document user-request-fn proj "Doc")
        tl (-> (create-text-layer user-request-fn proj "TL") :body :id)
        tokl (-> (create-token-layer user-request-fn tl "TokL") :body :id)
        sl (-> (create-span-layer user-request-fn tokl "SL") :body :id)
        text (-> (create-text user-request-fn tl doc "hello world") :body :id)
        tok (-> (create-token user-request-fn tokl text 0 5) :body :id)
        span (-> (create-span user-request-fn sl [tok] "NOUN") :body :id)]
    {:proj proj :doc doc :span span}))

(defn- patch-meta
  "PATCH span metadata with an explicit query string appended."
  ([user-request-fn span-id query body]
   (api-call user-request-fn
             {:method :patch
              :path (str "/api/v1/spans/" span-id "/metadata" (when query (str "?" query)))
              :body body})))

(defn- group-query
  ([gid] (str "group-id=" gid))
  ([gid message] (str "group-id=" gid "&group-message=" (java.net.URLEncoder/encode (str message) "UTF-8"))))

(defn- ops-of-type [op-type]
  (psc/q f/db ["SELECT * FROM operations WHERE op_type = ? ORDER BY ts" op-type]))

(defn- group-row [gid]
  (psc/q1 f/db ["SELECT * FROM operation_groups WHERE id = ?" (str gid)]))

(defn- doc-audit-entries [user-request-fn doc & [query]]
  (let [r (get-document-audit user-request-fn doc (or query {}))]
    (assert-ok r)
    (:entries (:body r))))

(defn- entry-for
  "The audit entry whose :audit/id is `unit`."
  [entries unit]
  (first (filter #(= unit (:audit/id %)) entries)))

(defn- submit-batch [user-request-fn ops]
  (api-call user-request-fn {:method :post :path "/api/v1/batch" :body ops}))

;; ---------------------------------------------------------------------------
;; Write side: stamping + lazy group row
;; ---------------------------------------------------------------------------

(deftest group-id-stamps-ops-and-creates-group-row-lazily
  (let [{:keys [span]} (setup-span admin-request "GrpStamp")
        gid (random-uuid)]
    (testing "no group row before the first tagged write"
      (is (nil? (group-row gid))))

    (testing "first tagged write stamps group_id and creates the labeled group row"
      (assert-ok (patch-meta admin-request span (group-query gid "Approve all") {"a" 1}))
      (let [[op] (ops-of-type "span/patch-metadata")
            g (group-row gid)]
        (is (= gid (:group_id op)))
        (is (some? g))
        (is (= "Approve all" (:message g)))
        (is (= "admin@example.com" (:user_id g)))
        (is (= (:ts op) (:created_at g)) "group row is created with the first member's ts")))

    (testing "later members join; the label is NOT rewritten from the write params"
      (assert-ok (patch-meta admin-request span (group-query gid "Different label") {"b" 2}))
      (assert-ok (patch-meta admin-request span (group-query gid) {"c" 3}))
      (is (= [gid gid gid] (mapv :group_id (ops-of-type "span/patch-metadata"))))
      (is (= "Approve all" (:message (group-row gid)))))

    (testing "an untagged write has no group"
      (assert-ok (patch-meta admin-request span nil {"d" 4}))
      (is (nil? (:group_id (last (ops-of-type "span/patch-metadata"))))))

    (testing "per-op ?audit-message= still applies to the individual op inside a group"
      (assert-ok (patch-meta admin-request span (str (group-query gid) "&audit-message=Step%20five") {"e" 5}))
      (let [op (last (ops-of-type "span/patch-metadata"))]
        (is (= gid (:group_id op)))
        (is (= "Step five" (:description op)))))))

(deftest group-without-message-is-unlabeled
  (let [{:keys [span doc]} (setup-span admin-request "GrpNoMsg")
        gid (random-uuid)]
    (assert-ok (patch-meta admin-request span (group-query gid) {"a" 1}))
    (is (nil? (:message (group-row gid))))
    (let [e (entry-for (doc-audit-entries admin-request doc) gid)]
      (is (some? e))
      (is (= gid (:audit/group-id e)))
      (is (not (contains? e :audit/message)) "no :audit/message key when the client never labeled it"))))

(deftest malformed-group-id-is-rejected
  (let [{:keys [span]} (setup-span admin-request "GrpBad")]
    (let [r (patch-meta admin-request span "group-id=not-a-uuid" {"a" 1})]
      (is (= 400 (:status r)))
      (is (re-find #"(?i)uuid" (-> r :body :error))))
    (is (empty? (ops-of-type "span/patch-metadata")) "the rejected write did nothing")))

(deftest batch-sub-ops-join-the-group
  (let [{:keys [span doc]} (setup-span admin-request "GrpBatch")
        gid (random-uuid)
        r (submit-batch admin-request
                        [{:path (str "/api/v1/spans/" span "/metadata?" (group-query gid "Batch inside group"))
                          :method "PATCH" :body {"a" 1}}
                         {:path (str "/api/v1/spans/" span "/metadata?" (group-query gid "Batch inside group"))
                          :method "PATCH" :body {"b" 2}}])]
    (assert-ok r)
    (let [ops (ops-of-type "span/patch-metadata")]
      (is (= 2 (count ops)))
      (is (every? #(= gid (:group_id %)) ops))
      (is (apply = (map :batch_id ops)) "both sub-ops share the batch id too")
      (is (some? (:batch_id (first ops)))))
    (testing "the audit read folds the batch under its group (group wins over batch)"
      (let [e (entry-for (doc-audit-entries admin-request doc) gid)]
        (is (some? e))
        (is (= "Batch inside group" (:audit/message e)))
        (is (= 2 (count (:audit/ops e))))
        (is (not (contains? e :audit/batch-id)))
        (is (every? some? (map :op/batch-id (:audit/ops e))) "per-op batch ids are still reported")))))

;; ---------------------------------------------------------------------------
;; Read side: fold precedence, membership, ordering, pagination
;; ---------------------------------------------------------------------------

(deftest audit-read-folds-group-then-batch-then-standalone
  (let [{:keys [span doc]} (setup-span admin-request "GrpFold")
        gid (random-uuid)]
    ;; group with 3 members: standalone op, then a 2-op batch, then another standalone
    (assert-ok (patch-meta admin-request span (group-query gid "Merge morphemes") {"g1" 1}))
    (assert-ok (submit-batch admin-request
                             [{:path (str "/api/v1/spans/" span "/metadata?" (group-query gid))
                               :method "PATCH" :body {"g2" 2}}
                              {:path (str "/api/v1/spans/" span "/metadata?" (group-query gid))
                               :method "PATCH" :body {"g3" 3}}]))
    (assert-ok (patch-meta admin-request span (group-query gid) {"g4" 4}))
    ;; an unlabeled batch of 2
    (assert-ok (submit-batch admin-request
                             [{:path (str "/api/v1/spans/" span "/metadata") :method "PATCH" :body {"b1" 1}}
                              {:path (str "/api/v1/spans/" span "/metadata") :method "PATCH" :body {"b2" 2}}]))
    ;; a standalone op
    (assert-ok (patch-meta admin-request span nil {"s1" 1}))
    (let [entries (doc-audit-entries admin-request doc)
          patch-entries (filter #(some (fn [o] (= :span/patch-metadata (:op/type o))) (:audit/ops %)) entries)
          [grp bat solo] patch-entries]
      (is (= 3 (count patch-entries)) "group + batch + standalone = 3 units")

      (testing "entries are ordered by unit head (oldest first)"
        (is (= gid (:audit/id grp)))
        (is (= patch-entries (sort-by :audit/time patch-entries)) "monotone heads"))

      (testing "group unit: full membership, message, head/end times"
        (is (= gid (:audit/group-id grp)))
        (is (= "Merge morphemes" (:audit/message grp)))
        (is (= 4 (count (:audit/ops grp))))
        (is (= (:op/time (first (:audit/ops grp))) (:audit/time grp)))
        (is (= (:op/time (last (:audit/ops grp))) (:audit/end-time grp)))
        (is (neg? (compare (:audit/time grp) (:audit/end-time grp))))
        (is (map? (:audit/user grp)))
        (is (every? map? (map :op/user (:audit/ops grp))))
        (is (= 1 (count (:audit/documents grp))))
        (is (= 1 (count (:audit/projects grp)))))

      (testing "unlabeled batch unit"
        (is (some? (:audit/batch-id bat)))
        (is (= (:audit/batch-id bat) (:audit/id bat)))
        (is (not (contains? bat :audit/group-id)))
        (is (not (contains? bat :audit/message)))
        (is (= 2 (count (:audit/ops bat)))))

      (testing "standalone op is a singleton unit keyed by the op id"
        (is (= (:audit/id solo) (-> solo :audit/ops first :op/id)))
        (is (= 1 (count (:audit/ops solo))))
        (is (= (:audit/time solo) (:audit/end-time solo)))
        (is (not (contains? solo :audit/batch-id)))
        (is (not (contains? solo :audit/group-id)))))))

(deftest group-spanning-documents-folds-within-scope
  (let [{:keys [proj doc span]} (setup-span admin-request "GrpScope")
        doc2 (create-test-document admin-request proj "Doc2")
        gid (random-uuid)]
    (assert-ok (patch-meta admin-request span (group-query gid "Cross-doc") {"a" 1}))
    (assert-ok (api-call admin-request {:method :patch
                                        :path (str "/api/v1/documents/" doc2 "?" (group-query gid "Cross-doc"))
                                        :body {:name "Doc2 renamed"}}))
    (testing "project scope sees both members"
      (let [r (get-project-audit admin-request proj)
            e (entry-for (:entries (:body r)) gid)]
        (assert-ok r)
        (is (= 2 (count (:audit/ops e))))
        (is (= 2 (count (:audit/documents e))))))
    (testing "each document scope sees only its own member"
      (is (= 1 (count (:audit/ops (entry-for (doc-audit-entries admin-request doc) gid)))))
      (is (= 1 (count (:audit/ops (entry-for (doc-audit-entries admin-request doc2) gid))))))))

(deftest pagination-is-by-unit-head-and-carries-late-members
  (let [{:keys [span doc]} (setup-span admin-request "GrpPage")
        gid (random-uuid)]
    ;; head of G, then two standalone ops, then a late member of G
    (assert-ok (patch-meta admin-request span (group-query gid "Long-running") {"g1" 1}))
    (assert-ok (patch-meta admin-request span nil {"s1" 1}))
    (assert-ok (patch-meta admin-request span nil {"s2" 2}))
    (assert-ok (patch-meta admin-request span (group-query gid) {"g2" 2}))
    (let [walk (fn [limit]
                 (loop [cursor nil acc [] guard 0]
                   (let [q (cond-> {:limit limit} cursor (assoc :cursor cursor))
                         r (get-document-audit admin-request doc q)
                         _ (assert-ok r)
                         {:keys [entries next-cursor]} (:body r)
                         acc' (into acc entries)]
                     (if (and next-cursor (< guard 100))
                       (recur next-cursor acc' (inc guard))
                       acc'))))
          all (walk 1)
          ids (map :audit/id all)
          grp (entry-for all gid)]
      (is (= (count ids) (count (distinct ids))) "no unit is repeated across pages")
      (is (= 2 (count (:audit/ops grp))) "the late member rides with its group's head page")
      (is (= (set (map :audit/id (doc-audit-entries admin-request doc {:limit 1000})))
             (set ids))
          "page walk reassembles exactly the unpaginated unit set")
      (testing "the group sits at its head position, before the standalone ops that followed"
        (let [patch-ids (->> all
                             (filter #(some (fn [o] (= :span/patch-metadata (:op/type o))) (:audit/ops %)))
                             (map :audit/id))]
          (is (= gid (first patch-ids)))
          (is (= 3 (count patch-ids))))))))

;; ---------------------------------------------------------------------------
;; PATCH /operation-groups/:id — relabel + ACL
;; ---------------------------------------------------------------------------

(deftest relabel-owner-admin-and-strangers
  (let [{:keys [proj span doc]} (setup-span admin-request "GrpRelabel")
        _ (assert-no-content (add-project-writer admin-request proj "user1@example.com"))
        gid (random-uuid)]
    (assert-ok (patch-meta user1-request span (group-query gid "Merge morphemes") {"a" 1}))

    (testing "GET returns the group"
      (let [r (api-call user1-request {:method :get :path (str "/api/v1/operation-groups/" gid)})]
        (assert-ok r)
        (is (= "Merge morphemes" (-> r :body :operation-group/message)))
        (is (= "user1@example.com" (-> r :body :operation-group/user)))))

    (testing "owner refines the message; the audit read reflects it"
      (let [r (api-call user1-request {:method :patch
                                       :path (str "/api/v1/operation-groups/" gid)
                                       :body {:message "Merged 3 morphemes"}})]
        (assert-ok r)
        (is (= "Merged 3 morphemes" (-> r :body :operation-group/message))))
      (is (= "Merged 3 morphemes" (:audit/message (entry-for (doc-audit-entries admin-request doc) gid)))))

    (testing "a different non-admin user is refused"
      (assert-status 403 (api-call user2-request {:method :patch
                                                  :path (str "/api/v1/operation-groups/" gid)
                                                  :body {:message "hijack"}}))
      (is (= "Merged 3 morphemes" (:message (group-row gid)))))

    (testing "admin may relabel anyone's group"
      (assert-ok (api-call admin-request {:method :patch
                                          :path (str "/api/v1/operation-groups/" gid)
                                          :body {:message "Admin label"}}))
      (is (= "Admin label" (:message (group-row gid)))))

    (testing "unknown group → 404"
      (assert-status 404 (api-call admin-request {:method :patch
                                                  :path (str "/api/v1/operation-groups/" (random-uuid))
                                                  :body {:message "x"}})))

    (testing "unauthenticated → 401"
      (assert-status 401 (f/rest-handler (-> (mock/request :patch (str "/api/v1/operation-groups/" gid))
                                             (mock/header "accept" "application/edn")
                                             (mock/json-body {:message "x"})))))))

;; ---------------------------------------------------------------------------
;; Purge: orphan group rows go with the project's history
;; ---------------------------------------------------------------------------

(deftest purge-drops-orphaned-group-rows
  (let [{:keys [proj span]} (setup-span admin-request "GrpPurge")
        gid (random-uuid)
        keep (setup-span admin-request "GrpKeep")
        keep-gid (random-uuid)]
    (assert-ok (patch-meta admin-request span (group-query gid "Doomed") {"a" 1}))
    (assert-ok (patch-meta admin-request (:span keep) (group-query keep-gid "Survivor") {"a" 1}))
    (assert-no-content (delete-test-project admin-request proj))
    (is (some? (group-row gid)) "delete alone does not purge")
    (let [{:keys [operation-groups]} (prj/purge-deleted-project-history! f/db proj)]
      (is (pos? operation-groups))
      (is (nil? (group-row gid)))
      (is (some? (group-row keep-gid)) "a group still referenced by live ops survives"))))
