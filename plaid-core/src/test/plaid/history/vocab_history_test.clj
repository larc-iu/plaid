(ns plaid.history.vocab-history-test
  "A vocabulary's history (audit-vocab-history, audit-past-doc-dictionary,
  ruled 2026-09-27): the vocabulary as it was at a time, one entry as it
  was, the vocabulary's log, and putting one entry back.

  The central claim, as for documents: the vocabulary read at the time of
  any past write equals what the live read served right after that write,
  entries, fields, maintainers and order included."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request user1-request with-admin with-test-users
                                    api-call assert-created assert-ok assert-no-content
                                    assert-status with-clean-db]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- enc [ts] (java.net.URLEncoder/encode (str ts) "UTF-8"))

(defn- latest-op-ts []
  (:ts (psc/q1 db {:select [:ts] :from [:operations] :order-by [[:ts :desc]] :limit 1})))

(defn- vocab-at [req vocab ts]
  (api-call req {:method :get
                 :path (str "/api/v1/vocab-layers/" vocab "?include-items=true&as-of=" (enc ts))}))

(defn- live-vocab [vocab]
  (:body (get-vocab-layer admin-request vocab true)))

(defn- item-at [req vocab item ts]
  (api-call req {:method :get
                 :path (str "/api/v1/vocab-layers/" vocab "/items/" item "?as-of=" (enc ts))}))

(defn- restore-item! [req vocab item ts & {:keys [dry-run]}]
  (api-call req {:method :post
                 :path (str "/api/v1/vocab-layers/" vocab "/items/" item "/restore?as-of=" (enc ts)
                            (when dry-run "&dry-run=true"))}))

(defn- vocab-audit [req vocab & [query]]
  (api-call req {:method :get
                 :path (str "/api/v1/vocab-layers/" vocab "/audit"
                            (when query (str "?" query)))}))

(defn- linked-doc!
  "A project using `vocab`, one document with one token. Returns ids."
  [vocab]
  (let [proj (create-test-project admin-request "Linked")
        tl (-> (create-text-layer admin-request proj "Text") :body :id)
        tkl (-> (create-token-layer admin-request tl "Words") :body :id)
        _ (assert-no-content (link-vocab-to-project admin-request proj vocab))
        doc (create-test-document admin-request proj "Doc")
        text (-> (create-text admin-request tl doc "kai eats") :body :id)
        tok (-> (create-token admin-request tkl text 0 3) :body :id)]
    {:proj proj :doc doc :token tok}))

(deftest the-vocabulary-at-any-past-write-is-what-the-live-read-served
  (let [vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        snapshots (atom [])
        snap! (fn [] (swap! snapshots conj [(latest-op-ts) (live-vocab vocab)]))
        _ (snap!)
        kai (-> (create-vocab-item admin-request vocab "kai" {"gloss" "eat"}) :body :id)
        _ (snap!)
        mata (-> (create-vocab-item admin-request vocab "mata") :body :id)
        _ (snap!)
        _ (assert-ok (update-vocab-item admin-request kai "kay"))
        _ (snap!)
        _ (assert-ok (patch-vocab-item-metadata admin-request mata [{:op "set" :path ["gloss"] :value "eye"}]))
        _ (snap!)
        [b1 b2] (-> (bulk-create-vocab-items admin-request [{:vocab-layer-id vocab :form "a"}
                                                            {:vocab-layer-id vocab :form "b"
                                                             :metadata {"pos" "N"}}])
                    :body :ids)
        _ (snap!)
        _ (assert-ok (bulk-update-vocab-items admin-request [{:id b1 :form "aa"}
                                                             {:id b2 :metadata [{:op "delete" :path ["pos"]}]}]))
        _ (snap!)
        ;; Added out of alphabetical order: the live read and the history
        ;; must agree on the order anyway.
        _ (assert-no-content (add-vocab-maintainer admin-request vocab "user2@example.com"))
        _ (snap!)
        _ (assert-no-content (add-vocab-maintainer admin-request vocab "user1@example.com"))
        _ (snap!)
        _ (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/vocab-layers/" vocab)
                                              :body {:name "Lexicon 2"}}))
        _ (snap!)
        _ (assert-no-content (delete-vocab-item admin-request kai))
        _ (snap!)
        _ (assert-no-content (bulk-delete-vocab-items admin-request [b2]))
        _ (snap!)
        ;; kai back under its old id: it takes its place at the end of the
        ;; live list, and history must say the same.
        restore-ts (first (nth @snapshots 3))
        _ (assert-ok (restore-item! admin-request vocab kai restore-ts))
        _ (snap!)]
    (doseq [[i [ts expected]] (map-indexed vector @snapshots)]
      (testing (str "after write " i)
        (let [r (vocab-at admin-request vocab ts)]
          (assert-ok r)
          (is (= expected (:body r))))))
    (testing "at now it is the live read"
      (is (= (live-vocab vocab)
             (:body (vocab-at admin-request vocab (java.time.Instant/now))))))
    (testing "without include-items, no entries"
      (is (not (contains? (:body (api-call admin-request
                                           {:method :get
                                            :path (str "/api/v1/vocab-layers/" vocab "?as-of="
                                                       (enc (latest-op-ts)))}))
                          :vocab/items))))
    (testing "before it existed, 404"
      (assert-status 404 (vocab-at admin-request vocab "2020-01-01T00:00:00Z")))
    (testing "a malformed time, 400"
      (assert-status 400 (vocab-at admin-request vocab "yesterday")))))

