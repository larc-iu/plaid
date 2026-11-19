(ns plaid.history.undo-files-under-its-rows-project-test
  "An undo is filed under the project of the rows it may undo, not of the
  entry's first operation (ACL8-1). A P maintainer's undo of P's rows landed
  in Q's History, a project they have no role in, and was missing from P's."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    user2-request api-call assert-status db]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer create-span-layer create-text create-token
                                        create-span get-project-audit create-vocab-layer
                                        create-vocab-item update-vocab-item create-vocab-link
                                        link-vocab-to-project]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- world [label]
  (let [project (create-test-project admin-request label)
        document (create-test-document admin-request project (str "doc of " label))
        text-layer (id (create-text-layer admin-request project "TL"))
        token-layer (id (create-token-layer admin-request text-layer "Words"))
        span-layer (id (create-span-layer admin-request token-layer "Spans"))
        text (id (create-text admin-request text-layer document "alpha"))
        token (id (create-token admin-request token-layer text 0 5))
        span (id (create-span admin-request span-layer [token] "a"))]
    {:project project :document document :span span :token token}))

(defn- grant! [project role email]
  (assert-status 204 (api-call admin-request {:method :post
                                              :path (str "/api/v1/projects/" project "/" role "/" email)})))

(defn- undos [who project]
  (->> (:entries (:body (get-project-audit who project)))
       (filter (fn [e] (some #(= :audit-entry/undo (:op/type %)) (:audit/ops e))))))

(deftest an-undo-of-one-projects-rows-is-filed-under-that-project
  (let [q (world "Q")
        p (world "P")
        g (random-uuid)]
    (grant! (:project p) "maintainers" "user1@example.com")
    (grant! (:project q) "maintainers" "user2@example.com")
    (doseq [w [q p]]
      (assert-status 200 (api-call admin-request {:method :patch
                                                  :path (str "/api/v1/spans/" (:span w) "?group-id=" g
                                                             "&group-message=fix%20both")
                                                  :body {:value "changed"}})))
    (assert-status 200 (api-call user1-request {:method :post :path (str "/api/v1/audit/entries/" g "/undo")}))
    (testing "P's History has the undo, Q's has none"
      (is (= 1 (count (undos user1-request (:project p)))))
      (is (empty? (undos admin-request (:project q)))))))

(deftest an-undo-of-a-moved-vocabularys-entry-is-filed-under-its-home-now
  (let [p (create-test-project admin-request "P")
        q (create-test-project admin-request "Q")
        _ (grant! p "maintainers" "user1@example.com")
        _ (grant! q "maintainers" "user2@example.com")
        v (id (create-vocab-layer user2-request q "Wq"))
        item (id (create-vocab-item user2-request v "before"))
        _ (assert-status 200 (update-vocab-item user2-request item "after"))
        entry (->> (:entries (:body (api-call admin-request {:method :get :path (str "/api/v1/vocab-layers/" v "/audit")})))
                   (filter (fn [e] (some #(= :vocab-item/merge (:op/type %)) (:audit/ops e))))
                   first :audit/id)]
    (is (some? entry))
    (assert-status 200 (api-call admin-request {:method :post :path (str "/api/v1/vocab-layers/" v "/move")
                                                :body {:project-id p}}))
    (assert-status 200 (api-call user1-request {:method :post :path (str "/api/v1/audit/entries/" entry "/undo")}))
    (is (= "before" (-> (api-call admin-request {:method :get :path (str "/api/v1/vocab-items/" item)}) :body :vocab-item/form)))
    (testing "P's History has the undo, Q's has none"
      (is (= 1 (count (undos user1-request p))))
      (is (empty? (undos admin-request q))))))

(deftest an-entry-whose-undoable-rows-lie-in-two-projects-is-refused
  ;; The route for several entries refuses entries in more than one project
  ;; (422), since an undo is one project's History entry. An entry's own route
  ;; filed such an undo under the first operation's project, so a caller who
  ;; may undo both projects' rows (here the admin) left the other project's
  ;; History without it (REV-CA-5).
  (let [q (world "Q")
        p (world "P")
        g (random-uuid)
        entry (str "/api/v1/audit/entries/" g "/undo")]
    (doseq [w [q p]]
      (assert-status 200 (api-call admin-request {:method :patch
                                                  :path (str "/api/v1/spans/" (:span w) "?group-id=" g)
                                                  :body {:value "changed"}})))
    (doseq [dry ["" "?dry-run=true"]]
      (let [r (api-call admin-request {:method :post :path (str entry dry)})]
        (is (= 422 (:status r)) dry)
        (is (= "The entries are in more than one project. Undo each project's entries on their own."
               (-> r :body :error)))))
    (is (empty? (undos admin-request (:project p))))
    (is (empty? (undos admin-request (:project q))))
    (testing "one project's rows, named by their document, are undone and filed there"
      (assert-status 200 (api-call admin-request {:method :post
                                                  :path (str entry "?document-id=" (:document p))}))
      (is (= 1 (count (undos admin-request (:project p)))))
      (is (empty? (undos admin-request (:project q)))))))

(deftest an-entry-and-its-link-in-a-borrowed-lexicon
  ;; An entry added to H's lexicon and linked in P's document in one
  ;; operation, by a maintainer of both. Its rows lie in two projects, but
  ;; one is a vocabulary's, whose History every project borrowing it reads,
  ;; so the undo is not refused. Named by its document, it is P's.
  (let [p (world "P")
        h (create-test-project admin-request "H")
        _ (grant! (:project p) "maintainers" "user1@example.com")
        _ (grant! h "maintainers" "user1@example.com")
        v (id (create-vocab-layer user1-request h "Shared"))
        _ (link-vocab-to-project admin-request (:project p) v)
        g (random-uuid)
        item (id (api-call user1-request {:method :post :path (str "/api/v1/vocab-items?group-id=" g)
                                          :body {:vocab-layer-id v :form "alpha"}}))
        _ (assert-status 201 (api-call user1-request {:method :post
                                                      :path (str "/api/v1/vocab-links?group-id=" g)
                                                      :body {:vocab-item item :tokens [(:token p)]}}))
        undo (fn [q] (api-call user1-request {:method :post :path (str "/api/v1/audit/entries/" g "/undo" q)}))]
    (is (= 200 (:status (undo "?dry-run=true"))))
    (is (= 200 (:status (undo (str "?dry-run=true&vocab-layer-id=" v)))))
    (assert-status 200 (undo (str "?document-id=" (:document p))))
    (is (= 1 (count (undos user1-request (:project p)))))
    (is (empty? (undos user1-request h)))))

(deftest an-undo-whose-rows-lie-in-one-document-project-is-filed-there
  ;; The rule for an entry's own route: the one project of the documents whose
  ;; rows the caller may undo, else the vocabulary's home (REV-CA2-1). A
  ;; borrower's maintainer, narrowing to the borrowed vocabulary, undoes only
  ;; the link in their own document: that undo was filed under the
  ;; vocabulary's home, where they have no role, and was missing from theirs.
  (let [p (world "P")
        h (create-test-project admin-request "H")
        _ (grant! (:project p) "maintainers" "user2@example.com")
        _ (grant! (:project p) "maintainers" "user1@example.com")
        _ (grant! h "maintainers" "user1@example.com")
        v (id (create-vocab-layer admin-request h "Shared"))
        _ (link-vocab-to-project admin-request (:project p) v)
        entry! (fn []
                 (let [g (random-uuid)
                       item (id (api-call admin-request {:method :post :path (str "/api/v1/vocab-items?group-id=" g)
                                                         :body {:vocab-layer-id v :form "alpha"}}))]
                   (assert-status 201 (api-call admin-request {:method :post
                                                               :path (str "/api/v1/vocab-links?group-id=" g)
                                                               :body {:vocab-item item :tokens [(:token p)]}}))
                   g))]
    (testing "a borrower's maintainer, narrowed to the vocabulary: filed under the borrower"
      (let [g (entry!)]
        (assert-status 200 (api-call user2-request {:method :post
                                                    :path (str "/api/v1/audit/entries/" g "/undo?vocab-layer-id=" v)}))
        (is (= 1 (count (undos admin-request (:project p)))))
        (is (empty? (undos admin-request h)))))
    (testing "a maintainer of both, not narrowed: filed under the one document project"
      (let [g (entry!)]
        (assert-status 200 (api-call user1-request {:method :post :path (str "/api/v1/audit/entries/" g "/undo")}))
        (is (= 2 (count (undos admin-request (:project p)))))
        (is (empty? (undos admin-request h)))))
    (testing "the vocabulary's own rows only: filed under its home"
      (let [g (random-uuid)
            _ (api-call admin-request {:method :post :path (str "/api/v1/vocab-items?group-id=" g)
                                       :body {:vocab-layer-id v :form "beta"}})]
        (assert-status 200 (api-call user1-request {:method :post :path (str "/api/v1/audit/entries/" g "/undo")}))
        (is (= 1 (count (undos admin-request h))))))))

(deftest a-narrowed-undo-is-filed-where-the-caller-may-undo
  ;; H's vocabulary V, borrowed by B and C. user1 maintains B and C and has no
  ;; role in H, user2 maintains H only. An entry made in V and linked in
  ;; documents of B and C, undone from the vocabulary's History (narrowed by
  ;; `?vocab-layer-id=`). A caller who may undo V's rows files it under H. One
  ;; who may not, whose rows lie in two projects, is refused as the plain call
  ;; is (REV-JOIN20-1): it was filed in H's History, where they have no role.
  (let [b (world "B")
        c (world "C")
        h (create-test-project admin-request "H")
        _ (grant! (:project b) "maintainers" "user1@example.com")
        _ (grant! (:project c) "maintainers" "user1@example.com")
        _ (grant! h "maintainers" "user2@example.com")
        v (id (create-vocab-layer admin-request h "Shared"))
        _ (link-vocab-to-project admin-request (:project b) v)
        _ (link-vocab-to-project admin-request (:project c) v)
        entry! (fn [worlds & [q]]
                 (let [g (random-uuid)
                       q (str "?group-id=" g q)
                       item (id (api-call admin-request {:method :post :path (str "/api/v1/vocab-items" q)
                                                         :body {:vocab-layer-id v :form "alpha"}}))]
                   (doseq [w worlds]
                     (assert-status 201 (api-call admin-request {:method :post
                                                                 :path (str "/api/v1/vocab-links" q)
                                                                 :body {:vocab-item item :tokens [(:token w)]}})))
                   g))
        undo (fn [req g q] (api-call req {:method :post :path (str "/api/v1/audit/entries/" g "/undo" q)}))
        narrowed (str "?vocab-layer-id=" v)
        filed (fn [] (mapv #(count (undos admin-request %)) [(:project b) (:project c) h]))]
    (testing "a maintainer of both borrowers and not of the home: refused, plain or narrowed, dry run or real"
      (let [g (entry! [b c])]
        (doseq [q ["" "?dry-run=true" narrowed (str narrowed "&dry-run=true")]]
          (let [r (undo user1-request g q)]
            (is (= 422 (:status r)) q)
            (is (= "The entries are in more than one project. Undo each project's entries on their own."
                   (-> r :body :error)))))
        (is (= [0 0 0] (filed)))))
    (testing "a borrower's maintainer whose rows lie in one project: filed under it"
      (let [before (filed)
            r (undo user1-request (entry! [b]) narrowed)]
        (assert-status 200 r)
        (is (= 1 (-> r :body :total)))
        (is (= [1 0 0] (mapv - (filed) before)))))
    (testing "the home's maintainer, no role in the borrowers: the links are not theirs, the entry is built on"
      (let [before (filed)
            r (undo user2-request (entry! [b c]) narrowed)]
        (assert-status 200 r)
        (is (= 0 (-> r :body :total)))
        (is (= [0 0 0] (mapv - (filed) before)))))
    (testing "an admin: filed under the home"
      (let [before (filed)
            r (undo admin-request (entry! [b c]) narrowed)]
        (assert-status 200 r)
        (is (= 3 (-> r :body :total)))
        (is (= [0 0 1] (mapv - (filed) before)))))
    (testing "a job's undo, its entry and a link in B: filed under the entry's first operation's project"
      (let [job (str (random-uuid))
            g (entry! [b] "&group-kind=job&group-message=Assistant%20job")
            now (psc/now-iso)
            before (filed)]
        (psc/execute! db {:insert-into :jobs
                          :values [{:id job :project_id (str (:project b)) :app "igt"
                                    :started_by "admin@example.com" :state "done" :created_at now
                                    :instructions "Gloss"}]})
        (psc/execute! db {:insert-into :job_documents
                          :values [{:job_id job :document_id (str (:document b)) :position 0 :state "done"
                                    :gloss_group (str g) :updated_at now}]})
        (assert-status 200 (api-call admin-request {:method :post :path (str "/api/v1/jobs/" job "/undo")}))
        (is (= [0 0 1] (mapv - (filed) before)))))))
