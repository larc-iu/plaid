(ns plaid.sql.constraints.layer-rules-repair-test
  "The value-set exemption that follows a row through a document copy and a
  restore, a repair that joins only into a value the list being declared
  allows, a repair that leaves a document another holds the lock on, a
  writer's repair of the one document they open, the cost of a span create
  under a relation layer, and the whitespace a value-set trims."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.sql.constraints.layer :as lc]
            [plaid.sql.constraints.layer-test :refer [setup! all-words]]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request user1-request user2-request with-admin with-test-users
                                    api-call assert-status with-clean-db]]
            [plaid.test-helpers :refer [create-span create-relation add-project-writer add-project-reader]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- call [req method path & [body]]
  (api-call req (cond-> {:method method :path path} body (assoc :body body))))

(defn- declare! [kind layer ns constraints]
  (call admin-request :put (str "/api/v1/" kind "-layers/" layer "/constraints/" ns) {:constraints constraints}))

(defn- repair! [req layer constraints & [document]]
  (call req :post (str "/api/v1/span-layers/" layer "/constraints/repair")
        (cond-> {:constraints constraints} document (assoc :document document))))

(defn- span-value [sid] (some-> (psc/fetch-by-id db :spans sid) :value psc/read-json))

(defn- spans-on [token]
  (psc/q db {:select [:s.id :s.value] :from [[:span_tokens :st]]
             :join [[:spans :s] [:= :s.id :st.span_id]]
             :where [:= :st.token_id token]}))

(defn- latest-op-ts []
  (:ts (psc/q1 db {:select [:ts] :from [:operations] :order-by [[:ts :desc]] :limit 1})))

(defn- import-q []
  (str "?group-id=" (random-uuid) "&group-message=Import&group-kind=import"))

(defn- copy! [doc name]
  (let [r (call admin-request :post (str "/api/v1/documents/" doc "/copy") {:name name})]
    (is (< (:status r) 300) (pr-str (:body r)))
    r))

;; ============================================================
;; The import exemption follows the value through a copy and a restore
;; ============================================================