(deftest one-entry-at-a-time-also-after-its-delete
  (let [vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        other (-> (create-vocab-layer admin-request "Other") :body :id)
        kai (-> (create-vocab-item admin-request vocab "kai" {"gloss" "eat"}) :body :id)
        t1 (latest-op-ts)
        _ (assert-no-content (delete-vocab-item admin-request kai))
        t2 (latest-op-ts)]
    (testing "as it was"
      (let [r (item-at admin-request vocab kai t1)]
        (assert-ok r)
        (is (= {:vocab-item/id kai :vocab-item/layer vocab :vocab-item/form "kai"
                :metadata {"gloss" "eat"}}
               (:body r)))))
    (testing "gone after the delete"
      (assert-status 404 (item-at admin-request vocab kai t2)))
    (testing "not an entry of another vocabulary"
      (assert-status 404 (item-at admin-request other kai t1)))
    (testing "the time is required"
      (assert-status 400 (api-call admin-request {:method :get
                                                  :path (str "/api/v1/vocab-layers/" vocab "/items/" kai)})))))

(deftest putting-a-deleted-entry-back
  (let [vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        {:keys [doc token]} (linked-doc! vocab)
        kai (-> (create-vocab-item admin-request vocab "kai" {"gloss" "eat" "pos" "V"}) :body :id)
        link (-> (create-vocab-link admin-request kai [token]) :body :id)
        _ (is (some? link))
        before-delete (latest-op-ts)
        _ (assert-no-content (delete-vocab-item admin-request kai))
        modified-before (:vocab/time-modified (live-vocab vocab))]
    (testing "a dry run says what would change and writes nothing"
      (let [ops (psc/q1 db {:select [[[:count :*] :n]] :from [:operations]})
            r (restore-item! admin-request vocab kai before-delete :dry-run true)]
        (assert-ok r)
        (is (= {:inserted true :form false :metadata false :total 1} (:body r)))
        (is (= ops (psc/q1 db {:select [[[:count :*] :n]] :from [:operations]})))))
    (testing "the entry comes back under its old id, with its form and fields"
      (let [r (restore-item! admin-request vocab kai before-delete)]
        (assert-ok r)
        (is (= {:inserted true :form false :metadata false :total 1} (:body r)))
        (is (= {:vocab-item/id kai :vocab-item/layer vocab :vocab-item/form "kai"
                :metadata {"gloss" "eat" "pos" "V"}}
               (:body (api-call admin-request {:method :get :path (str "/api/v1/vocab-items/" kai)}))))))
    (testing "it stamps the vocabulary, so a client's copy is known stale"
      (is (pos? (compare (:vocab/time-modified (live-vocab vocab)) modified-before))))
    (testing "its link does not come back with it"
      (is (zero? (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:vocab_links]
                                 :where [:= :vocab_item_id kai]})))))
    (testing "the document's own restore now brings the link back"
      (let [r (api-call admin-request {:method :post
                                       :path (str "/api/v1/documents/" doc "/restore?as-of="
                                                  (enc before-delete))})]
        (assert-ok r)
        (is (empty? (get-in r [:body :skipped])))
        (is (= [link] (mapv :id (psc/q db {:select [:id] :from [:vocab_links]
                                           :where [:= :vocab_item_id kai]}))))))
    (testing "a time when the entry did not exist is refused"
      (assert-status 400 (restore-item! admin-request vocab kai "2020-01-01T00:00:00Z")))))

