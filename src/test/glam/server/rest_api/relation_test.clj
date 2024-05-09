(ns glam.server.rest-api.relation-test
  (:require [clojure.test :refer :all]
            [clojure.string]
            [ring.mock.request :as mock]
            [glam.xtdb.easy :as gxe]
            [glam.server.rest-api.fixtures :refer [with-user-cookies
                                                   admin-req user-req
                                                   admin-id user-id
                                                   project-ids with-project-and-doc]]
            [glam.fixtures :refer [xtdb-node
                                   with-xtdb
                                   with-parser
                                   with-rest-handler
                                   rest-handler]]))

;; Get a fresh system set up for each test that only has two registered users
(use-fixtures :each with-xtdb with-parser with-rest-handler with-user-cookies with-project-and-doc)


(deftest relation
  (let [{:keys [document-id other-span-layer-id span-layer-id relation-layer-id
                s1-id s2-id s3-id other-s1-id r1-id r2-id
                d2-s1-id]} project-ids]
    ;; Get document lock
    (rest-handler (-> (admin-req :patch (str "/rest-api/v1/document/" document-id "/lock"))
                      (mock/json-body {:action "acquire"})))

    (testing "Relations can be created and deleted"
      (let [req (-> (admin-req :post "/rest-api/v1/document/body/relation")
                    (mock/json-body {:layer relation-layer-id :source s1-id :target s2-id :value "foo"}))
            {:keys [status body]} (rest-handler req)
            new-id (-> body slurp read-string :id)]
        (is (= 200 status))
        (is (some? (:relation/id (gxe/entity xtdb-node new-id))))
        (let [req (-> (admin-req :delete (str "/rest-api/v1/document/body/relation/" new-id)))
              {:keys [status body]} (rest-handler req)]
          (is (= 200 status))
          (is (nil? (:relation/id (gxe/entity xtdb-node new-id)))))))

    (testing "Relation creation fails with bad layer"
      (let [req (-> (admin-req :post "/rest-api/v1/document/body/relation")
                    (mock/json-body {:layer span-layer-id :source s1-id :target s2-id :value "foo"}))
            {:keys [status body]} (rest-handler req)]
        (is (= 400 status))))

    (testing "Relation creation fails with bad value"
      (let [req (-> (admin-req :post "/rest-api/v1/document/body/relation")
                    (mock/json-body {:layer relation-layer-id :source s1-id :target s2-id :value true}))
            {:keys [status body]} (rest-handler req)]
        (is (= 400 status))))

    (testing "Relation creation fails with bad source"
      (let [req (-> (admin-req :post "/rest-api/v1/document/body/relation")
                    (mock/json-body {:layer relation-layer-id :source r1-id :target s2-id :value "foo"}))
            {:keys [status body]} (rest-handler req)]
        (is (= 400 status))))

    (testing "Relation creation fails with bad target"
      (let [req (-> (admin-req :post "/rest-api/v1/document/body/relation")
                    (mock/json-body {:layer relation-layer-id :source s1-id :target r2-id :value "foo"}))
            {:keys [status body]} (rest-handler req)]
        (is (= 400 status))))

    (testing "Relation creation fails with spans in different layers"
      (let [req (-> (admin-req :post "/rest-api/v1/document/body/relation")
                    (mock/json-body {:layer relation-layer-id :source s1-id :target other-s1-id :value "foo"}))
            {:keys [status body]} (rest-handler req)]
        (is (= 400 status))))

    (testing "Relation creation fails with spans in different documents"
      (let [req (-> (admin-req :post "/rest-api/v1/document/body/relation")
                    (mock/json-body {:layer relation-layer-id :source s1-id :target d2-s1-id :value "foo"}))
            {:keys [status body]} (rest-handler req)]
        (is (= 400 status))))

    (testing "Getting a relation works"
      (let [req (admin-req :get (str "/rest-api/v1/document/body/relation/" r1-id))
            {:keys [status body]} (rest-handler req)
            val (-> body slurp read-string)]
        (is (= 200 status))
        (is (= "r1" (:relation/value val)))))

    (testing "Setting source works"
      (is (= s2-id (:relation/source (gxe/entity xtdb-node r1-id))))
      (let [req (-> (admin-req :patch (str "/rest-api/v1/document/body/relation/" r1-id))
                    (mock/json-body {:action "setSource" :source s1-id}))
            {:keys [status body]} (rest-handler req)]
        (is (= 200 status))
        (is (= s1-id (:relation/source (gxe/entity xtdb-node r1-id))))))

    (testing "Setting target works"
      (is (= s3-id (:relation/target (gxe/entity xtdb-node r1-id))))
      (let [req (-> (admin-req :patch (str "/rest-api/v1/document/body/relation/" r1-id))
                    (mock/json-body {:action "setTarget" :target s1-id}))
            {:keys [status body]} (rest-handler req)]
        (is (= 200 status))
        (is (= s1-id (:relation/target (gxe/entity xtdb-node r1-id))))))

    (testing "Setting value works"
      (is (= "r1" (:relation/value (gxe/entity xtdb-node r1-id))))
      (let [req (-> (admin-req :patch (str "/rest-api/v1/document/body/relation/" r1-id))
                    (mock/json-body {:action "setValue" :value "newval"}))
            {:keys [status body]} (rest-handler req)]
        (is (= 200 status))
        (is (= "newval" (:relation/value (gxe/entity xtdb-node r1-id))))))

    (testing "Deleting a span that a relation depends on also deletes the relation"
      (is (some? (gxe/entity xtdb-node s1-id)))
      (is (some? (gxe/entity xtdb-node r1-id)))
      (is (some? (gxe/entity xtdb-node r2-id)))
      (let [req (admin-req :delete (str "/rest-api/v1/document/body/span/" s1-id))
            {:keys [status body]} (rest-handler req)]
        (is (= 200 status))
        (is (nil? (gxe/entity xtdb-node s1-id)))
        (is (nil? (gxe/entity xtdb-node r1-id)))
        (is (nil? (gxe/entity xtdb-node r2-id)))))

    ;; Release document lock
    (rest-handler (-> (admin-req :patch (str "/rest-api/v1/document/" document-id "/lock"))
                      (mock/json-body {:action "release"})))))

