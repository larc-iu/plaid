(ns plaid.rest-api.v1.document-versions-cap-test
  "Past `document-versions-cap` documents a response leaves X-Document-Versions
  out and says so in X-Document-Versions-Omitted. The header grew about 43
  bytes a document with no limit, and a proxy, Node's fetch and Python's
  http.client each refuse a response whose header is too large, after the
  write has committed."
  (:require [clojure.test :refer :all]
            [clojure.data.json :as json]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler admin-request
                                    api-call assert-ok with-admin with-test-users with-clean-db]]
            [plaid.fixtures]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.sql.common]
            [plaid.sql.operation]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private cap prm/document-versions-cap)

(defn- setup
  "`n` documents of one project, each with one span. Returns the span ids
  and the document ids."
  [n]
  (let [proj (create-test-project admin-request "VersionsCap")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tkl (-> (create-token-layer admin-request tl "Tokens") :body :id)
        sl (-> (create-span-layer admin-request tkl "Spans") :body :id)]
    (vec (for [i (range n)]
           (let [doc (create-test-document admin-request proj (str "Doc " i))
                 tid (-> (create-text admin-request tl doc "ab") :body :id)
                 t (-> (create-token admin-request tkl tid 0 2) :body :id)]
             {:doc doc :span (-> (create-span admin-request sl [t] "A") :body :id)})))))

(defn- versions [response]
  (some-> (get-in response [:headers "X-Document-Versions"]) json/read-str))

(defn- omitted [response]
  (get-in response [:headers "X-Document-Versions-Omitted"]))

(deftest a-write-that-reaches-many-documents-leaves-the-list-out-and-says-so
  (let [docs (setup (inc cap))]
    (testing "at the cap the list is sent in full"
      (let [res (bulk-update-spans admin-request (mapv (fn [d] {:id (:span d) :value "B"}) (take cap docs)))]
        (assert-ok res)
        (is (= cap (count (versions res))))
        (is (nil? (omitted res)) "and no marker")))
    (testing "one past the cap the list is left out and the marker counts it"
      (let [res (bulk-update-spans admin-request (mapv (fn [d] {:id (:span d) :value "C"}) docs))]
        (assert-ok res)
        (is (nil? (versions res)) "no X-Document-Versions")
        (is (= (str (inc cap)) (omitted res)) "X-Document-Versions-Omitted is the number left out")
        (is (= "C" (-> (get-span admin-request (:span (last docs))) :body :span/value))
            "the write itself is committed")))))

(deftest a-batch-caps-its-merged-header-and-keeps-every-sub-response-list
  (let [docs (setup (inc cap))
        res (api-call admin-request
                      {:method :post
                       :path "/api/v1/batch"
                       :body (mapv (fn [d] {:path (str "/api/v1/spans/" (:span d))
                                            :method "patch"
                                            :body {:value "D"}})
                                   docs)})]
    (assert-ok res)
    (is (nil? (versions res)) "the merged header is left out")
    (is (= (str (inc cap)) (omitted res)))
    (testing "each sub-response in the body still names its own document's version"
      (let [sub (map #(some-> (get-in % [:headers "X-Document-Versions"]) json/read-str) (:body res))]
        (is (= (set (map (comp str :doc) docs))
               (set (mapcat keys sub))))
        (is (every? nil? (map #(get-in % [:headers "X-Document-Versions-Omitted"]) (:body res))))))))

(deftest a-small-batch-is-unchanged
  (let [docs (setup 2)
        res (api-call admin-request
                      {:method :post
                       :path "/api/v1/batch"
                       :body (mapv (fn [d] {:path (str "/api/v1/spans/" (:span d))
                                            :method "patch"
                                            :body {:value "E"}})
                                   docs)})]
    (assert-ok res)
    (is (= (set (map (comp str :doc) docs)) (set (keys (versions res)))))
    (is (nil? (omitted res)))))

(deftest the-version-named-is-the-one-this-write-left
  ;; Another writer can commit between this write's commit and its answer.
  ;; The answer names the version this write left, read in its own
  ;; transaction, so the client's next strict write is refused over the
  ;; change it never saw instead of going through.
  (doseq [[what write!] [["a single write" (fn [{:keys [span]}] (update-span admin-request span :value "B"))]
                         ["a bulk write" (fn [{:keys [span]}] (bulk-update-spans admin-request [{:id span :value "C"}]))]]]
    (testing what
      (let [[{:keys [doc] :as d}] (setup 1)
            before (plaid.sql.common/document-version plaid.fixtures/db doc)
            intruded (atom false)
            post-submit @#'plaid.sql.operation/post-submit!
            res (with-redefs [plaid.sql.operation/post-submit!
                              (fn [& args]
                                (apply post-submit args)
                                ;; A later writer commits before the answer is built.
                                (when (compare-and-set! intruded false true)
                                  (plaid.sql.common/execute! plaid.fixtures/db
                                                             {:update :documents :set {:version [:+ :version 1]}
                                                              :where [:= :id doc]})))]
                  (write! d))]
        (assert-ok res)
        (is @intruded)
        (is (= (+ 2 before) (plaid.sql.common/document-version plaid.fixtures/db doc)))
        (is (= {(str doc) (inc before)} (versions res)))))))
