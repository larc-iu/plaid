(ns plaid.rest-api.v1.project-removal-test
  "A project delete hides the project in one short step and removes what it
  holds a document at a time (`plaid.server.project-removal`), so saves
  elsewhere are never held up behind it. A hidden project must be gone
  everywhere at once, on every route, for admins too, and a removal cut short
  must be taken up again."
  (:require [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.fixtures :as f :refer [with-db with-mount-states with-rest-handler admin-request
                                          user1-request api-call assert-success assert-no-content
                                          with-admin with-test-users with-clean-db]]
            [plaid.server.project-removal :as removal]
            [plaid.sql.datasource :as psd]
            [plaid.history.read :as hread]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.sql.project :as prj]
            [plaid.sql.span :as span]
            [plaid.sql.text-layer :as txl]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))

(defn- setup
  "A project user1 writes in, with `n` documents of one text, two tokens, a
  span on each token, a relation and a document metadata key."
  [n]
  (let [proj (create-test-project admin-request "Doomed")
        _ (assert-success (add-project-writer admin-request proj "user1@example.com"))
        tl (id (create-text-layer admin-request proj "TL"))
        tkl (id (create-token-layer admin-request tl "Tokens"))
        sl (id (create-span-layer admin-request tkl "Spans"))
        rl (id (create-relation-layer admin-request sl "Rels"))
        docs (vec (for [i (range n)]
                    (let [doc (create-test-document admin-request proj (str "Doc " i))
                          text (id (create-text admin-request tl doc "ab cd"))
                          t1 (id (create-token admin-request tkl text 0 2))
                          t2 (id (create-token admin-request tkl text 3 5))
                          s1 (id (create-span admin-request sl [t1] "A"))
                          s2 (id (create-span admin-request sl [t2] "B"))]
                      (create-relation admin-request rl s1 s2 "dep")
                      (update-document-metadata admin-request doc {"genre" "news"})
                      {:doc doc :text text :token t1 :span s1})))]
    {:proj proj :tl tl :tkl tkl :sl sl :docs docs}))

(defn- hide!
  "The delete's first step alone: the project is marked, nothing under it is
  removed yet. This is the state every guard below has to hold in."
  [proj]
  (let [r (prj/delete f/db proj "admin@example.com")]
    (is (:success r) (pr-str r))))

(defn- rows [sql & params]
  (:n (jdbc/execute-one! f/db (into [(str "SELECT COUNT(*) AS n " sql)] params))))

(defn- left-of
  "How many rows of project `proj` are left, table by table."
  [proj]
  {:projects (rows "FROM projects WHERE id = ?" proj)
   :documents (rows "FROM documents WHERE project_id = ?" proj)
   :texts (rows "FROM texts t JOIN documents d ON d.id = t.document_id WHERE d.project_id = ?" proj)
   :text-layers (rows "FROM text_layers WHERE project_id = ?" proj)
   :roles (rows "FROM project_users WHERE project_id = ?" proj)})