(deftest setting-a-living-entry-back
  (let [vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        {:keys [doc token]} (linked-doc! vocab)
        kai (-> (create-vocab-item admin-request vocab "kai" {"gloss" "eat"}) :body :id)
        _ (create-vocab-link admin-request kai [token])
        t (latest-op-ts)
        _ (assert-ok (update-vocab-item admin-request kai "kay"))
        _ (assert-ok (update-vocab-item-metadata admin-request kai {"gloss" "consume"}))
        version-before (-> (get-document admin-request doc) :body :document/version)
        r (restore-item! admin-request vocab kai t)]
    (assert-ok r)
    (is (= {:inserted false :form true :metadata true :total 2} (:body r)))
    (is (= {:vocab-item/id kai :vocab-item/layer vocab :vocab-item/form "kai" :metadata {"gloss" "eat"}}
           (:body (api-call admin-request {:method :get :path (str "/api/v1/vocab-items/" kai)}))))
    (testing "the form set back restates the linking document, and says so"
      (let [v (-> (get-document admin-request doc) :body :document/version)]
        (is (= (inc version-before) v))
        (is (re-find (re-pattern (str doc)) (str (get-in r [:headers "X-Document-Versions"]))))))
    (testing "nothing left to set back"
      (is (= {:inserted false :form false :metadata false :total 0}
             (:body (restore-item! admin-request vocab kai t :dry-run true)))))))

