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
                                        create-vocab-layer create-vocab-item
                                        get-vocab-item
                                        update-vocab-item-metadata
                                        patch-vocab-item-metadata]]))

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

(deftest patch-merges-on-vocab-item
  (testing "vocab-item uses a bespoke (non-shared) metadata route; confirm its
            PATCH merges with the same semantics (set/overwrite, null-delete,
            preserve-omitted)"
    (let [vocab (-> (create-vocab-layer admin-request "PatchVocab") :body :id)
          item (-> (create-vocab-item admin-request vocab "hello") :body :id)
          item-meta (fn [] (-> (get-vocab-item admin-request item) :body :metadata))]
      (assert-ok (update-vocab-item-metadata admin-request item {"a" "1" "b" "2"}))
      (assert-ok (patch-vocab-item-metadata admin-request item {"a" "9" "b" nil "c" "3"}))
      (is (= {"a" "9" "c" "3"} (item-meta))
          "a overwritten, b deleted via null, c added, (no omitted keys here)"))))

(deftest patch-emits-single-folded-update-audit-row
  (testing "a patch that changes metadata emits exactly ONE :documents audit
            row, change_type :update, with old metadata in pre and merged
            metadata in post"
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
            pre (psc/read-json (:pre_image w))
            post (psc/read-json (:post_image w))]
        (is (= "update" (:change_type w)) "metadata patch is audited as an :update")
        (is (= {"a" "1" "b" "2"} (norm (:metadata pre)))
            "pre-image carries the metadata as it was before the patch")
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
