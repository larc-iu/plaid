(ns plaid.sql.metadata-patch-test
  "Coverage for the metadata PATCH (shallow-merge) path added alongside the
  full-replace PUT. Exercised end-to-end through the document metadata REST
  endpoint (document is the entity needing the least scaffolding while still
  being document-scoped, so it also exercises OCC).

  MERGE SEMANTICS under test (see `plaid.sql.metadata/patch-metadata!`):
    * key present in patch            -> set / overwrite
    * key absent from patch           -> left untouched
    * key whose value is null         -> deleted
    * merge is top-level only         -> nested objects replaced wholesale
    * empty patch                     -> no-op (no metadata audit row)"
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request api-call assert-ok assert-status
                                    with-admin with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        get-document
                                        update-document-metadata
                                        patch-document-metadata
                                        create-text-layer create-token-layer
                                        create-span-layer create-relation-layer
                                        create-text get-text
                                        update-text-metadata patch-text-metadata
                                        create-token get-token
                                        update-token-metadata patch-token-metadata
                                        create-span get-span
                                        update-span-metadata patch-span-metadata
                                        create-relation get-relation
                                        update-relation-metadata patch-relation-metadata
                                        create-vocab-layer create-vocab-item
                                        get-vocab-item
                                        update-vocab-item-metadata
                                        patch-vocab-item-metadata
                                        link-vocab-to-project
                                        create-vocab-link get-vocab-link
                                        update-vocab-link-metadata
                                        patch-vocab-link-metadata]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- doc-meta
  "Read the document's metadata back through the GET endpoint. Returns a
  string-keyed map, or nil when the document has no metadata (the read path
  omits :metadata entirely when empty)."
  [doc]
  (-> (get-document admin-request doc) :body :metadata))

(defn- latest-op-id [op-type]
  (:id (psc/q1 db {:select [:id] :from [:operations]
                   :where [:= :op_type op-type]
                   :order-by [[:ts :desc] [:id :desc]] :limit 1})))

(defn- metadata-audit-rows
  "The synthetic metadata-transition audit rows for an op on its parent table.
  Scoped to change_type 'update' so it excludes the unrelated 'doc-version-bump'
  row that `submit-operation!` always emits against `documents` (which, for the
  document entity, lands on the same table as the metadata fold)."
  [op-id table]
  (psc/q db {:select [:*] :from [:audit_writes]
             :where [:and
                     [:= :op_id op-id]
                     [:= :target_table table]
                     [:= :change_type "update"]]
             :order-by [:seq]}))

(deftest patch-merge-semantics
  (let [proj (create-test-project admin-request "PatchMetaProj")
        doc (create-test-document admin-request proj "Doc")]

    (testing "patch onto empty metadata sets the new keys"
      (assert-ok (patch-document-metadata admin-request doc {"a" "1" "b" "2"}))
      (is (= {"a" "1" "b" "2"} (doc-meta doc))))

    (testing "keys present overwrite; keys absent are left untouched"
      (assert-ok (patch-document-metadata admin-request doc {"a" "9"}))
      (is (= {"a" "9" "b" "2"} (doc-meta doc))
          "a overwritten to 9, b preserved"))

    (testing "a null value deletes that key, leaving the rest"
      (assert-ok (patch-document-metadata admin-request doc {"a" nil}))
      (is (= {"b" "2"} (doc-meta doc))
          "a deleted, b preserved"))

    (testing "nested objects are replaced wholesale, NOT deep-merged"
      (assert-ok (update-document-metadata admin-request doc {"obj" {"x" "1" "y" "2"}}))
      (assert-ok (patch-document-metadata admin-request doc {"obj" {"z" "3"}}))
      (is (= {"obj" {"z" "3"}} (doc-meta doc))
          "obj replaced with {z 3}, not merged into {x 1 y 2 z 3}"))

    (testing "patching the last key out leaves no metadata"
      (assert-ok (patch-document-metadata admin-request doc {"obj" nil}))
      (is (nil? (doc-meta doc))
          "metadata is absent once every key is deleted"))))