(deftest relation-layer
  (let [second-rl-id (atom nil)
        {:keys [document-id span-layer-id s1-id s2-id s3-id r1-id r2-id relation-layer-id]} project-ids]
    (testing "Admin can create relation layers"
      (is (= 1 (-> (gxe/entity xtdb-node span-layer-id)
                   :span-layer/relation-layers
                   count)))
      (let [req (-> (admin-req :post "/rest-api/v1/admin/layers/relation")
                    (mock/json-body {:name "second-rl" :spanLayer span-layer-id}))
            {:keys [status body]} (rest-handler req)
            body (read-string (slurp body))]
        (is (= 200 status))
        (is (= 2 (-> (gxe/entity xtdb-node span-layer-id)
                     :span-layer/relation-layers
                     count)))
        (reset! second-rl-id (:id body))))

    (testing "Normal user can't create a relation layer"
      (let [req (-> (user-req :post "/rest-api/v1/admin/layers/relation")
                    (mock/json-body {:name "second-rl" :spanLayer span-layer-id}))
            {:keys [status]} (rest-handler req)]
        (is (= 403 status))))

    (testing "Creation without a valid span layer fails"
      (let [req (-> (admin-req :post "/rest-api/v1/admin/layers/relation")
                    (mock/json-body {:name "bad-rl" :spanLayer (:token-layer-id project-ids)}))
            {:keys [status]} (rest-handler req)]
        (is (= 400 status))))

    (testing "Creation with a bad layer name fails"
      (let [req (-> (admin-req :post "/rest-api/v1/admin/layers/relation")
                    (mock/json-body {:name 1 :spanLayer span-layer-id}))
            {:keys [status]} (rest-handler req)]
        (is (= 400 status)))

      (let [req (-> (admin-req :post "/rest-api/v1/admin/layers/relation")
                    (mock/json-body {:name "" :spanLayer span-layer-id}))
            {:keys [status]} (rest-handler req)]
        (is (= 400 status))))

    (testing "Getting a relation layer works"
      (let [req (admin-req :get (str "/rest-api/v1/admin/layers/relation/" relation-layer-id))
            {:keys [status body]} (rest-handler req)
            body (-> body slurp read-string)]
        (is (= 200 status))
        (is (= "fixture-relation-layer" (:relation-layer/name body)))))

    (testing "Shifting a relation layer works"
      (is (= [relation-layer-id @second-rl-id] (:span-layer/relation-layers (gxe/entity xtdb-node span-layer-id))))
      (let [req (-> (admin-req :patch (str "/rest-api/v1/admin/layers/relation/" relation-layer-id))
                    (mock/json-body {:action "shift" :up false}))
            {:keys [status]} (rest-handler req)]
        (is (= 200 status))
        (is (= [@second-rl-id relation-layer-id] (:span-layer/relation-layers (gxe/entity xtdb-node span-layer-id))))
        (let [req (-> (admin-req :patch (str "/rest-api/v1/admin/layers/relation/" relation-layer-id))
                      (mock/json-body {:action "shift" :up true}))
              {:keys [status]} (rest-handler req)]
          (is (= 200 status))
          (is (= [relation-layer-id @second-rl-id] (:span-layer/relation-layers (gxe/entity xtdb-node span-layer-id)))))))

    (testing "Changing relation layer name works"
      (let [req (-> (admin-req :patch (str "/rest-api/v1/admin/layers/relation/" relation-layer-id))
                    (mock/json-body {:action "setName" :name "new-name"}))
            {:keys [status]} (rest-handler req)]
        (is (= 200 status))
        (is (= "new-name" (:relation-layer/name (gxe/entity xtdb-node relation-layer-id))))))

    (testing "Deleting a relation layer removes the link from the span layer and deletes all relations"
      (let [rl3-id (atom nil)
            r-id (atom nil)]
        (is (= 2 (-> (gxe/entity xtdb-node span-layer-id)
                     :span-layer/relation-layers
                     count)))
        ;; make new relation layer
        (let [req (-> (admin-req :post "/rest-api/v1/admin/layers/relation")
                      (mock/json-body {:name "second-rl" :spanLayer span-layer-id}))
              {:keys [status body]} (rest-handler req)
              body (read-string (slurp body))]
          (is (= 200 status))
          (is (= 3 (-> (gxe/entity xtdb-node span-layer-id)
                       :span-layer/relation-layers
                       count)))
          (reset! rl3-id (:id body)))
        ;; make relation in relation layer
        (let [_ (rest-handler (-> (admin-req :patch (str "/rest-api/v1/document/" document-id "/lock"))
                                  (mock/json-body {:action "acquire"})))
              req (-> (admin-req :post "/rest-api/v1/document/body/relation")
                      (mock/json-body {:source s1-id :target s2-id :value "foo" :layer @rl3-id}))
              {:keys [status body]} (rest-handler req)
              body (read-string (slurp body))]
          (is (= 200 status))
          (reset! r-id (:id body))
          (rest-handler (-> (admin-req :patch (str "/rest-api/v1/document/" document-id "/lock"))
                            (mock/json-body {:action "release"}))))

        (is (some? (gxe/entity xtdb-node @rl3-id)))
        (is (some? (gxe/entity xtdb-node @r-id)))
        (let [req (admin-req :delete (str "/rest-api/v1/admin/layers/relation/" @rl3-id))
              {:keys [status]} (rest-handler req)]
          (is (= 200 status))
          (is (nil? (gxe/entity xtdb-node @rl3-id)))
          (is (nil? (gxe/entity xtdb-node @r-id)))
          (is (= 2 (-> (gxe/entity xtdb-node span-layer-id)
                       :span-layer/relation-layers
                       count))))))

    (testing "Deleting a span layer also deletes dependent relation layers and relations"
      (is (some? (gxe/entity xtdb-node span-layer-id)))
      (is (some? (gxe/entity xtdb-node relation-layer-id)))
      (is (some? (gxe/entity xtdb-node @second-rl-id)))
      (is (some? (gxe/entity xtdb-node r1-id)))
      (is (some? (gxe/entity xtdb-node r2-id)))
      (let [req (admin-req :delete (str "/rest-api/v1/admin/layers/span/" span-layer-id))
            {:keys [status]} (rest-handler req)]
        (is (= 200 status))
        (is (nil? (gxe/entity xtdb-node span-layer-id)))
        (is (nil? (gxe/entity xtdb-node relation-layer-id)))
        (is (nil? (gxe/entity xtdb-node @second-rl-id)))
        (is (nil? (gxe/entity xtdb-node r1-id)))
        (is (nil? (gxe/entity xtdb-node r2-id)))))))
