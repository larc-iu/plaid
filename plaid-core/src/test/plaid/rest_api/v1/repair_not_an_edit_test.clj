(ns plaid.rest-api.v1.repair-not-an-edit-test
  "An app's repair on open (an operation group of kind `repair`) is not the
  opener's edit (H9-FIRST-OPEN-5): it is left out of their last edits, and
  the document's `modified_at`, which orders the document list, stays where
  it was. Its version still moves, so other clients learn of it."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-clean-db admin-request api-call assert-created]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))

(defn- doc-row [doc]
  (:body (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc)})))

(defn- last-edits [proj]
  (:body (api-call admin-request {:method :get :path (str "/api/v1/projects/" proj "/audit/last-edits")})))

(defn- patch-metadata [tok kind]
  (api-call admin-request
            {:method :patch
             :path (str "/api/v1/tokens/" tok "/metadata?group-id=" (psc/new-uuid)
                        "&group-message=Opened&group-kind=" kind)
             :body [{:op "set" :path ["morphType"] :value "stem"}]}))

(deftest a-repair-on-open-is-not-an-edit
  (let [proj (h/create-test-project admin-request "Repairs")
        doc (h/create-test-document admin-request proj "D")
        tl (id (h/create-text-layer admin-request proj "T"))
        wl (id (h/create-token-layer admin-request tl "Word"))
        text (id (h/create-text admin-request tl doc "word"))
        tok (let [r (h/create-token admin-request wl text 0 4)] (assert-created r) (id r))
        before (doc-row doc)
        edits (last-edits proj)]
    (Thread/sleep 5)
    (testing "a repair"
      (is (= 200 (:status (patch-metadata tok "repair"))))
      (let [after (doc-row doc)]
        (is (= (inc (:document/version before)) (:document/version after)) "the version moves")
        (is (= (:document/time-modified before) (:document/time-modified after)) "modified_at stays")
        (is (= edits (last-edits proj)) "no last edit")))
    (testing "an edit"
      (is (= 200 (:status (patch-metadata tok "bulk-edit"))))
      (let [after (doc-row doc)]
        (is (not= (:document/time-modified before) (:document/time-modified after)))
        (is (= 1 (count edits)))
        (is (not= edits (last-edits proj)))))))