(deftest a-copy-and-a-restore-keep-an-imported-value
  (let [{:keys [lemma doc] :as s} (setup!)
        sid ((:span s) "cat")]
    (assert-status 200 (declare! "span" lemma "igt" [{:type "value-set" :values all-words}]))
    (assert-status 200 (call admin-request :patch (str "/api/v1/spans/" sid (import-q)) {:value "XYZ"}))
    (testing "a copy of the document is not refused for it"
      (let [r (copy! doc "D copy")
            copy-id (-> r :body :id str)]
        (is (= ["XYZ"] (->> (psc/q db {:select [:value] :from :spans
                                       :where [:and [:= :document_id copy-id] [:= :span_layer_id lemma]]})
                            (map (comp psc/read-json :value))
                            (filter #{"XYZ"}))))))
    (testing "a restore to before its deletion brings it back"
      (let [t (latest-op-ts)]
        (assert-status 204 (call admin-request :delete (str "/api/v1/spans/" sid)))
        (let [r (call admin-request :post (str "/api/v1/documents/" doc "/restore?as-of="
                                               (java.net.URLEncoder/encode (str t) "UTF-8")))]
          (is (< (:status r) 300) (pr-str (:body r))))
        (is (= "XYZ" (span-value sid)))))
    (testing "the restored value is still exempt when the list changes"
      (assert-status 200 (declare! "span" lemma "igt" [{:type "value-set" :values (conj all-words "dog")}])))
    (testing "a value no import wrote is still refused"
      (assert-status 422 (call admin-request :patch (str "/api/v1/spans/" ((:span s) "sat")) {:value "XYZ"})))))

(deftest a-copy-made-before-the-list-closed-is-exempt-at-declaration
  (let [{:keys [lemma doc] :as s} (setup!)]
    (assert-status 200 (call admin-request :patch (str "/api/v1/spans/" ((:span s) "cat") (import-q)) {:value "XYZ"}))
    (copy! doc "D copy")
    (let [r (declare! "span" lemma "igt" [{:type "value-set" :values all-words}])]
      (assert-status 200 r))))

;; ============================================================
;; Repair joins only into a value the list being declared allows
;; ============================================================

(deftest repair-joins-only-into-a-value-the-new-list-allows
  (let [{:keys [lemma tok] :as s} (setup!)
        cs [{:type "single-span"} {:type "value-set" :values all-words}]]
    ;; A second Lemma on "cat", stored while the layer declared nothing.
    (assert-status 201 (create-span admin-request lemma [(tok "cat")] "sat"))
    (let [r (repair! admin-request lemma cs)]
      (assert-status 200 r)
      (is (= 0 (-> r :body :violation-count)) (pr-str (:body r))))
    (let [left (spans-on (tok "cat"))]
      (is (= 1 (count left)))
      (is (contains? (set all-words) (psc/read-json (:value (first left))))
          "the kept span holds its own listed value, not the joined one"))
    (assert-status 200 (declare! "span" lemma "igt" cs))
    (is (some? s))))

;; ============================================================
;; Repair and the document lock
;; ============================================================

(defn- lock! [req doc]
  (let [r (call req :post (str "/api/v1/documents/" doc "/lock"))]
    (is (< (:status r) 300) (pr-str (:body r)))
    r))

(deftest repair-leaves-a-document-another-holds-the-lock-on
  (let [{:keys [lemma tok doc proj] :as s} (setup!)
        cs [{:type "single-span"}]]
    (add-project-writer admin-request proj "user1@example.com")
    (assert-status 201 (create-span admin-request lemma [(tok "cat")] "again"))
    (let [copy-id (-> (copy! doc "D copy") :body :id str)]
      (lock! user1-request doc)
      (let [r (repair! admin-request lemma cs)]
        (assert-status 200 r)
        (testing "the locked document is named and left as it was"
          (is (= [{:document (str doc) :locked-by "user1@example.com"}] (-> r :body :locked)))
          (is (= 2 (count (spans-on (tok "cat")))))
          (is (= 1 (-> r :body :violation-count)) "its violation is still listed"))
        (testing "the unlocked copy is repaired"
          (is (= [copy-id] (map :document (-> r :body :repaired))))))
      (testing "so the declaration is refused, and nothing is written inside the lock"
        (assert-status 422 (declare! "span" lemma "igt" cs))
        (is (empty? (psc/q db {:select [:id] :from :operations
                               :where [:and [:= :document_id doc]
                                       [:= :op_type "layer/repair-constraints"]]})))))
    (is (some? s))))

;; ============================================================
;; A writer repairs the document they open
;; ============================================================

(deftest a-writer-repairs-only-the-document-named
  (let [{:keys [lemma tok doc proj] :as s} (setup!)
        cs [{:type "single-span"}]]
    (add-project-writer admin-request proj "user1@example.com")
    (add-project-reader admin-request proj "user2@example.com")
    (assert-status 201 (create-span admin-request lemma [(tok "cat")] "again"))
    (let [copy-id (-> (copy! doc "D copy") :body :id str)]
      (testing "a writer may not repair the whole layer"
        (assert-status 403 (repair! user1-request lemma cs)))
      (testing "a reader may not repair a document"
        (assert-status 403 (repair! user2-request lemma cs doc)))
      (testing "a document of another layer's project is refused"
        (assert-status 400 (repair! user1-request lemma cs (str (random-uuid)))))
      (let [r (repair! user1-request lemma cs doc)]
        (assert-status 200 r)
        (is (= [(str doc)] (map :document (-> r :body :repaired))))
        (is (= 1 (count (spans-on (tok "cat")))))
        (testing "the other document is left, and the answer speaks only of this one"
          (is (= 0 (-> r :body :violation-count)))
          (is (= 2 (count (psc/q db {:select [:s.id] :from [[:spans :s]]
                                     :join [[:span_tokens :st] [:= :st.span_id :s.id]
                                            [:tokens :t] [:= :t.id :st.token_id]]
                                     :where [:and [:= :s.document_id copy-id] [:= :t.begin 4]]}))))))
      (testing "a writer's repair of a document under another's lock is left"
        (lock! admin-request copy-id)
        (let [r (repair! user1-request lemma cs copy-id)]
          (assert-status 200 r)
          (is (= [{:document copy-id :locked-by "admin@example.com"}] (-> r :body :locked)))
          (is (empty? (-> r :body :repaired))))))
    (is (some? s))))

;; ============================================================
;; A span create under a relation layer reads no whole document
;; ============================================================

(deftest a-span-create-reads-no-whole-document
  (let [{:keys [deps sl lemma tok sentence] :as s} (setup!)
        whole (atom 0)
        crossing @#'lc/crossing-in-sql]
    (assert-status 201 (call admin-request :post (str "/api/v1/tokens/" sentence "/split") {:position 13}))
    (assert-status 200 (declare! "relation" deps "ud" [{:type "same-ancestor" :token-layer sl}]))
    (let [cat-the (-> (create-relation admin-request deps ((:span s) "cat") ((:span s) "The") "det") :body :id str)]
      (with-redefs [lc/crossing-in-sql (fn [& args] (swap! whole inc) (apply crossing args))]
        (testing "a new span has no relations to cross anything"
          (assert-status 201 (create-span admin-request lemma [(tok "cat")] "again"))
          (is (= 0 @whole)))
        (testing "moving an existing span into the other sentence still removes its relation"
          (assert-status 200 (call admin-request :put (str "/api/v1/spans/" ((:span s) "The") "/tokens")
                                   {:tokens [(tok "Dogs")]}))
          (is (nil? (psc/fetch-by-id db :relations cat-the)))
          (is (= 0 @whole) "only the moved span's relations were read"))))))

;; ============================================================
;; The whitespace a value-set trims, shared with both clients
;; ============================================================

(def ^:private cases
  (json/read-str (slurp (io/file "src/test/plaid/sql/constraints/value_set_cases.json"))))

(deftest value-set-trims-what-javascript-trims
  (doseq [{:strs [constraint value allowed]} (get cases "cases")]
    (is (= allowed (lc/value-allowed? (get-in cases ["constraints" constraint]) value))
        (str constraint " " (pr-str value)))))
