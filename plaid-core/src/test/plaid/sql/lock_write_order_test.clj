(ns plaid.sql.lock-write-order-test
  "A document lock and a write to the same document are ordered by the SQLite
  write lock. A write either commits before the acquire answers, so the
  holder's first read sees it, or opens its transaction after, and is refused
  with a 423.

  Each case parks one side inside or in front of a transaction and lets the
  other act, the way a long body save and a service's acquire meet."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-rest-handler admin-request
                                            api-call assert-ok assert-no-content with-admin
                                            with-test-users user1-request with-clean-db]]
            [plaid.server.locks :as locks]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd]
            [plaid.sql.operation :as op]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- setup [name]
  (let [proj (create-test-project admin-request name)
        doc (create-test-document admin-request proj "Doc")]
    (assert-no-content (add-project-writer admin-request proj "user1@example.com"))
    (assert-no-content (add-project-writer admin-request proj "user2@example.com"))
    {:project proj :doc doc}))

(defn- write-as
  "A write to `doc` by `user`, through `submit-operation*`. `body` runs inside
  the transaction."
  [{:keys [project doc]} user body]
  (op/submit-operation* fix/db {:type :document/update
                                :description "test write"
                                :project project
                                :document doc
                                :user user}
                        (fn [_tx] (body))))

(defn- lock! [doc]
  (api-call user1-request {:method :post
                           :path (str "/api/v1/documents/" doc "/lock")}))

(deftest an-acquire-waits-for-a-write-already-in-its-transaction
  ;; The write has passed its lock check and is writing. An acquire that did
  ;; not wait answered 200 at once, the holder read the document without the
  ;; write, and the write then committed under the lock.
  (let [{:keys [doc] :as s} (setup "LockWaitsProj")
        v0 (psc/document-version fix/db doc)
        entered (promise)
        go (promise)
        write (future (write-as s "user2@example.com" (fn [] (deliver entered true) @go :written)))]
    (is (true? (deref entered 5000 false)) "the write is inside its transaction")
    (let [acquire (future (lock! doc))]
      (Thread/sleep 500)
      (is (not (realized? acquire)) "the acquire waits for the write to commit")
      (deliver go true)
      (is (true? (:success (deref write 5000 nil))) "the write commits")
      (let [r (deref acquire 5000 nil)]
        (assert-ok r)
        (is (= (inc v0) (psc/document-version fix/db doc))
            "the holder's first read already has the write")
        (locks/release-lock! doc "user1@example.com" (-> r :body :lock-id))))))

(deftest a-write-that-opens-its-transaction-after-the-acquire-is-refused
  ;; The write reached the write lock only after the document was locked. A
  ;; lock check made before the transaction passed while the write waited,
  ;; and the write then committed under a holder who had read the document
  ;; without it.
  (let [{:keys [doc] :as s} (setup "LockCheckInTxProj")
        v0 (psc/document-version fix/db doc)
        held (promise)
        release (promise)
        other-tx (future (psd/with-tx [_tx fix/db] (deliver held true) @release))
        ran (atom false)]
    (is (true? (deref held 5000 false)) "another transaction holds the write lock")
    (let [write (future (write-as s "user2@example.com" (fn [] (reset! ran true) :written)))]
      (Thread/sleep 500)
      (is (not (realized? write)) "the write waits for the write lock")
      (is (= :acquired (locks/acquire-lock! doc "user1@example.com" "holder"))
          "user1 takes the lock while the write waits")
      (deliver release true)
      @other-tx
      (let [r (deref write 5000 nil)]
        (is (= 423 (:code r)) "the write is refused once it holds the write lock")
        (is (false? @ran) "its body never ran")
        (is (= v0 (psc/document-version fix/db doc)) "nothing was written")))
    (locks/release-lock! doc "user1@example.com" "holder")))

(deftest a-write-by-the-holder-still-passes-inside-its-transaction
  (let [{:keys [doc] :as s} (setup "LockHolderInTxProj")]
    (is (= :acquired (locks/acquire-lock! doc "user1@example.com" "holder")))
    (is (true? (:success (write-as s "user1@example.com" (constantly :written)))))
    (is (= 423 (:code (write-as s "user2@example.com" (constantly :written)))))
    (locks/release-lock! doc "user1@example.com" "holder")))
