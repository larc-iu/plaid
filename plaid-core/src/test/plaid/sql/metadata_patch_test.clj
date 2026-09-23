(ns plaid.sql.metadata-patch-test
  "Coverage for the metadata PATCH, a list of path ops applied in order.
  Exercised end-to-end through the document metadata REST endpoint (document
  is the entity needing the least scaffolding while still being
  document-scoped, so it also exercises OCC).

  OP SEMANTICS under test (see `plaid.sql.metadata/patch-metadata!`):
    * set at a path             -> writes there, creating missing objects
    * set at a one-key path     -> replaces that top-level key whole
    * set with null             -> stores null
    * delete at a path          -> removes that key, no-op when absent
    * a path through a scalar   -> 400, and no op of the list applies
    * empty list                -> no-op (no metadata audit row)"
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [clojure.walk]
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

(defn- set-op [path value] {:op "set" :path path :value value})
(defn- delete-op [path] {:op "delete" :path path})

(def ^:private corefud
  "The metadata from GitHub issue #62: coreference entities keyed by id."
  {"corefud" {"counts" {"c" 9 "i" 4}
              "entities" {"c8" "other-land-animal" "c9" "fish" "i3" "moon"}}
   "other" "untouched"})

(deftest patch-op-semantics
  (let [proj (create-test-project admin-request "PatchMetaProj")
        doc (create-test-document admin-request proj "Doc")]
    (assert-ok (update-document-metadata admin-request doc corefud))

    (testing "a deep set and a deep delete edit only the keys they name"
      (assert-ok (patch-document-metadata admin-request doc
                                          [(set-op ["corefud" "entities" "c10"] "bird")
                                           (set-op ["corefud" "counts" "c"] 10)
                                           (delete-op ["corefud" "entities" "c8"])]))
      (is (= {"corefud" {"counts" {"c" 10 "i" 4}
                         "entities" {"c9" "fish" "c10" "bird" "i3" "moon"}}
              "other" "untouched"}
             (doc-meta doc))))

    (testing "set creates the missing objects along its path"
      (assert-ok (patch-document-metadata admin-request doc [(set-op ["new" "a" "b"] 1)]))
      (is (= {"a" {"b" 1}} (get (doc-meta doc) "new"))))

    (testing "a one-key path replaces that top-level key whole"
      (assert-ok (patch-document-metadata admin-request doc [(set-op ["new"] {"z" 3})]))
      (is (= {"z" 3} (get (doc-meta doc) "new"))))

    (testing "delete of an absent key, or under an absent object, is a no-op"
      (let [before (doc-meta doc)]
        (assert-ok (patch-document-metadata admin-request doc
                                            [(delete-op ["nope"])
                                             (delete-op ["nope" "deeper"])
                                             (delete-op ["corefud" "entities" "zz"])]))
        (is (= before (doc-meta doc)))))

    (testing "ops apply in order"
      (assert-ok (patch-document-metadata admin-request doc
                                          [(set-op ["seq"] 1) (delete-op ["seq"]) (set-op ["seq2"] 2)]))
      (is (not (contains? (doc-meta doc) "seq")))
      (is (= 2 (get (doc-meta doc) "seq2"))))

    (testing "a later op walks into a value an earlier op of the same list set"
      (assert-ok (patch-document-metadata admin-request doc
                                          [(set-op ["fresh"] {"x" {"y" 1}})
                                           (delete-op ["fresh" "x" "y"])
                                           (set-op ["fresh" "x" "w"] 2)]))
      (is (= {"x" {"w" 2}} (get (doc-meta doc) "fresh"))))

    (testing "deleting every top-level key leaves no metadata"
      (assert-ok (patch-document-metadata admin-request doc
                                          (mapv #(delete-op [%]) (keys (doc-meta doc)))))
      (is (nil? (doc-meta doc))))))

(deftest patch-stores-null-and-falsy-values
  (testing "set stores null and every falsy value, since deletion is its own op"
    (let [proj (create-test-project admin-request "PatchFalsyProj")
          doc (create-test-document admin-request proj "Doc")]
      (assert-ok (patch-document-metadata
                  admin-request doc
                  (mapv (fn [[k v]] (set-op [k] v))
                        {"n" nil "f" false "z" 0 "e" "" "m" {}})))
      (is (= {"n" nil "f" false "z" 0 "e" "" "m" {}} (doc-meta doc)))
      (assert-ok (patch-document-metadata admin-request doc [(set-op ["m" "inner"] nil)]))
      (is (= {"inner" nil} (get (doc-meta doc) "m"))))))

(deftest patch-refuses-a-path-through-a-scalar
  (testing "a path that runs through a non-object is a 400 for either op, and
            no op of the list applies"
    (let [proj (create-test-project admin-request "PatchScalarProj")
          doc (create-test-document admin-request proj "Doc")]
      (assert-ok (update-document-metadata admin-request doc {"s" "text" "l" [1 2]}))
      (assert-status 400 (patch-document-metadata admin-request doc
                                                  [(set-op ["ok"] 1) (set-op ["s" "x"] 1)]))
      (assert-status 400 (patch-document-metadata admin-request doc [(delete-op ["s" "x"])]))
      (assert-status 400 (patch-document-metadata admin-request doc [(set-op ["l" "0"] 9)]))
      (is (= {"s" "text" "l" [1 2]} (doc-meta doc))
          "the earlier op in the refused list did not apply"))))

(deftest patch-rejects-malformed-ops
  (let [proj (create-test-project admin-request "PatchBadOpProj")
        doc (create-test-document admin-request proj "Doc")]
    (testing "an invalid (blank) top-level key is refused for set and delete alike"
      (assert-status 400 (patch-document-metadata admin-request doc [(set-op [""] "x")]))
      (assert-status 400 (patch-document-metadata admin-request doc [(delete-op [""])])))
    (testing "an empty path, an unknown op, and a set with no value are refused"
      (assert-status 400 (patch-document-metadata admin-request doc [(set-op [] "x")]))
      (assert-status 400 (patch-document-metadata admin-request doc [{:op "merge" :path ["a"] :value 1}]))
      (assert-status 400 (patch-document-metadata admin-request doc [{:op "set" :path ["a"]}])))
    (testing "the old object body is refused"
      (assert-status 400 (patch-document-metadata admin-request doc {"a" "1"})))
    (is (nil? (doc-meta doc)) "nothing was written")))

(deftest patch-refuses-metadata-nested-past-the-depth-limit
  (testing "a long path nests deeper than the body that carries it, so the
            depth limit is checked on the metadata the ops build"
    (let [proj (create-test-project admin-request "PatchDepthProj")
          doc (create-test-document admin-request proj "Doc")
          path (fn [n] (mapv #(str "k" %) (range n)))]
      (assert-ok (patch-document-metadata admin-request doc [(set-op (path 10) 1)]))
      (assert-status 400 (patch-document-metadata admin-request doc [(set-op (path 11) 1)]))
      (assert-status 400 (patch-document-metadata admin-request doc
                                                  [(set-op (conj (path 9) "deep") {"a" {"b" 1}})]))
      (is (= 1 (get-in (doc-meta doc) (path 10))) "the refused ops wrote nothing"))))

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

(deftest patch-edits-every-entity-type
  (testing "all seven entities that carry metadata share one triplet
            (plaid.sql.metadata/metadata-fns), so all seven apply ops the same way"
    (doseq [{:keys [noun id read put patch]} (every-entity)]
      (assert-ok (put admin-request id {"a" "1" "b" "2" "obj" {"x" "1" "y" "2"}}))
      (assert-ok (patch admin-request id [(set-op ["a"] "9")
                                          (delete-op ["b"])
                                          (set-op ["obj" "z"] "3")
                                          (delete-op ["obj" "y"])]))
      (is (= {"a" "9" "obj" {"x" "1" "z" "3"}} (read))
          (str noun ": a overwritten, b deleted, obj edited in place"))
      (testing (str noun " patch validates its keys and 404s on a missing entity")
        (assert-status 400 (patch admin-request id [(set-op [""] "x")]))
        (assert-status 404 (patch admin-request "00000000-0000-0000-0000-000000000000"
                                  [(set-op ["a"] "1")]))))))

(deftest patch-emits-single-folded-update-audit-row
  (testing "a patch that changes metadata emits exactly ONE :documents audit
            row, change_type :update, carrying the whole resulting metadata in
            its post-image (the log is post-image-only)"
    (let [proj (create-test-project admin-request "PatchAuditProj")
          doc (create-test-document admin-request proj "Doc")
          _ (assert-ok (update-document-metadata admin-request doc {"a" "1" "ns" {"b" "2"}}))
          _ (assert-ok (patch-document-metadata admin-request doc
                                                [(set-op ["a"] "9") (set-op ["ns" "c"] "3")]))
          op-id (latest-op-id "document/patch-metadata")
          rows (metadata-audit-rows op-id "documents")]
      (is (some? op-id) "document/patch-metadata op recorded")
      (is (= 1 (count rows))
          (str "expected exactly ONE metadata :update audit row for the patch op, got "
               (count rows)))
      (let [w (first rows)
            post (psc/read-json (:post_image w))]
        (is (= "update" (:change_type w)) "metadata patch is audited as an :update")
        (is (nil? (:pre_image w)) "pre-image is not persisted (post-image-only log)")
        (is (= {"a" "9" "ns" {"b" "2" "c" "3"}}
               (clojure.walk/stringify-keys (:metadata post)))
            "post-image carries the whole resulting metadata")))))

(deftest patch-empty-list-is-noop
  (testing "an empty op list, or ops that restate the current values, change
            nothing and emit NO metadata audit row (the doc-version bump from
            submit-operation! is separate and not asserted here)"
    (let [proj (create-test-project admin-request "PatchNoopProj")
          doc (create-test-document admin-request proj "Doc")
          _ (assert-ok (update-document-metadata admin-request doc {"a" "1" "ns" {"b" "2"}}))]
      (assert-ok (patch-document-metadata admin-request doc []))
      (is (zero? (count (metadata-audit-rows (latest-op-id "document/patch-metadata") "documents"))))
      (assert-ok (patch-document-metadata admin-request doc
                                          [(set-op ["a"] "1") (set-op ["ns" "b"] "2")]))
      (is (zero? (count (metadata-audit-rows (latest-op-id "document/patch-metadata") "documents"))))
      (is (= {"a" "1" "ns" {"b" "2"}} (doc-meta doc)) "metadata unchanged"))))

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
                                  :body [(set-op ["b"] "2")]}))
          conflict (api-call admin-request
                             {:method :patch
                              :path (str "/api/v1/documents/" doc "/metadata?document-version=" stale)
                              :body [(set-op ["c"] "3")]})]
      (assert-status 409 conflict)
      (is (some? (-> conflict :body :error)))
      (is (= {"a" "1" "b" "2"} (doc-meta doc))
          "the conflicting patch did not apply"))))
