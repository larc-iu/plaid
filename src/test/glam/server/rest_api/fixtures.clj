(ns glam.server.rest-api.fixtures
  (:require [clojure.test :refer :all]
            [glam.fixtures :refer [rest-handler xtdb-node]]
            [glam.xtdb.easy :as gxe]
            [ring.mock.request :as mock]))

;; session --------------------------------------------------------------------------------
(defn get-session-cookie [resp]
  (-> resp
      :headers
      (get "Set-Cookie")
      first
      (clojure.string/split #";")
      first
      (clojure.string/split #"=")
      second))

(defn add-session [req cookie]
  (-> req
      (mock/cookie "ring-session" cookie)))

;; admin and normal users -----------------------------------------------------------------
(def admin-cookie nil)
(def admin-id nil)
(def user-cookie nil)
(def user-id nil)

(defn with-user-cookies [f]
  (let [_ (rest-handler (-> (mock/request :post "/rest-api/v1/session/register")
                            (mock/json-body {:username "a@b.com" :password "fake-password1"})))
        _ (rest-handler (-> (mock/request :post "/rest-api/v1/session/register")
                            (mock/json-body {:username "b@b.com" :password "fake-password2"})))
        a-cookie (get-session-cookie (rest-handler (-> (mock/request :post "/rest-api/v1/session/login")
                                                       (mock/json-body {:username "a@b.com" :password "fake-password1"}))))
        b-cookie (get-session-cookie (rest-handler (-> (mock/request :post "/rest-api/v1/session/login")
                                                       (mock/json-body {:username "b@b.com" :password "fake-password2"}))))]
    (with-redefs [admin-cookie a-cookie
                  user-cookie b-cookie
                  admin-id (-> (gxe/find-entity xtdb-node [[:user/name "a@b.com"]]) :user/id)
                  user-id (-> (gxe/find-entity xtdb-node [[:user/name "b@b.com"]]) :user/id)]
      (f))))

(defn admin-req [method url]
  (-> (mock/request method url)
      (mock/header "accept" "application/edn")
      (add-session admin-cookie)))

(defn user-req [method url]
  (-> (mock/request method url)
      (mock/header "accept" "application/edn")
      (add-session user-cookie)))

;; fixture project with one doc ----------------------------------------------------------

(def project-ids {})
(defn with-project-and-doc [f]
  (let [get-id (fn [resp] (-> resp :body slurp read-string :id))
        project-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/admin/layers/project")
                                             (mock/json-body {:name "fixture-project"}))))
        document-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document")
                                              (mock/json-body {:name    "fixture-document"
                                                               :project project-id}))))
        text-layer-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/admin/layers/text")
                                                (mock/json-body {:name    "fixture-text-layer"
                                                                 :project project-id}))))
        token-layer-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/admin/layers/token")
                                                 (mock/json-body {:name      "fixture-token-layer"
                                                                  :textLayer text-layer-id}))))
        span-layer-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/admin/layers/span")
                                                (mock/json-body {:name       "fixture-span-layer"
                                                                 :tokenLayer token-layer-id}))))
        relation-layer-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/admin/layers/relation")
                                                    (mock/json-body {:name      "fixture-relation-layer"
                                                                     :spanLayer span-layer-id}))))
        _ (rest-handler (-> (admin-req :patch (str "/rest-api/v1/document/" document-id "/lock"))
                            (mock/json-body {:action "acquire"})))
        text-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document/body/text")
                                          (mock/json-body {:layer    text-layer-id
                                                           :document document-id
                                                           :body     "Huck's my name"}))))
        tok1-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document/body/token")
                                          (mock/json-body {:begin 0 :end 4 :layer token-layer-id :text text-id}))))
        tok2-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document/body/token")
                                          (mock/json-body {:begin 4 :end 6 :layer token-layer-id :text text-id}))))
        tok3-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document/body/token")
                                          (mock/json-body {:begin 7 :end 9 :layer token-layer-id :text text-id}))))
        tok4-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document/body/token")
                                          (mock/json-body {:begin 10 :end 14 :layer token-layer-id :text text-id}))))
        s1-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document/body/span")
                                        (mock/json-body {:layer span-layer-id :value "s1" :tokens [tok1-id tok2-id]}))))
        s2-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document/body/span")
                                        (mock/json-body {:layer span-layer-id :value "s2" :tokens [tok3-id]}))))
        s3-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document/body/span")
                                        (mock/json-body {:layer span-layer-id :value "s3" :tokens [tok4-id]}))))
        r1-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document/body/relation")
                                        (mock/json-body {:layer  relation-layer-id :value "r1"
                                                         :source s2-id :target s3-id}))))
        r2-id (get-id (rest-handler (-> (admin-req :post "/rest-api/v1/document/body/relation")
                                        (mock/json-body {:layer  relation-layer-id :value "r2"
                                                         :source s1-id :target s3-id}))))

        _ (rest-handler (-> (admin-req :patch (str "/rest-api/v1/document/" document-id "/lock"))
                            (mock/json-body {:action "release"})))]
    (with-redefs [project-ids {:project-id project-id
                               :document-id document-id
                               :text-layer-id text-layer-id
                               :token-layer-id token-layer-id
                               :span-layer-id span-layer-id
                               :relation-layer-id relation-layer-id
                               :txt-id text-id
                               :tok1-id tok1-id
                               :tok2-id tok2-id
                               :tok3-id tok3-id
                               :tok4-id tok4-id
                               :s1-id s1-id
                               :s2-id s2-id
                               :s3-id s3-id
                               :r1-id r1-id
                               :r2-id r2-id}]
      (println (gxe/find-entities xtdb-node [[:text/id '_]]))
      (println project-ids)
      (f))))

