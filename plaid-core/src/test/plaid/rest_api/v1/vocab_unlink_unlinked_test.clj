(ns plaid.rest-api.v1.vocab-unlink-unlinked-test
  "Unlinking a vocabulary a project does not link is refused before anything
  is written or named, with one answer whether or not the vocabulary exists
  (ACL4-1, ACL5-3, ACL10-3, and the vocabulary half of ACL5-1, ACL9-2 and
  ACL10-4). Before, any maintainer of any project got 204, their project's
  History named the vocabulary, and the vocabulary's home got an
  'Unlink vocabulary' entry by someone with no role there. The status also
  told a real vocabulary id from an unknown one."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    user2-request api-call assert-status]]
            [plaid.rest-api.v1.job-helpers :as jh]
            [plaid.test-helpers :refer [create-test-project create-vocab-layer get-project-audit]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- grant! [project role email]
  (assert-status 204 (api-call admin-request {:method :post
                                              :path (str "/api/v1/projects/" project "/" role "/" email)})))

(defn- unlink [who project vocab]
  (api-call who {:method :delete :path (str "/api/v1/projects/" project "/vocabs/" vocab)}))

(defn- preview [who project vocab]
  (api-call who {:method :get :path (str "/api/v1/projects/" project "/vocabs/" vocab "/unlinking")}))

(defn- unlink-ops [who project]
  (->> (:entries (:body (get-project-audit who project)))
       (mapcat :audit/ops)
       (filter #(#{:project/remove-vocab :vocab/unlink} (:op/type %)))))

(defn- vocab-unlink-ops [vocab]
  (->> (:entries (:body (api-call admin-request {:method :get :path (str "/api/v1/vocab-layers/" vocab "/audit")})))
       (mapcat :audit/ops)
       (filter #(= :vocab/unlink (:op/type %)))))

(defn- same-answer?
  "The two refusals differ only in the id each names."
  [a b real unknown]
  (and (= (:status a) (:status b))
       (= (str/replace (str (:body a)) (str real) "ID") (str/replace (str (:body b)) (str unknown) "ID"))))

(deftest unlinking-a-vocabulary-the-project-does-not-link-is-refused-and-writes-nothing
  (let [r (create-test-project admin-request "R home")
        q (create-test-project admin-request "Q borrower")
        p (create-test-project admin-request "P home")
        _ (grant! q "maintainers" "user1@example.com")
        _ (grant! r "maintainers" "user2@example.com")
        _ (grant! p "readers" "user1@example.com")
        w (id (create-vocab-layer admin-request r "R secret lexicon name"))
        v (id (create-vocab-layer admin-request p "P lexicon"))
        _ (assert-status 204 (api-call admin-request {:method :post :path (str "/api/v1/projects/" q "/vocabs/" v)}))
        unknown (random-uuid)
        qr (jh/user! "qreader@example.com")
        _ (grant! q "readers" "qreader@example.com")]
    (testing "Q's maintainer, who has no role in W's home, cannot read W"
      (assert-status 403 (api-call user1-request {:method :get :path (str "/api/v1/vocab-layers/" w)})))
    (doseq [[label who] [["Q's maintainer" user1-request] ["the admin" admin-request]]]
      (testing (str label ": W, which Q never linked, and an unknown id get one answer, and nothing is written")
        (let [a (unlink who q w) b (unlink who q unknown)]
          (assert-status 400 a)
          (is (same-answer? a b w unknown) (pr-str a b)))
        (let [a (preview who q w) b (preview who q unknown)]
          (assert-status 400 a)
          (is (same-answer? a b w unknown) (pr-str a b)))))
    (testing "Q's reader is refused by the gate"
      (assert-status 403 (unlink qr q w))
      (assert-status 403 (preview qr q w)))
    (testing "no History anywhere names an unlink"
      (is (empty? (unlink-ops admin-request q)))
      (is (empty? (unlink-ops admin-request r)))
      (is (empty? (vocab-unlink-ops w))))
    (testing "a maintainer of a project they just made cannot unlink W from it either"
      (let [g (create-test-project user1-request "G")]
        (assert-status 400 (unlink user1-request g w))
        (is (empty? (unlink-ops admin-request g)))
        (is (empty? (vocab-unlink-ops w)))))
    (testing "the home still refuses its own vocabulary with 409"
      (assert-status 409 (unlink user2-request r w))
      (assert-status 409 (preview user2-request r w)))
    (testing "the unlink of a vocabulary Q does borrow still works, and is named"
      (assert-status 200 (preview user1-request q v))
      (assert-status 204 (unlink user1-request q v))
      (is (seq (unlink-ops user1-request q)))
      (is (seq (vocab-unlink-ops v))))))
