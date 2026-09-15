(ns plaid.rest-api.v1.guideline-test
  "Tests for guidelines — a project's own annotation manual.

  Four properties carry the design and each gets its own section here:

    1. The ACL is the project's: readers read, writers write. Writers rather
       than maintainers is a deliberate choice, so a reader being refused is
       asserted on every write verb rather than on one of them.
    2. `title` is the HANDLE. It is unique within a project, a duplicate is a
       409 rather than a second indistinguishable row, and a rename into a
       taken title is the same 409.
    3. The list is the AGENT'S read: it pages, it is ordered by title, and it
       reports `body-chars` so a caller can budget before fetching bodies.
    4. Writes are AUDITED but not time-travelable. An operation row with a
       post-image exists for every write, and `?as-of=` is refused rather
       than quietly answered with today's data."
  (:require [clojure.string]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request user1-request user2-request
                                    api-call assert-status db rest-handler]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :refer [create-test-project
                                        add-project-reader add-project-writer]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ============================================================
;; Setup
;; ============================================================

(def ^:private user1 "user1@example.com")
(def ^:private user2 "user2@example.com")

(defn- create-guideline
  [req project-id attrs]
  (api-call req {:method :post
                 :path (str "/api/v1/projects/" project-id "/guidelines")
                 :body attrs}))

(defn- patch-guideline
  [req guideline-id attrs]
  (api-call req {:method :patch :path (str "/api/v1/guidelines/" guideline-id) :body attrs}))

(defn- delete-guideline
  [req guideline-id]
  (api-call req {:method :delete :path (str "/api/v1/guidelines/" guideline-id)}))

(defn- get-guideline
  [req guideline-id]
  (api-call req {:method :get :path (str "/api/v1/guidelines/" guideline-id)}))

(defn- query-string [query]
  (when (seq query)
    (str "?" (clojure.string/join "&" (map (fn [[k v]] (str (name k) "=" v)) query)))))

(defn- list-guidelines
  [req project-id & {:as query}]
  (api-call req {:method :get
                 :path (str "/api/v1/projects/" project-id "/guidelines" (query-string query))}))

(defn- status-of
  "Run a request and return ONLY its status. `api-call` slurps the response
  body, which blows up on reitit's coercion-failure responses (their body is
  a data map, not a stream), so a schema-level rejection has to go through
  here. Same reason as in comment-test."
  [req-fn method path body]
  (:status (rest-handler (cond-> (req-fn method path)
                           body (mock/json-body body)))))

(defn- made
  "Assert a create is 201 and return its id."
  [resp]
  (assert-status 201 resp)
  (-> resp :body :id))

(defn- setup-project
  "A project with user1 as a writer and user2 as a reader."
  [name]
  (let [proj (create-test-project admin-request name)]
    (add-project-writer admin-request proj user1)
    (add-project-reader admin-request proj user2)
    proj))

;; ============================================================
;; 1. The ACL is the project's
;; ============================================================

(deftest a-writer-may-author-and-a-reader-may-only-read
  (let [proj (setup-project "ACL")
        gid (made (create-guideline (partial user1-request) proj
                                    {:title "Glossing" :summary "How this project glosses."
                                     :body "Loanwords are **not** segmented."}))]
    (testing "a writer creates"
      (is (some? gid)))

    (testing "a reader reads the collection and the item"
      (assert-status 200 (list-guidelines (partial user2-request) proj))
      (let [resp (get-guideline (partial user2-request) proj)]
        ;; The item read is by guideline id, not project id.
        (is (= 403 (:status resp))))
      (let [resp (get-guideline (partial user2-request) gid)]
        (assert-status 200 resp)
        (is (= "Glossing" (-> resp :body :guideline/title)))
        (is (= "Loanwords are **not** segmented." (-> resp :body :guideline/body)))))

    (testing "a reader is refused on EVERY write verb, not just one"
      (is (= 403 (:status (create-guideline (partial user2-request) proj
                                            {:title "T" :summary "S"}))))
      (is (= 403 (:status (patch-guideline (partial user2-request) gid {:summary "changed"}))))
      (is (= 403 (:status (delete-guideline (partial user2-request) gid)))))

    (testing "the reader's refusals changed nothing"
      (is (= "How this project glosses." (-> (get-guideline (partial user1-request) gid) :body :guideline/summary))))))

(deftest a-non-member-cannot-see-that-a-guideline-exists
  (let [proj (create-test-project admin-request "Closed")
        gid (made (create-guideline admin-request proj {:title "Secret" :summary "Not yours."}))]
    (testing "a non-member gets 403 on read and on write, never a 404 that confirms the id"
      (is (= 403 (:status (list-guidelines (partial user1-request) proj))))
      (is (= 403 (:status (get-guideline (partial user1-request) gid))))
      (is (= 403 (:status (patch-guideline (partial user1-request) gid {:summary "x"})))))
    (testing "an id that does not exist is also 403 for a non-member, by the same fail-closed rule"
      (is (= 403 (:status (get-guideline (partial user1-request) (psc/new-uuid))))))))

