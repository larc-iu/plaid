(ns plaid.rest-api.v1.foreign-layer-id-answer-test
  "A token layer id of another text layer, which may be another project's,
  gets the answer an unknown id gets: as a nested layer's parent (ACL2-1)
  and as a same-ancestor constraint's token layer (ACL9-2). Before, the two
  messages told a real layer of an unreadable project from an unknown id."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    api-call assert-status]]
            [plaid.test-helpers :refer [create-test-project create-text-layer create-token-layer
                                        create-token-layer-opts create-span-layer create-relation-layer]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- same-but-id? [a b real unknown]
  (and (= (:status a) (:status b))
       (= (str/replace (str (:body a)) (str real) "ID") (str/replace (str (:body b)) (str unknown) "ID"))))

(deftest a-layer-of-another-text-layer-gets-the-unknown-ids-answer
  (let [p (create-test-project admin-request "P")
        p-tl (id (create-text-layer admin-request p "TL P"))
        p-sentences (id (create-token-layer admin-request p-tl "Sentences" "partitioning"))
        q (create-test-project user1-request "Q")
        q-tl (id (create-text-layer user1-request q "TL Q"))
        q-words (id (create-token-layer user1-request q-tl "Words"))
        q-rel (id (create-relation-layer user1-request (id (create-span-layer user1-request q-words "S")) "R"))
        unknown (random-uuid)]
    (assert-status 403 (api-call user1-request {:method :get :path (str "/api/v1/token-layers/" p-sentences)}))
    (testing "a nested token layer's parent"
      (let [a (create-token-layer-opts user1-request q-tl "Nested" {:parent-token-layer-id p-sentences})
            b (create-token-layer-opts user1-request q-tl "Nested" {:parent-token-layer-id unknown})]
        (assert-status 400 a)
        (is (same-but-id? a b p-sentences unknown) (pr-str a b))))
    (testing "a same-ancestor constraint's token layer"
      (let [check (fn [tl] (api-call user1-request {:method :post
                                                    :path (str "/api/v1/relation-layers/" q-rel "/constraints/check")
                                                    :body {:constraints [{:type "same-ancestor" :token-layer tl}]}}))
            a (check p-sentences)
            b (check unknown)]
        (assert-status 400 a)
        (is (same-but-id? a b p-sentences unknown) (pr-str a b))))))