(deftest the-vocabulary-log
  (let [vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        {:keys [token]} (linked-doc! vocab)
        kai (-> (create-vocab-item admin-request vocab "kai") :body :id)
        _ (create-vocab-link admin-request kai [token])
        _ (assert-ok (update-vocab-item admin-request kai "kay"))
        r (vocab-audit admin-request vocab "order=desc")
        types (mapv #(-> % :audit/ops first :op/type) (get-in r [:body :entries]))]
    (assert-ok r)
    (testing "the vocabulary's own writes and its entries', newest first, and not the link"
      (is (= [:vocab-item/merge :vocab-item/create :vocab/create] types)))
    (testing "oldest first too"
      (is (= [:vocab/create :vocab-item/create :vocab-item/merge]
             (mapv #(-> % :audit/ops first :op/type)
                   (get-in (vocab-audit admin-request vocab "order=asc") [:body :entries])))))))

(deftest who-may-read-and-restore
  (let [vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        {:keys [proj]} (linked-doc! vocab)
        kai (-> (create-vocab-item admin-request vocab "kai") :body :id)
        t (latest-op-ts)
        _ (assert-no-content (delete-vocab-item admin-request kai))]
    (testing "a stranger reads nothing"
      (assert-status 403 (vocab-at user1-request vocab t))
      (assert-status 403 (item-at user1-request vocab kai t))
      (assert-status 403 (vocab-audit user1-request vocab)))
    (assert-no-content (add-project-writer admin-request proj "user1@example.com"))
    (testing "a writer of a project it is shared with reads its past"
      (assert-ok (vocab-at user1-request vocab t))
      (assert-ok (item-at user1-request vocab kai t))
      (assert-ok (vocab-audit user1-request vocab)))
    (testing "but cannot put an entry back"
      (assert-status 403 (restore-item! user1-request vocab kai t))
      (assert-status 403 (restore-item! user1-request vocab kai t :dry-run true)))
    (testing "a maintainer of the vocabulary can"
      (assert-no-content (add-vocab-maintainer admin-request vocab "user1@example.com"))
      (assert-ok (restore-item! user1-request vocab kai t)))))

(deftest as-of-is-refused-where-it-means-nothing
  (let [vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        kai (-> (create-vocab-item admin-request vocab "kai") :body :id)
        t (enc (latest-op-ts))]
    (doseq [[method path] [[:patch (str "/api/v1/vocab-layers/" vocab "?as-of=" t)]
                           [:get (str "/api/v1/vocab-layers?as-of=" t)]
                           [:get (str "/api/v1/vocab-layers/" vocab "/audit?as-of=" t)]
                           [:get (str "/api/v1/vocab-items/" kai "?as-of=" t)]]]
      (testing (str (name method) " " path)
        (assert-status 400 (api-call admin-request (cond-> {:method method :path path}
                                                     (= method :patch) (assoc :body {:name "X"}))))))))

(deftest every-entry-change-moves-the-vocabularys-time
  ;; What a client checks before reusing its copy of the entries
  ;; (perf-vocab-cache): every write that changes an entry moves it.
  (let [vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        {:keys [token]} (linked-doc! vocab)
        stamp #(:vocab/time-modified (live-vocab vocab))
        moved? (fn [label write!]
                 (let [before (stamp)]
                   (write!)
                   (testing label (is (pos? (compare (stamp) before))))))
        kai (atom nil)
        t (atom nil)]
    (moved? "create" #(reset! kai (-> (create-vocab-item admin-request vocab "kai") :body :id)))
    (reset! t (latest-op-ts))
    (moved? "rename" #(assert-ok (update-vocab-item admin-request @kai "kay")))
    (moved? "fields set" #(assert-ok (update-vocab-item-metadata admin-request @kai {"gloss" "eat"})))
    (moved? "fields patched" #(assert-ok (patch-vocab-item-metadata admin-request @kai
                                                                    [{:op "set" :path ["pos"] :value "V"}])))
    (moved? "fields deleted" #(assert-ok (delete-vocab-item-metadata admin-request @kai)))
    (moved? "bulk create" #(assert-created (bulk-create-vocab-items admin-request [{:vocab-layer-id vocab :form "a"}])))
    (moved? "bulk update" #(assert-ok (bulk-update-vocab-items admin-request [{:id @kai :form "kei"}])))
    (moved? "restore" #(assert-ok (restore-item! admin-request vocab @kai @t)))
    (moved? "delete" #(assert-no-content (delete-vocab-item admin-request @kai)))
    (testing "a link is the document's, and leaves the vocabulary's time alone"
      (let [other (-> (create-vocab-item admin-request vocab "mata") :body :id)
            before (stamp)]
        (assert-created (create-vocab-link admin-request other [token]))
        (is (= before (stamp)))))))

(deftest one-entrys-log
  (let [vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        other-vocab (-> (create-vocab-layer admin-request "Other") :body :id)
        {:keys [token]} (linked-doc! vocab)
        kai (-> (create-vocab-item admin-request vocab "kai" {"gloss" "eat"}) :body :id)
        mata (-> (create-vocab-item admin-request vocab "mata") :body :id)
        _ (create-vocab-link admin-request kai [token])
        t (latest-op-ts)
        _ (assert-ok (update-vocab-item admin-request kai "kay"))
        _ (assert-ok (update-vocab-item admin-request mata "mata2"))
        _ (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/vocab-layers/" vocab)
                                              :body {:name "Lexicon 2"}}))
        _ (assert-ok (bulk-update-vocab-items admin-request [{:id kai :form "kaa"} {:id mata :form "mata3"}]))
        _ (assert-ok (patch-vocab-item-metadata admin-request kai [{:op "set" :path ["gloss"] :value "consume"}]))
        _ (assert-no-content (delete-vocab-item admin-request kai))
        _ (assert-ok (restore-item! admin-request vocab kai t))
        types-of (fn [r] (mapv #(-> % :audit/ops first :op/type) (get-in r [:body :entries])))]
    (testing "only the changes that wrote the entry, the link and the other entry left out"
      (let [r (vocab-audit admin-request vocab (str "item-id=" kai))]
        (assert-ok r)
        (is (= [:vocab-item/create :vocab-item/merge :vocab-item/bulk-merge :vocab-item/patch-metadata
                :vocab-item/delete :vocab-item/restore]
               (types-of r)))))
    (testing "a change that wrote both entries shows under each"
      (let [bulk (->> (get-in (vocab-audit admin-request vocab (str "item-id=" mata)) [:body :entries])
                      (filter #(= :vocab-item/bulk-merge (-> % :audit/ops first :op/type)))
                      first)]
        (is (some? bulk))
        (is (= 1 (count (:audit/ops bulk))))))
    (testing "newest first too"
      (is (= :vocab-item/restore
             (first (types-of (vocab-audit admin-request vocab (str "order=desc&item-id=" kai)))))))
    (testing "an entry of another vocabulary has no changes here"
      (let [r (vocab-audit admin-request other-vocab (str "item-id=" kai))]
        (assert-ok r)
        (is (empty? (get-in r [:body :entries])))))
    (testing "a malformed id, 400"
      (assert-status 400 (vocab-audit admin-request vocab "item-id=nope")))))
