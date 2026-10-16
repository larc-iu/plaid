(ns plaid.sql.document-names-test
  "Document names are unique in a project (plaid.sql.document-names).

  The invariant: after any write, no two documents of a project share a
  name. Create and rename refuse a taken name with 422 and `name-taken`;
  a create or copy with `free-name` takes the first free \"Name (n)\"; a
  restore keeps the current name when the old one is taken; and the
  migration renames the documents that already shared a name, the oldest
  keeping it."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [migratus.core :as migratus]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-created assert-ok assert-status with-clean-db]]
            [plaid.sql.datasource :as psd]
            [plaid.sql.document-names :as names]
            [plaid.test-helpers :refer [create-test-project create-test-document temp-db-path
                                        latest-op-ts]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- create! [project name & {:as more}]
  (api-call admin-request {:method :post :path "/api/v1/documents"
                           :body (merge {:project-id project :name name} more)}))

(defn- rename! [doc-id name]
  (api-call admin-request {:method :patch :path (str "/api/v1/documents/" doc-id) :body {:name name}}))

(defn- copy! [doc-id name & {:as more}]
  (api-call admin-request {:method :post :path (str "/api/v1/documents/" doc-id "/copy")
                           :body (merge {:name name} more)}))

(defn- restore! [doc-id ts]
  (api-call admin-request {:method :post
                           :path (str "/api/v1/documents/" doc-id "/restore?as-of="
                                      (java.net.URLEncoder/encode (str ts) "UTF-8"))}))

(defn- names-in [project]
  (sort (map :name (jdbc/execute! db ["SELECT name FROM documents WHERE project_id = ?" project]
                                  {:builder-fn rs/as-unqualified-maps}))))

(defn- unique? [project]
  (let [ns (names-in project)] (= (count ns) (count (set ns)))))

(deftest free-name-takes-the-first-free-candidate
  (is (= "A" (names/free-name #{} "A")))
  (is (= "A (2)" (names/free-name #{"A"} "A")))
  (is (= "A (4)" (names/free-name #{"A" "A (2)" "A (3)"} "A")))
  (is (= "A (2)" (names/free-name #{"A" "A (3)"} "A")) "the first free, not one past the highest")
  (is (= "A (2) (2)" (names/free-name #{"A (2)"} "A (2)")) "a name ending in a number is a name like any other"))

(deftest renames-keep-the-oldest-and-avoid-every-name
  (let [docs [{:id "d3" :name "A" :created_at "2026-01-03"}
              {:id "d1" :name "A" :created_at "2026-01-01"}
              {:id "d2" :name "A" :created_at "2026-01-02"}
              {:id "d4" :name "A (2)" :created_at "2026-01-04"}
              {:id "d5" :name "B" :created_at "2026-01-05"}
              {:id "d6" :name "B" :created_at "2026-01-05"}]
        rs (into {} (names/renames docs))]
    (is (= {"d2" "A (3)" "d3" "A (4)" "d6" "B (2)"} rs)
        "the oldest keeps the name, a tie goes by id, and a name already held is skipped")
    (is (apply distinct? (map #(get rs (:id %) (:name %)) docs)))))

(deftest create-and-rename-refuse-a-taken-name
  (let [p (create-test-project admin-request "P")
        q (create-test-project admin-request "Q")
        a (create-test-document admin-request p "Story")
        b (create-test-document admin-request p "Other")]
    (testing "a create under a taken name is refused, naming it"
      (let [r (create! p "Story")]
        (assert-status 422 r)
        (is (= "Story" (get-in r [:body :name-taken])))
        (is (str/includes? (get-in r [:body :error]) "“Story”"))))
    (testing "another project may use the name"
      (assert-created (create! q "Story")))
    (testing "the name is exact: a different case is another name"
      (assert-created (create! p "story")))
    (testing "a rename to a taken name is refused, and changes nothing"
      (let [r (rename! b "Story")]
        (assert-status 422 r)
        (is (= "Story" (get-in r [:body :name-taken])))
        (is (= ["Other" "Story" "story"] (names-in p)))))
    (testing "a rename to its own name, or a free one, goes through"
      (assert-ok (rename! a "Story"))
      (assert-ok (rename! b "Other tale")))
    (testing "free-name takes the first free name, and the answer says which"
      (let [r (create! p "Story" :free-name true)]
        (assert-created r)
        (is (= "Story (2)" (get-in r [:body :name]))))
      (is (= "Story (3)" (get-in (create! p "Story" :free-name true) [:body :name])))
      (is (= "Fresh" (get-in (create! p "Fresh" :free-name true) [:body :name]))
          "a free name is kept as it is"))
    (is (unique? p))))

(deftest copy-refuses-or-takes-the-first-free-name
  (let [p (create-test-project admin-request "P")
        a (create-test-document admin-request p "Story")
        _ (create-test-document admin-request p "Story (2)")]
    (testing "a copy under a taken name is refused"
      (let [r (copy! a "Story")]
        (assert-status 422 r)
        (is (= "Story" (get-in r [:body :name-taken])))))
    (testing "with free-name the copy takes the first free name and says so"
      (let [r (copy! a "Story" :free-name true)]
        (assert-created r)
        (is (= "Story (3)" (get-in r [:body :name])))))
    (testing "a free name asked for is the copy's name"
      (is (= "Copy" (get-in (copy! a "Copy") [:body :name]))))
    (is (unique? p))))

(deftest restore-keeps-the-current-name-when-the-old-one-is-taken
  (let [p (create-test-project admin-request "P")
        a (create-test-document admin-request p "Story")
        _ (assert-ok (rename! a "Story renamed"))
        t (latest-op-ts)
        _ (assert-ok (rename! a "Story later"))
        b (create-test-document admin-request p "Story renamed")]
    (assert-ok (restore! a t))
    (is (= "Story later" (:name (jdbc/execute-one! db ["SELECT name FROM documents WHERE id = ?" a]
                                                   {:builder-fn rs/as-unqualified-maps}))))
    (testing "with the name free again, a restore takes it back"
      (api-call admin-request {:method :delete :path (str "/api/v1/documents/" b)})
      (assert-ok (restore! a t))
      (is (= ["Story renamed"] (names-in p))))
    (is (unique? p))))

(defn- cfg [ds] {:store :database :migration-dir "migrations" :db {:datasource ds}})

(deftest the-migration-renames-shared-names-and-the-database-refuses-them-after
  (let [path (temp-db-path)
        ds (psd/build-datasource path)
        q (fn [sql & args] (jdbc/execute! ds (into [sql] args) {:builder-fn rs/as-unqualified-maps}))]
    (try
      (migratus/migrate-until-just-before (cfg ds) 20261016120000)
      (q "INSERT INTO projects (id, name) VALUES ('p1', 'P1'), ('p2', 'P2')")
      (doseq [[id p name created] [["d1" "p1" "A" "2026-01-02T00:00:00Z"]
                                   ["d2" "p1" "A" "2026-01-01T00:00:00Z"]
                                   ["d3" "p1" "A" "2026-01-03T00:00:00Z"]
                                   ["d4" "p1" "A (2)" "2026-01-04T00:00:00Z"]
                                   ["d5" "p1" "B" "2026-01-05T00:00:00Z"]
                                   ["d6" "p2" "A" "2026-01-06T00:00:00Z"]]]
        (q "INSERT INTO documents (id, name, project_id, version, created_at, modified_at) VALUES (?, ?, ?, 1, ?, ?)"
           id name p created created))
      (migratus/migrate (cfg ds))
      (let [by-id (into {} (map (juxt :id identity)) (q "SELECT * FROM documents"))]
        (testing "the oldest keeps the name, the others take the first free one"
          (is (= {"d1" "A (3)" "d2" "A" "d3" "A (4)" "d4" "A (2)" "d5" "B" "d6" "A"}
                 (update-vals by-id :name))))
        (testing "a renamed document's version moves, its modification time does not"
          (is (= 2 (:version (by-id "d1"))))
          (is (= "2026-01-02T00:00:00Z" (:modified_at (by-id "d1"))))
          (is (= 1 (:version (by-id "d2"))))))
      (testing "each rename is an operation with an audited post-image"
        (let [ops (q "SELECT * FROM operations WHERE op_type = 'document/update' ORDER BY ts")]
          (is (= #{"d1" "d3"} (set (map :document_id ops))))
          (is (every? #(nil? (:user_id %)) ops))
          (is (every? #(= "p1" (:project_id %)) ops))
          (is (= #{"A (3)" "A (4)"}
                 (set (for [w (q "SELECT post_image FROM audit_writes WHERE target_table = 'documents'")]
                        (second (re-find #"\"name\":\"([^\"]*)\"" (:post_image w)))))))))
      (testing "the database refuses a duplicate from then on"
        (is (thrown? Exception
                     (q "INSERT INTO documents (id, name, project_id, version, created_at, modified_at) VALUES ('d9', 'B', 'p1', 1, 'x', 'x')"))))
      (testing "down takes the index away"
        (migratus/rollback (cfg ds))
        (is (empty? (q "SELECT name FROM sqlite_master WHERE name = 'idx_documents_project_name_unique'"))))
      (finally
        (.close ds)
        (doseq [suffix ["" "-wal" "-shm"]]
          (.delete (java.io.File. (str path suffix))))))))
