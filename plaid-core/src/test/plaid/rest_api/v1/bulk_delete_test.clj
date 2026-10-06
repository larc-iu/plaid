(ns plaid.rest-api.v1.bulk-delete-test
  "DELETE /tokens/bulk, /spans/bulk, /relations/bulk and /vocab-links/bulk:
  what a list holding an id someone else already deleted answers, and that
  the answer is the same wherever in the list that id sits, and that a list
  of nothing but gone ids (/vocab-items/bulk too) is a 204 that writes
  nothing, alone and in a batch, for a writer and an admin. The bulk UPDATE
  routes are the sibling case, in `bulk-update-test`."
  (:require [clojure.test :refer :all]
            [ring.mock.request :as mock]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler admin-request
                                    api-call assert-ok assert-created assert-no-content
                                    assert-forbidden assert-status with-admin with-test-users
                                    user1-request user2-request with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private user1 "user1@example.com")

(defn- setup
  "One project whose writer is user1, one document, a text with three word
  tokens, a span over each, two relations between them, and a vocab link on
  each of two tokens. Two of every kind, so one list can lead with a stale id
  and another can trail one. Two entries of their own (`:v1`, `:v2`), linked
  to nothing. With `:writer? false`, user1 is in neither the project nor
  its vocabulary."
  ([] (setup {:writer? true}))
  ([{:keys [writer?]}]
   (let [proj (create-test-project admin-request "BulkDelete")
         _ (when writer? (assert-no-content (add-project-writer admin-request proj user1)))
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
         vocab (-> (create-vocab-layer admin-request (str "V " (random-uuid))) :body :id)
         _ (link-vocab-to-project admin-request proj vocab)
         _ (when writer? (assert-no-content (add-vocab-maintainer admin-request vocab user1)))
         item (-> (create-vocab-item admin-request vocab "dogs") :body :id)
         l1 (-> (create-vocab-link admin-request item [t1]) :body :id)
         l2 (-> (create-vocab-link admin-request item [t2]) :body :id)
         v1 (-> (create-vocab-item admin-request vocab "run") :body :id)
         v2 (-> (create-vocab-item admin-request vocab "cat") :body :id)]
     (assert-created tok-res)
     {:proj proj :doc doc :t1 t1 :t2 t2 :t3 t3
      :s1 s1 :s2 s2 :s3 s3 :r1 r1 :r2 r2 :l1 l1 :l2 l2 :v1 v1 :v2 v2})))

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

;; A bulk delete whose ids are ALL gone (D8-PRODLOG-1). The gate had no
;; project to judge, so it refused a writer 403 `unresolved` and let an admin
;; through to a 204, and in a batch the 403 refused everything else in it. A
;; script that deleted words and then their morphemes, which the words had
;; already taken with them, stopped halfway on prod. Ruled: a successful
;; no-op for everyone, alone and in a batch, writing nothing.

(def ^:private routes
  {:tokens "/api/v1/tokens/bulk"
   :spans "/api/v1/spans/bulk"
   :relations "/api/v1/relations/bulk"
   :vocab-links "/api/v1/vocab-links/bulk"
   :vocab-items "/api/v1/vocab-items/bulk"})

(defn- writes
  "How many audit rows and operations the database holds."
  []
  [(:n (psc/q1 db {:select [[[:count :*] :n]] :from [:audit_writes]}))
   (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:operations]}))])

(defn- batch [request-fn ops]
  (api-call request-fn {:method :post :path "/api/v1/batch"
                        :body (mapv (fn [[path ids]] {:path path :method "delete" :body ids}) ops)}))

(defn- delete-all!
  "Delete every entity setup made, by admin, and answer the ids per route."
  [{:keys [t1 t2 t3 s1 s2 s3 r1 r2 l1 l2 v1 v2]}]
  (assert-no-content (bulk-delete-vocab-items admin-request [v1 v2]))
  (assert-no-content (bulk-delete-tokens admin-request [t1 t2 t3]))
  {:tokens [t1 t2 t3] :spans [s1 s2 s3] :relations [r1 r2]
   :vocab-links [l1 l2] :vocab-items [v1 v2]})

