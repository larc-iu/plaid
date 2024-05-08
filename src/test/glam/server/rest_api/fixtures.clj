(ns glam.server.rest-api.fixtures
  (:require [clojure.test :refer :all]
            [glam.fixtures :refer [rest-handler xtdb-node]]
            [glam.xtdb.easy :as gxe]
            [ring.mock.request :as mock]))

(def admin-cookie nil)
(def admin-id nil)
(def user-cookie nil)
(def user-id nil)

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
