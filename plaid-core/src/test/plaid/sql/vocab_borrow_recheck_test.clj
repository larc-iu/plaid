(ns plaid.sql.vocab-borrow-recheck-test
  "A borrow and a move check their rights again inside their transaction
  (REV-VH-A-4). The route gates run before it, so a change committed between
  the gate and the write (the home deleted, a role taken away, a concurrent
  move) used to go unseen: B could borrow a vocabulary of a project being
  deleted, whose removal then deleted it with B's links, and the second of
  two moves ran against a home its caller was never checked on. Each case is
  made deterministic by committing the change and then calling the write as
  the request that passed the gate would."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db with-rest-handler
                                            with-admin with-test-users api-call admin-request]]
            [plaid.sql.common :as psc]
            [plaid.sql.project :as prj]
            [plaid.sql.vocab-layer :as vocab]
            [plaid.test-helpers :as h :refer [id]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private u1 "user1@example.com")
(def ^:private u2 "user2@example.com")

(defn- call [method path & [body]]
  (api-call admin-request (cond-> {:method method :path path} (some? body) (assoc :body body))))

(defn- grant! [pid role user] (fix/assert-no-content (call :post (str "/api/v1/projects/" pid "/" role "s/" user))))

(defn- world
  "A owns V, u1 maintains B and reads A."
  []
  (let [a (h/create-test-project admin-request "A")
        b (h/create-test-project admin-request "B")
        v (id (call :post "/api/v1/vocab-layers" {:name "V" :project-id a}))]
    (grant! b "maintainer" u1)
    (grant! a "reader" u1)
    {:a a :b b :v v}))

(defn- linked? [pid vid] (vocab/links? fix/db pid vid))

(defn- home [vid] (str (vocab/home-of fix/db vid)))

(deftest a-borrow-checks-again-in-its-transaction
  (testing "the home deleted after the gate: refused, nothing linked"
    (let [{:keys [a b v]} (world)]
      (is (true? (:success (prj/delete fix/db a "admin@example.com"))))
      (let [r (prj/add-vocab fix/db b v u1)]
        (is (false? (:success r)))
        (is (= 404 (:code r))))
      (is (not (linked? b v)))))
  (testing "the role on the home taken away after the gate: refused"
    (let [{:keys [a b v]} (world)]
      (fix/assert-no-content (call :delete (str "/api/v1/projects/" a "/readers/" u1)))
      (let [r (prj/add-vocab fix/db b v u1)]
        (is (= 403 (:code r)))
        (is (= "Linking a vocabulary needs access to the project it belongs to." (:error r))))
      (is (not (linked? b v)))))
  (testing "the borrowing project's maintainer role taken away after the gate: refused"
    (let [{:keys [b v]} (world)]
      (grant! b "maintainer" u2)
      (fix/assert-no-content (call :delete (str "/api/v1/projects/" b "/maintainers/" u1)))
      (is (= 403 (:code (prj/add-vocab fix/db b v u1))))
      (is (not (linked? b v)))))
  (testing "with every right still held, the borrow goes through"
    (let [{:keys [b v]} (world)]
      (is (true? (:success (prj/add-vocab fix/db b v u1))))
      (is (linked? b v)))))

(deftest a-move-checks-again-in-its-transaction
  (testing "the second of two moves, its caller never checked on the home the first gave it: refused"
    (let [{:keys [a v]} (world)
          d (h/create-test-project admin-request "D")
          e (h/create-test-project admin-request "E")]
      (grant! a "maintainer" u1) (grant! d "maintainer" u1)
      (grant! a "maintainer" u2) (grant! e "maintainer" u2)
      (is (true? (:success (vocab/move fix/db v e u2))) "the first move")
      (let [r (vocab/move fix/db v d u1)]
        (is (= 403 (:code r)))
        (is (= "Moving a vocabulary needs maintainer rights on both projects." (:error r))))
      (is (= (str e) (home v)))))
  (testing "the target deleted after the gate: refused"
    (let [{:keys [a v]} (world)
          d (h/create-test-project admin-request "D")]
      (grant! a "maintainer" u1) (grant! d "maintainer" u1)
      (is (true? (:success (prj/delete fix/db d "admin@example.com"))))
      (is (false? (:success (vocab/move fix/db v d u1))))
      (is (= (str a) (home v)))))
  (testing "an admin moves without a role on either project"
    (let [{:keys [v]} (world)
          d (h/create-test-project admin-request "D")]
      (is (true? (:success (vocab/move fix/db v d "admin@example.com"))))
      (is (= (str d) (home v))))))

(deftest the-routes-still-answer-as-before
  (let [{:keys [b v]} (world)]
    (is (= 204 (:status (call :post (str "/api/v1/projects/" b "/vocabs/" v)))))
    (is (some? (psc/q1 fix/db {:select [1] :from [:project_vocabs] :where [:and [:= :project_id b] [:= :vocab_layer_id v]]})))))