(deftest a-hidden-project-is-gone-on-every-route
  (let [{:keys [proj docs tkl sl]} (setup 1)
        {:keys [doc text token span]} (first docs)
        now (str (java.time.Instant/now))]
    (hide! proj)
    (testing "it is out of every project list"
      (is (not-any? #(= (str proj) (str (:project/id %)))
                    (-> (api-call admin-request {:method :get :path "/api/v1/projects"}) :body :entries)))
      (is (not-any? #(= (str proj) (str (:project/id %)))
                    (-> (api-call user1-request {:method :get :path "/api/v1/projects"}) :body :entries))))
    (testing "every route into it is refused: 404 to an admin, 403 to its former writer"
      (doseq [[label req] [["the project" {:method :get :path (str "/api/v1/projects/" proj)}]
                           ["its documents" {:method :get :path (str "/api/v1/projects/" proj "/documents")}]
                           ["its activity" {:method :get :path (str "/api/v1/projects/" proj "/audit")}]
                           ["a document" {:method :get :path (str "/api/v1/documents/" doc)}]
                           ["a document's body" {:method :get :path (str "/api/v1/documents/" doc "?include-body=true")}]
                           ["a document in the past" {:method :get :path (str "/api/v1/documents/" doc "?include-body=true&as-of=" now)}]
                           ["a document's history" {:method :get :path (str "/api/v1/documents/" doc "/audit")}]
                           ["a text" {:method :get :path (str "/api/v1/texts/" text)}]
                           ["a token" {:method :get :path (str "/api/v1/tokens/" token)}]
                           ["a span" {:method :get :path (str "/api/v1/spans/" span)}]
                           ["a span edit" {:method :patch :path (str "/api/v1/spans/" span) :body {:value "Z"}}]
                           ["a new span" {:method :post :path "/api/v1/spans" :body {:span-layer-id sl :tokens [token] :value "Q"}}]
                           ["a new token" {:method :post :path "/api/v1/tokens" :body {:token-layer-id tkl :text text :begin 0 :end 1}}]
                           ["a new document" {:method :post :path "/api/v1/documents" :body {:project-id proj :name "Late"}}]
                           ["a rename" {:method :patch :path (str "/api/v1/projects/" proj) :body {:name "Revived"}}]
                           ["a second delete" {:method :delete :path (str "/api/v1/projects/" proj)}]]]
        (testing label
          (is (= 404 (:status (api-call admin-request req))) "admin")
          (is (= 403 (:status (api-call user1-request req))) "former writer"))))
    (testing "a batch carrying a route into it is refused"
      (let [r (api-call admin-request {:method :post :path "/api/v1/batch"
                                       :body [{:path (str "/api/v1/spans/" span) :method "patch" :body {:value "Z"}}]})]
        (is (= 404 (:status r)))))
    (testing "nothing was written"
      (is (= 1 (rows "FROM spans WHERE id = ? AND value = '\"A\"'" span)))
      (is (= 1 (rows "FROM documents WHERE project_id = ?" proj))))
    (testing "the query language cannot reach it"
      (let [scoped (api-call admin-request {:method :post :path "/api/v1/query"
                                            :body {:scope {:project-ids [proj]}
                                                   :find ["?t"] :where [["token" "?t" {}]]}})
            unscoped (api-call admin-request {:method :post :path "/api/v1/query"
                                              :body {:find ["?t"] :where [["token" "?t" {}]]}})]
        (is (= 400 (:status scoped)))
        (is (not-any? #(= (str token) (str (first %))) (-> unscoped :body :results)))))
    (testing "its roles are gone, so nothing reached through membership leads in"
      (is (zero? (:roles (left-of proj)))))))

(deftest a-rest-delete-removes-everything-under-the-project
  (let [{:keys [proj docs]} (setup 3)
        doc-ids (mapv :doc docs)]
    (assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/projects/" proj)}))
    (is (= {:projects 0 :documents 0 :texts 0 :text-layers 0 :roles 0} (left-of proj)))
    (is (zero? (rows (str "FROM entity_metadata WHERE entity_id IN ("
                          (clojure.string/join "," (repeat (count doc-ids) "?")) ")")
                     (map str doc-ids)))
        "the documents' metadata goes with them")
    (is (zero? (rows "FROM tokens t JOIN token_layers l ON l.id = t.token_layer_id WHERE l.project_id = ?" proj)))
    (is (= 1 (rows "FROM audit_writes a JOIN operations o ON o.id = a.op_id WHERE o.project_id = ? AND o.op_type = 'project/delete'" proj))
        "one audit row for the whole delete, as before")))

(deftest a-removal-cut-short-is-taken-up-again
  (let [{:keys [proj]} (setup 3)]
    (hide! proj)
    (is (some? (prj/remove-hidden-document! f/db proj)) "one document removed, then the server stops")
    (is (= 2 (:documents (left-of proj))))
    (is (= [(str proj)] (mapv str (prj/hidden-ids f/db))) "the mark survives, so startup finds it")
    (removal/resume! f/db)
    (is (= {:projects 0 :documents 0 :texts 0 :text-layers 0 :roles 0} (left-of proj)))
    (is (empty? (prj/hidden-ids f/db)))))

(deftest removal-steps-leave-a-project-that-is-not-being-deleted-alone
  (let [{:keys [proj]} (setup 1)]
    (is (nil? (prj/remove-hidden-document! f/db proj)))
    (is (nil? (prj/remove-hidden-project! f/db proj)))
    (is (= 1 (:documents (left-of proj))))
    (is (false? (prj/hidden? f/db proj)))
    (is (false? (prj/hidden? f/db (str (java.util.UUID/randomUUID)))))))

;; The point of the whole change. One transaction for the project held the
;; write lock for the whole cascade (18 s for 400 documents), so a save in any
;; other project waited that long. Checked STRUCTURALLY, as the planner-stats
;; test is: a write with a short busy_timeout that gets through while the
;; project is partly removed got the lock between two of the removal's
;; transactions, which one transaction for the project can never allow.
(deftest a-save-elsewhere-gets-in-between-two-documents-of-the-removal
  (let [n 12
        {:keys [proj]} (setup n)
        writer (psd/build-datasource @#'f/shared-db-file {:busy-timeout-ms 100})]
    (jdbc/execute! f/db ["CREATE TABLE IF NOT EXISTS removal_probe (id INTEGER PRIMARY KEY, x TEXT)"])
    (try
      (hide! proj)
      (reset! removal/background? true)
      (let [done (promise)
            _ (future (try (removal/remove-project! f/db proj) (finally (deliver done true))))
            deadline (+ (System/currentTimeMillis) 60000)
            [refused seen] (loop [refused 0 seen #{}]
                             (if (or (realized? done) (> (System/currentTimeMillis) deadline))
                               [refused seen]
                               (let [ok? (try (jdbc/execute! writer ["INSERT INTO removal_probe (x) VALUES ('w')"]) true
                                              (catch Exception _ false))
                                     left (when ok? (rows "FROM documents WHERE project_id = ?" proj))]
                                 (Thread/sleep 5)
                                 (recur (if ok? refused (inc refused)) (cond-> seen left (conj left))))))]
        (is (realized? done) "the removal finished")
        (is (zero? refused) "no save elsewhere waited past a 100 ms busy timeout")
        (is (some #(< 0 % n) seen)
            (str "a save got in while the project was part removed " (sort seen)))
        (is (= 0 (:documents (left-of proj)))))
      (finally
        (reset! removal/background? false)
        (jdbc/execute! f/db ["DROP TABLE IF EXISTS removal_probe"])
        (.close writer)))))

;; A write checks its route gate BEFORE it opens its transaction. One that
;; passed the gate while the project was live, and got the write lock only
;; after the delete's short step committed, would land in a hidden project:
;; a document created after the removal has passed its last document keeps
;; the project row from ever being removed. The transaction itself refuses it.
(deftest a-write-that-passed-the-gate-before-the-hide-is-refused-in-its-transaction
  (let [{:keys [proj tl docs]} (setup 1)
        {:keys [span]} (first docs)]
    (hide! proj)
    (testing "a new document"
      (let [r (doc/create f/db {:document/name "Late" :document/project proj} "user1@example.com")]
        (is (= 404 (:code r)) (pr-str r))))
    (testing "an edit of a span"
      (let [r (span/merge f/db span {:span/value "Z"} "user1@example.com")]
        (is (= 404 (:code r)) (pr-str r))))
    (testing "a new layer"
      (let [r (txl/create f/db {:text-layer/name "Late"} proj "user1@example.com")]
        (is (= 404 (:code r)) (pr-str r))))
    (is (= 1 (:documents (left-of proj))) "nothing was written")
    (is (= 1 (rows "FROM spans WHERE id = ? AND value = '\"A\"'" span)))
    (is (= 1 (rows "FROM text_layers WHERE project_id = ?" proj)))
    (is (some? tl))))

;; An as-of read goes through the route gate first, which refuses a hidden
;; project. The history reader refuses it on its own as well, as it refuses a
;; removed one, so a caller that skips the gate cannot time-travel into it.
(deftest a-hidden-project-is-not-time-travelable
  (let [{:keys [proj docs]} (setup 1)
        {:keys [doc]} (first docs)
        now (psc/now-iso)]
    (is (some? (hread/get-at f/db doc now)) "readable while the project is live")
    (hide! proj)
    (is (nil? (hread/get-at f/db doc now)))
    (is (false? (hread/exists-at? f/db doc now)))))