(deftest a-list-of-gone-ids-is-a-no-op
  (let [gone (delete-all! (setup))]
    (doseq [[kind path] routes
            [who request-fn] [["writer" user1-request] ["admin" admin-request]]
            [label ids] [["deleted ids" (gone kind)] ["ids never there" [(random-uuid) (random-uuid)]]]]
      (testing (str (name kind) ", " who ", " label)
        (let [before (writes)
              r (api-call request-fn {:method :delete :path path :body ids})]
          (assert-no-content r)
          (is (= before (writes)) "nothing is written"))))))

(deftest a-list-of-gone-ids-is-a-no-op-under-occ
  ;; A strict client stamps every write. There is no document to check the
  ;; stamp against, and nothing is written, so the stamp changes nothing.
  (let [{:keys [doc] :as ents} (setup)
        gone (delete-all! ents)
        v (-> (get-document admin-request doc) :body :document/version)]
    (doseq [kind [:tokens :spans :relations :vocab-links]]
      (testing (name kind)
        (assert-no-content (api-call user1-request {:method :delete
                                                    :path (str (routes kind) "?document-version=" v)
                                                    :body (gone kind)}))))
    (is (= v (-> (get-document admin-request doc) :body :document/version)))))

(deftest a-list-of-gone-ids-in-a-batch-lets-the-batch-through
  (doseq [[who request-fn] [["writer" user1-request] ["admin" admin-request]]]
    (testing (str who ": the prod script's order, each kind after a delete that took it")
      (let [{:keys [t1 t2 t3 s1 s2 r1 l1 l2]} (setup)
            r (batch request-fn [[(routes :tokens) [t1 t2]]
                                 [(routes :tokens) [t1 t2]]
                                 [(routes :spans) [s1 s2]]
                                 [(routes :relations) [r1]]
                                 [(routes :vocab-links) [l1 l2]]])]
        (assert-status 200 r)
        (is (every? #(= 204 (:status %)) (:body r)))
        (is (= 404 (:status (get-token admin-request t1))) "the live delete in the batch landed")
        (assert-ok (get-token admin-request t3))))
    (testing (str who ": every route, gone ids only, beside a live delete")
      (let [ents (setup)
            gone (delete-all! ents)
            {:keys [t3]} (setup)
            r (batch request-fn (conj (mapv (fn [[kind path]] [path (gone kind)]) routes)
                                      [(routes :tokens) [t3]]))]
        (assert-status 200 r)
        (is (= 404 (:status (get-token admin-request t3))))))))

(deftest gone-ids-do-not-carry-another-projects-ids-past-the-gate
  ;; The no-op is for a list in which NOTHING resolves. An id that lives in a
  ;; project (or vocabulary) the caller cannot write is still judged there.
  (let [gone (delete-all! (setup))
        {:keys [t1 s1 r1 l1 v1]} (setup {:writer? false})
        theirs {:tokens t1 :spans s1 :relations r1 :vocab-links l1 :vocab-items v1}]
    (doseq [[kind path] routes]
      (testing (name kind)
        (let [ids (conj (gone kind) (theirs kind))
              r (api-call user1-request {:method :delete :path path :body ids})]
          (assert-forbidden r)
          (is (not (contains? (:body r) :unresolved)) "a real refusal, not a gone id"))
        (testing "in a batch"
          (assert-forbidden (batch user1-request [[path (into [(theirs kind)] (gone kind))]])))))
    (assert-ok (get-token admin-request t1))
    (assert-ok (get-span admin-request s1))
    (assert-ok (get-relation admin-request r1))
    (assert-ok (get-vocab-link admin-request l1))
    (assert-ok (get-vocab-item admin-request v1))))

(deftest a-list-of-gone-ids-still-needs-a-login
  (assert-status 401 (api-call (fn [method path]
                                 (-> (mock/request method path)
                                     (mock/header "accept" "application/edn")))
                               {:method :delete :path (routes :tokens) :body [(random-uuid)]})))

(deftest a-single-delete-of-a-gone-id-is-unchanged
  ;; The unknown-id ruling stands for everything but a bulk delete.
  (let [{:keys [t1]} (setup)]
    (assert-no-content (delete-token admin-request t1))
    (let [r (delete-token user1-request t1)]
      (assert-forbidden r)
      (is (true? (-> r :body :unresolved))))
    (assert-status 404 (delete-token admin-request t1))))
