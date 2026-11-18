(ns plaid.rest-api.v1.deleted-layer-answers-test
  "An admin acting on a layer deleted a moment ago hears 404 on its config
  routes and on a one-document repair, as on its other routes, and a member
  the gate's 403 (ACL2-2). Before, the config routes answered 400 'Not a
  valid layer ID' and the repair said the document was not in the layer's
  project."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    api-call assert-status]]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer create-span-layer create-relation-layer
                                        add-project-writer]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(deftest a-deleted-layer-is-a-404-to-an-admin-everywhere
  (let [p (create-test-project admin-request "P")
        doc (create-test-document admin-request p "d")
        _ (assert-status 204 (add-project-writer admin-request p "user1@example.com"))
        tl (id (create-text-layer admin-request p "TL"))
        wl (id (create-token-layer admin-request tl "W"))
        sl (id (create-span-layer admin-request wl "S"))
        rl (id (create-relation-layer admin-request sl "R"))
        ;; layers deleted children first; a second text layer for the text kind
        layers [["relation" rl] ["span" sl] ["token" wl] ["text" tl]]]
    (doseq [[kind layer] layers]
      (assert-status 204 (api-call admin-request {:method :delete :path (str "/api/v1/" kind "-layers/" layer)})))
    (doseq [[kind layer] layers
            :let [base (str "/api/v1/" kind "-layers/" layer)]]
      (testing kind
        (testing "config PUT and DELETE"
          (assert-status 404 (api-call admin-request {:method :put :path (str base "/config/igt/x") :body 1}))
          (assert-status 404 (api-call admin-request {:method :delete :path (str base "/config/igt/x")}))
          (assert-status 403 (api-call user1-request {:method :put :path (str base "/config/igt/x") :body 1})))
        (when (not= kind "text")
          (testing "a one-document repair"
            (let [body {:constraints [{:type (if (= kind "token") "no-overlap" "single-span")}] :document doc}]
              (assert-status 404 (api-call admin-request {:method :post :path (str base "/constraints/repair")
                                                          :body body})))))))))