(deftest a-guideline-that-does-not-exist-is-404-for-someone-who-could-have-read-it
  (let [proj (setup-project "Missing")]
    ;; An admin resolves no project for an unknown id, so the fail-closed
    ;; middleware cannot help them either. What matters is that a member who
    ;; asks for a real project's missing guideline is not told it is a
    ;; permissions problem.
    (is (= 404 (:status (get-guideline admin-request (psc/new-uuid)))))
    (is (= 200 (:status (list-guidelines (partial user1-request) proj))))))

;; ============================================================
;; 2. Title is the handle
;; ============================================================

(deftest a-duplicate-title-is-a-conflict-not-a-second-row
  (let [proj (setup-project "Titles")
        _ (made (create-guideline admin-request proj {:title "Glossing" :summary "First."}))
        dup (create-guideline admin-request proj {:title "Glossing" :summary "Second."})]
    (testing "the second create is a 409 naming the title"
      (is (= 409 (:status dup)))
      (is (clojure.string/includes? (-> dup :body :error) "Glossing")))
    (testing "only one row was written"
      (is (= 1 (count (-> (list-guidelines admin-request proj) :body :entries)))))))

(deftest the-same-title-in-a-different-project-is-fine
  (let [p1 (setup-project "P1")
        p2 (setup-project "P2")]
    (is (some? (made (create-guideline admin-request p1 {:title "Glossing" :summary "A."}))))
    (is (some? (made (create-guideline admin-request p2 {:title "Glossing" :summary "B."}))))))

(deftest renaming-into-a-taken-title-is-refused-but-renaming-to-its-own-is-not
  (let [proj (setup-project "Rename")
        a (made (create-guideline admin-request proj {:title "Alpha" :summary "A."}))
        _ (made (create-guideline admin-request proj {:title "Beta" :summary "B."}))]
    (testing "into a taken title: 409"
      (is (= 409 (:status (patch-guideline admin-request a {:title "Beta"})))))
    (testing "to the title it already has: fine, a guideline does not collide with itself"
      (assert-status 200 (patch-guideline admin-request a {:title "Alpha" :summary "A2."}))
      (is (= "A2." (-> (get-guideline admin-request a) :body :guideline/summary))))))

;; ============================================================
;; 3. The list is the agent's read
;; ============================================================