(deftest patch-distinguishes-null-from-falsy
  (testing "only nil/JSON-null deletes; falsy-but-non-null values (false, 0,
            empty string, empty map) are SET, not deleted — this is the
            defining contract of the patch path (delete signal is (nil? v),
            not truthiness)"
    (let [proj (create-test-project admin-request "PatchFalsyProj")
          doc (create-test-document admin-request proj "Doc")]
      (assert-ok (patch-document-metadata
                  admin-request doc
                  {"f" false "z" 0 "e" "" "m" {} "keep" "v"}))
      (is (= {"f" false "z" 0 "e" "" "m" {} "keep" "v"} (doc-meta doc))
          "every falsy-but-non-null value was stored")
      (testing "and null on one key deletes only that key, leaving falsy ones"
        (assert-ok (patch-document-metadata admin-request doc {"keep" nil}))
        (is (= {"f" false "z" 0 "e" "" "m" {}} (doc-meta doc))
            "keep deleted; false/0/\"\"/{} all survive")))))

(deftest patch-rejects-invalid-key
  (testing "an invalid (blank) metadata key is rejected with 400, whether it
            carries a value (set) or null (delete) — validation runs before the
            merge so you cannot smuggle a bad key in via a delete either"
    (let [proj (create-test-project admin-request "PatchBadKeyProj")
          doc (create-test-document admin-request proj "Doc")]
      (assert-status 400 (patch-document-metadata admin-request doc {"" "x"}))
      (assert-status 400 (patch-document-metadata admin-request doc {"" nil})))))

(defn- every-entity
  "One of each entity that carries metadata, with the reader and the two
  writers for each. Seven entries: span, relation, token, text, document,
  vocab item, vocab link."
  []
  (let [proj (create-test-project admin-request "AllSevenMeta")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tokl (-> (create-token-layer admin-request tl "Tokens") :body :id)
        sl (-> (create-span-layer admin-request tokl "Spans") :body :id)
        rl (-> (create-relation-layer admin-request sl "Rels") :body :id)
        vocab (-> (create-vocab-layer admin-request "AllSevenVocab") :body :id)
        _ (link-vocab-to-project admin-request proj vocab)
        doc (create-test-document admin-request proj "Doc")
        text (-> (create-text admin-request tl doc "ab cd") :body :id)
        t1 (-> (create-token admin-request tokl text 0 2) :body :id)
        t2 (-> (create-token admin-request tokl text 3 5) :body :id)
        s1 (-> (create-span admin-request sl [t1] "A") :body :id)
        s2 (-> (create-span admin-request sl [t2] "B") :body :id)
        rel (-> (create-relation admin-request rl s1 s2 "dep") :body :id)
        item (-> (create-vocab-item admin-request vocab "hello") :body :id)
        link (-> (create-vocab-link admin-request item [t1]) :body :id)
        read (fn [getter id] (fn [] (-> (getter admin-request id) :body :metadata)))]
    [{:noun "span" :id s1 :read (read get-span s1)
      :put update-span-metadata :patch patch-span-metadata}
     {:noun "relation" :id rel :read (read get-relation rel)
      :put update-relation-metadata :patch patch-relation-metadata}
     {:noun "token" :id t1 :read (read get-token t1)
      :put update-token-metadata :patch patch-token-metadata}
     {:noun "text" :id text :read (read get-text text)
      :put update-text-metadata :patch patch-text-metadata}
     {:noun "document" :id doc :read (read get-document doc)
      :put update-document-metadata :patch patch-document-metadata}
     {:noun "vocab item" :id item :read (read get-vocab-item item)
      :put update-vocab-item-metadata :patch patch-vocab-item-metadata}
     {:noun "vocab link" :id link :read (read get-vocab-link link)
      :put update-vocab-link-metadata :patch patch-vocab-link-metadata}]))

