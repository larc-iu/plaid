(ns plaid.rest-api.v1.bulk-delete-test
  "DELETE /tokens/bulk, /spans/bulk, /relations/bulk and /vocab-links/bulk:
  what a list holding an id someone else already deleted answers, and that
  the answer is the same wherever in the list that id sits. The bulk UPDATE
  routes are the sibling case, in `bulk-update-test`."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler admin-request
                                    api-call assert-ok assert-created assert-no-content
                                    assert-forbidden with-admin with-test-users user1-request
                                    user2-request with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private user1 "user1@example.com")

(defn- setup
  "One project whose writer is user1, one document, a text with three word
  tokens, a span over each, two relations between them, and a vocab link on
  each of two tokens. Two of every kind, so one list can lead with a stale id
  and another can trail one."
  []
  (let [proj (create-test-project admin-request "BulkDelete")
        _ (assert-no-content (add-project-writer admin-request proj user1))
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc "dogs run cat") :body :id)
        word (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
        tok-res (bulk-create-tokens admin-request
                                    (mapv (fn [[b e]] {:token-layer-id word :text text-id :begin b :end e})
                                          [[0 4] [5 8] [9 12]]))
        [t1 t2 t3] (-> tok-res :body :ids)
        sl (-> (create-span-layer admin-request word "Spans") :body :id)
        s1 (-> (create-span admin-request sl [t1] "A") :body :id)
        s2 (-> (create-span admin-request sl [t2] "B") :body :id)
        s3 (-> (create-span admin-request sl [t3] "C") :body :id)
        rl (-> (create-relation-layer admin-request sl "Rels") :body :id)
        r1 (-> (create-relation admin-request rl s1 s2 "dep") :body :id)
        r2 (-> (create-relation admin-request rl s2 s3 "dep") :body :id)
        vocab (-> (create-vocab-layer admin-request "V") :body :id)
        _ (link-vocab-to-project admin-request proj vocab)
        item (-> (create-vocab-item admin-request vocab "dogs") :body :id)
        l1 (-> (create-vocab-link admin-request item [t1]) :body :id)
        l2 (-> (create-vocab-link admin-request item [t2]) :body :id)]
    (assert-created tok-res)
    {:proj proj :doc doc :t1 t1 :t2 t2 :t3 t3
     :s1 s1 :s2 s2 :s3 s3 :r1 r1 :r2 r2 :l1 l1 :l2 l2}))

(deftest a-stale-id-anywhere-in-the-list-deletes-the-rest
  ;; Every bulk DELETE gate resolved its project off the FIRST entry, so an
  ;; id a colleague had already removed at the head left it unresolved and
  ;; answered a writer 403, where the same list with the stale id second
  ;; deleted the rest and answered 204. A bulk delete of ids already gone is
  ;; otherwise idempotent, so the caller had no way to read the 403 as
  ;; anything but a lost grant. Deleted in dependency order, so each kind
  ;; still has both of its own entities when its turn comes.
  (let [{:keys [t1 t2 s1 s2 r1 r2 l1 l2]} (setup)
        stale (random-uuid)
        both-orders (fn [delete! a b get!]
                      (let [head (delete! user1-request [stale a])
                            tail (delete! user1-request [b stale])]
                        (assert-no-content head)
                        (assert-no-content tail)
                        (is (= (:status head) (:status tail)) "list order cannot change the answer")
                        (is (= 404 (:status (get! admin-request a))))
                        (is (= 404 (:status (get! admin-request b))))))]
    (testing "vocab links" (both-orders bulk-delete-vocab-links l1 l2 get-vocab-link))
    (testing "relations" (both-orders bulk-delete-relations r1 r2 get-relation))
    (testing "spans" (both-orders bulk-delete-spans s1 s2 get-span))
    (testing "tokens" (both-orders bulk-delete-tokens t1 t2 get-token))))

(deftest a-stale-id-at-the-head-under-occ-still-deletes
  ;; The document-version middleware resolves the document off the body too.
  ;; An unresolved one refused the call as "no document was found with the
  ;; provided version" (400), which is the same order dependence one gate
  ;; further in.
  (let [{:keys [doc s1]} (setup)
        v (-> (get-document admin-request doc) :body :document/version)
        res (api-call user1-request {:method :delete
                                     :path (str "/api/v1/spans/bulk?document-version=" v)
                                     :body [(random-uuid) s1]})]
    (assert-no-content res)
    (is (= 404 (:status (get-span admin-request s1))))
    (is (> (-> (get-document admin-request doc) :body :document/version) v)
        "and the document was bumped, so the new version comes back")))

(deftest a-stale-id-does-not-let-a-non-member-in
  ;; Skipping an entry that resolves to nothing is not skipping the gate: an
  ;; entry that DOES resolve is still the one the caller is judged against.
  (let [{:keys [s1]} (setup)
        stale (random-uuid)]
    (assert-forbidden (bulk-delete-spans user2-request [stale s1]))
    (assert-ok (get-span admin-request s1))))