(deftest the-list-is-ordered-by-title-and-reports-body-size-without-the-body
  (let [proj (setup-project "Listing")]
    (made (create-guideline admin-request proj {:title "Zeta" :summary "Z." :body "xxxxx"}))
    (made (create-guideline admin-request proj {:title "Alpha" :summary "A." :body "xx"}))
    (made (create-guideline admin-request proj {:title "Mu" :summary "M."}))
    (let [entries (-> (list-guidelines admin-request proj) :body :entries)]
      (testing "ordered by title"
        (is (= ["Alpha" "Mu" "Zeta"] (mapv :guideline/title entries))))
      (testing "no body, but its length, so a caller can budget before fetching"
        (is (every? #(not (contains? % :guideline/body)) entries))
        (is (= [2 0 5] (mapv :guideline/body-chars entries))))
      (testing "pinned is on every entry, since grouping is the caller's job"
        (is (= [false false false] (mapv :guideline/pinned entries)))))
    (testing "include-bodies swaps the length for the Markdown"
      (let [entries (-> (list-guidelines admin-request proj :include-bodies true) :body :entries)]
        (is (= ["xx" "" "xxxxx"] (mapv :guideline/body entries)))
        (is (every? #(not (contains? % :guideline/body-chars)) entries))))))

(deftest the-list-pages-with-the-uniform-envelope
  (let [proj (setup-project "Paging")]
    (doseq [t ["A" "B" "C" "D" "E"]]
      (made (create-guideline admin-request proj {:title t :summary (str t ".")})))
    (let [page1 (-> (list-guidelines admin-request proj :limit 2) :body)
          cursor (:next-cursor page1)
          page2 (-> (list-guidelines admin-request proj :limit 2 :cursor cursor) :body)]
      (is (= ["A" "B"] (mapv :guideline/title (:entries page1))))
      (is (some? cursor))
      (is (= ["C" "D"] (mapv :guideline/title (:entries page2))))
      (let [page3 (-> (list-guidelines admin-request proj :limit 2 :cursor (:next-cursor page2)) :body)]
        (is (= ["E"] (mapv :guideline/title (:entries page3))))
        (is (nil? (:next-cursor page3)))))
    (testing "a garbage cursor is a clean 400"
      (is (= 400 (:status (list-guidelines admin-request proj :cursor "not-a-cursor")))))))

(deftest the-list-is-scoped-to-its-own-project
  (let [p1 (setup-project "Scoped1")
        p2 (setup-project "Scoped2")]
    (made (create-guideline admin-request p1 {:title "Mine" :summary "."}))
    (made (create-guideline admin-request p2 {:title "Theirs" :summary "."}))
    (is (= ["Mine"] (mapv :guideline/title (-> (list-guidelines admin-request p1) :body :entries))))))

;; ============================================================
;; Field rules
;; ============================================================

(deftest a-patch-leaves-out-what-it-does-not-name
  (let [proj (setup-project "Patch")
        gid (made (create-guideline admin-request proj
                                    {:title "Glossing" :summary "Original." :body "Body."}))]
    (assert-status 200 (patch-guideline admin-request gid {:body "New body."}))
    (let [g (-> (get-guideline admin-request gid) :body)]
      (is (= "Glossing" (:guideline/title g)))
      (is (= "Original." (:guideline/summary g)))
      (is (= "New body." (:guideline/body g))))))

(deftest pinned-round-trips-as-a-boolean
  (let [proj (setup-project "Pinned")
        gid (made (create-guideline admin-request proj {:title "T" :summary "S" :pinned true}))]
    (is (true? (-> (get-guideline admin-request gid) :body :guideline/pinned)))
    (assert-status 200 (patch-guideline admin-request gid {:pinned false}))
    (is (false? (-> (get-guideline admin-request gid) :body :guideline/pinned)))))

(deftest the-length-caps-are-four-hundreds-not-truncations
  (let [proj (setup-project "Caps")]
    (testing "title"
      (is (= 400 (:status (create-guideline admin-request proj
                                            {:title (apply str (repeat 101 "x")) :summary "S"})))))
    (testing "summary"
      (is (= 400 (:status (create-guideline admin-request proj
                                            {:title "T" :summary (apply str (repeat 201 "x"))})))))
    (testing "body"
      (is (= 400 (:status (create-guideline admin-request proj
                                            {:title "T" :summary "S"
                                             :body (apply str (repeat 20001 "x"))})))))
    (testing "a blank title or summary, which is a UI slip rather than a value"
      (is (= 400 (:status (create-guideline admin-request proj {:title "  " :summary "S"}))))
      (is (= 400 (:status (create-guideline admin-request proj {:title "T" :summary " "})))))
    (testing "nothing was stored by any of those"
      (is (empty? (-> (list-guidelines admin-request proj) :body :entries))))
    (testing "an empty body IS allowed: a guideline can be titled now and written later"
      (is (some? (made (create-guideline admin-request proj {:title "T" :summary "S" :body ""})))))))

(deftest a-missing-required-field-is-refused-at-coercion
  (let [proj (setup-project "Coercion")]
    (is (= 400 (status-of (partial admin-request) :post
                          (str "/api/v1/projects/" proj "/guidelines")
                          {:summary "No title."})))))

;; ============================================================
;; 4. Audited, but not time-travelable
;; ============================================================

(defn- ops-of [op-type]
  (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:operations] :where [:= :op_type op-type]})))

(defn- audit-rows []
  (psc/q db {:select [:change_type :post_image] :from [:audit_writes]
             :where [:= :target_table "guidelines"]}))

(deftest every-write-lands-in-the-audit-log-with-a-post-image
  (let [proj (setup-project "Audit")
        gid (made (create-guideline admin-request proj {:title "Glossing" :summary "S."}))]
    (is (= 1 (ops-of "guideline/create")))
    (assert-status 200 (patch-guideline admin-request gid {:summary "S2."}))
    (is (= 1 (ops-of "guideline/update")))
    (testing "the post-image carries what was written"
      (let [rows (audit-rows)]
        (is (= #{"insert" "update"} (set (map :change_type rows))))
        (is (some #(clojure.string/includes? (str (:post_image %)) "Glossing") rows))))
    (assert-status 204 (delete-guideline admin-request gid))
    (is (= 1 (ops-of "guideline/delete")))
    (is (contains? (set (map :change_type (audit-rows))) "delete"))))

(deftest restating-a-guideline-writes-no-audit-row
  (let [proj (setup-project "NoOp")
        gid (made (create-guideline admin-request proj {:title "T" :summary "S"}))
        before (count (audit-rows))]
    (assert-status 200 (patch-guideline admin-request gid {:title "T" :summary "S"}))
    (testing "a PATCH that changes nothing leaves the log alone, so updated-at cannot drift either"
      (is (= before (count (audit-rows)))))))

(deftest as-of-is-refused-rather-than-answered-with-todays-data
  (let [proj (setup-project "AsOf")
        gid (made (create-guideline admin-request proj {:title "T" :summary "S"}))
        ts (:ts (psc/q1 db {:select [:ts] :from [:operations] :order-by [[:ts :desc]] :limit 1}))]
    (is (= 400 (:status (api-call admin-request
                                  {:method :get
                                   :path (str "/api/v1/guidelines/" gid "?as-of=" ts)}))))
    (is (= 400 (:status (api-call admin-request
                                  {:method :get
                                   :path (str "/api/v1/projects/" proj "/guidelines?as-of=" ts)}))))))

(deftest deleting-the-project-takes-its-guidelines-with-it
  (let [proj (setup-project "Cascade")]
    (made (create-guideline admin-request proj {:title "T" :summary "S"}))
    (is (= 1 (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:guidelines]}))))
    (assert-status 204 (api-call admin-request {:method :delete :path (str "/api/v1/projects/" proj)}))
    (testing "gone by FK cascade, asked in SQL because there is no endpoint left to ask"
      (is (= 0 (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:guidelines]})))))))