(deftest patch-merges-on-every-entity-type
  (testing "all seven entities that carry metadata share one triplet
            (plaid.sql.metadata/metadata-fns), so all seven merge the same way:
            set/overwrite, null-delete, preserve-omitted, replace-nested"
    (doseq [{:keys [noun id read put patch]} (every-entity)]
      (assert-ok (put admin-request id {"a" "1" "b" "2" "obj" {"x" "1"}}))
      (assert-ok (patch admin-request id {"a" "9" "b" nil "c" "3" "obj" {"z" "3"}}))
      (is (= {"a" "9" "c" "3" "obj" {"z" "3"}} (read))
          (str noun ": a overwritten, b deleted via null, c added, obj replaced wholesale"))
      (testing (str noun " patch validates its keys and 404s on a missing entity")
        (assert-status 400 (patch admin-request id {"" "x"}))
        (assert-status 404 (patch admin-request "00000000-0000-0000-0000-000000000000" {"a" "1"}))))))

(deftest patch-emits-single-folded-update-audit-row
  (testing "a patch that changes metadata emits exactly ONE :documents audit
            row, change_type :update, carrying the merged metadata in its
            post-image (the log is post-image-only)"
    (let [proj (create-test-project admin-request "PatchAuditProj")
          doc (create-test-document admin-request proj "Doc")
          _ (assert-ok (update-document-metadata admin-request doc {"a" "1" "b" "2"}))
          _ (assert-ok (patch-document-metadata admin-request doc {"a" "9" "c" "3"}))
          op-id (latest-op-id "document/patch-metadata")
          rows (metadata-audit-rows op-id "documents")]
      (is (some? op-id) "document/patch-metadata op recorded")
      (is (= 1 (count rows))
          (str "expected exactly ONE metadata :update audit row for the patch op, got "
               (count rows)))
      (let [w (first rows)
            norm (fn [m] (into {} (map (fn [[k v]] [(name k) v])) m))
            post (psc/read-json (:post_image w))]
        (is (= "update" (:change_type w)) "metadata patch is audited as an :update")
        (is (nil? (:pre_image w)) "pre-image is not persisted (post-image-only log)")
        (is (= {"a" "9" "b" "2" "c" "3"} (norm (:metadata post)))
            "post-image carries the shallow-merged result")))))

(deftest patch-empty-body-is-noop
  (testing "an empty patch changes nothing and emits NO metadata audit row
            (the doc-version bump from submit-operation! is separate and not
            asserted here)"
    (let [proj (create-test-project admin-request "PatchNoopProj")
          doc (create-test-document admin-request proj "Doc")
          _ (assert-ok (update-document-metadata admin-request doc {"a" "1"}))
          _ (assert-ok (patch-document-metadata admin-request doc {}))
          op-id (latest-op-id "document/patch-metadata")]
      (is (= {"a" "1"} (doc-meta doc)) "metadata unchanged by the empty patch")
      (is (zero? (count (metadata-audit-rows op-id "documents")))
          "no metadata-transition audit row emitted when pre == post"))))

(deftest patch-respects-optimistic-concurrency
  (testing "PATCH with a stale ?document-version returns 409"
    (let [proj (create-test-project admin-request "PatchOccProj")
          doc (create-test-document admin-request proj "Doc")
          _ (assert-ok (update-document-metadata admin-request doc {"a" "1"}))
          stale (-> (get-document admin-request doc) :body :document/version)
          ;; advance the version with an intervening patch
          _ (assert-ok (api-call admin-request
                                 {:method :patch
                                  :path (str "/api/v1/documents/" doc "/metadata?document-version=" stale)
                                  :body {"b" "2"}}))
          conflict (api-call admin-request
                             {:method :patch
                              :path (str "/api/v1/documents/" doc "/metadata?document-version=" stale)
                              :body {"c" "3"}})]
      (assert-status 409 conflict)
      (is (some? (-> conflict :body :error)))
      (is (= {"a" "1" "b" "2"} (doc-meta doc))
          "the conflicting patch did not apply"))))
