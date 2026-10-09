(ns plaid.rest-api.v1.repair-not-an-edit-test
  "An app's repair on open (an operation group of kind `repair`) is not the
  opener's edit (H9-FIRST-OPEN-5): it is left out of their last edits, and
  the document's `modified_at`, which orders the document list, stays where
  it was. Its version still moves, so other clients learn of it. A
  conversion of stored data run through the API under one account is a
  repair too, and nobody's edit (Luke's ruling, 2026-10-09): left out of the
  last edits and the activity tally, still in the audit log by its kind."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    api-call assert-created]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
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

(defn- repair-span! [span value]
  (api-call admin-request
            {:method :patch
             :path (str "/api/v1/spans/" span "?group-id=" (psc/new-uuid)
                        "&group-message=Stored+text+composed&group-kind=repair")
             :body {:value value}}))

(defn- tally-of [proj opts]
  (into {} (map (juxt (comp :user/id :user) identity))
        (:entries (:body (h/get-audit-tally admin-request proj opts)))))

(deftest a-conversion-run-as-one-account-is-nobodys-activity
  (let [proj (h/create-test-project admin-request "Conversion")
        _ (h/add-project-writer admin-request proj "user1@example.com")
        doc (h/create-test-document admin-request proj "D")
        tl (id (h/create-text-layer admin-request proj "T"))
        wl (id (h/create-token-layer admin-request tl "Word"))
        sl (id (h/create-span-layer admin-request wl "Gloss"))
        text (id (h/create-text admin-request tl doc "dom"))
        tok (id (h/create-token admin-request wl text 0 3))
        span (let [r (h/create-span admin-request sl [tok] "x")] (assert-created r) (id r))
        _ (Thread/sleep 5)
        cutoff (java.time.Instant/now)
        _ (Thread/sleep 5)
        _ (is (= 200 (:status (h/update-span user1-request span :value "house"))))
        edits (last-edits proj)
        b-before (get (tally-of proj {:start-time cutoff}) "user1@example.com")]
    (Thread/sleep 5)
    (is (= 200 (:status (repair-span! span "HOUSE"))))
    (testing "the project tally counts only the person's edit"
      (let [t (tally-of proj {:start-time cutoff :daily true})]
        (is (= #{"user1@example.com"} (set (keys t))))
        (is (= (:changes b-before) (:changes (get t "user1@example.com"))))
        (is (= (:last-ts b-before) (:last-ts (get t "user1@example.com"))))))
    (testing "and the instance tally the same"
      (is (= #{"user1@example.com"} (set (keys (tally-of nil {:start-time cutoff}))))))
    (testing "the runner's last edits do not move"
      (is (= edits (last-edits proj))))
    (testing "a rename in a repair leaves the document's time-modified"
      (let [before (doc-row doc)
            r (api-call admin-request
                        {:method :patch
                         :path (str "/api/v1/documents/" doc "?group-id=" (psc/new-uuid)
                                    "&group-message=Stored+text+composed&group-kind=repair")
                         :body {:name "D2"}})]
        (is (= 200 (:status r)))
        (is (= "D2" (:document/name (doc-row doc))))
        (is (= (:document/time-modified before) (:document/time-modified (doc-row doc))))
        (is (= (inc (:document/version before)) (:document/version (doc-row doc))))))
    (testing "the conversion is still in the audit log, by its kind"
      (let [entries (:entries (:body (h/get-project-audit admin-request proj {:start-time cutoff})))]
        (is (= ["repair" "repair"] (keep :audit/kind entries)))
        (is (= #{"admin@example.com" "user1@example.com"}
               (set (map (comp :user/id :audit/user) entries))))))))
