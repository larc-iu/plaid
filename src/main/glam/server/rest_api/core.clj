(ns glam.server.rest-api.core
  (:require [reitit.ring :as ring]
            [reitit.ring.coercion :as coercion]
            [reitit.swagger :as swagger]
            [reitit.swagger-ui :as swagger-ui]
            [reitit.coercion.malli]
            [reitit.ring.middleware.muuntaja :as muuntaja]
            [reitit.ring.middleware.parameters :as parameters]
            [reitit.ring.middleware.exception :as exception]
            [reitit.ring.middleware.multipart :as multipart]
            [reitit.ring.middleware.parameters :as parameters]
            [ring.util.response :as resp]
            [taoensso.timbre :as log]
            [muuntaja.core :as m]
            [glam.server.id-counter :refer [id?]]
            [glam.server.pathom-parser :refer [parser]]
            [glam.server.rest-api.util :refer [postprocess-middleware]]
            [glam.server.rest-api.session :refer [session-routes]]
            [glam.server.rest-api.span :refer [span-routes]]
            [malli.experimental.lite :as ml]
            [malli.util :as mu]))

;; cf. https://github.com/metosin/reitit/blob/master/examples/ring-example/src/example/server.clj
;;(defn user-by-id-handler [{:keys [pathom-boundary-interface] :as request}]
;  (pathom-boundary-interface
;    {:pathom/entity {:user/id (-> request :path-params :user-id)}
;     :pathom/eql    [:user/name
;                     :user/email
;                     {:user/addresses
;                      [:address/street]}]}))

;; cf. https://github.com/metosin/reitit/blob/master/examples/ring-malli-swagger/src/example/server.clj

(def coercion
  (reitit.coercion.malli/create
    {:transformers     {:body     {:default reitit.coercion.malli/default-transformer-provider
                                   :formats {"application/json" reitit.coercion.malli/json-transformer-provider}}
                        :string   {:default reitit.coercion.malli/string-transformer-provider}
                        :response {:default reitit.coercion.malli/default-transformer-provider}}
     ;; set of keys to include in error messages
     :error-keys       #{:type :coercion :in :schema :value :errors :humanized #_:transformed}
     ;; support lite syntax?
     :lite             true
     ;; schema identity function (default: close all map schemas)
     :compile          mu/closed-schema
     ;; validate request & response
     :validate         true
     ;; top-level short-circuit to disable request & response coercion
     :enabled          true
     ;; strip-extra-keys (effects only predefined transformers)
     :strip-extra-keys true
     ;; add/set default values
     :default-values   true
     ;; malli options
     :options          nil}))

(defn wrap-auth
  [handler]
  (fn [req]
    (if (nil? (-> req :session :user/id))
      {:status 401
       :body "User not authorized."}
      (handler req))))

(def auth-middleware
  {:name ::auth-middleware
   :compile (fn [_ _]
              {:wrap wrap-auth})})

(defn wrap-csrf
  [handler]
  (fn [req]
    (resp/set-cookie (handler req)
                     "csrf-token"
                     (-> req :session :ring.middleware.anti-forgery/anti-forgery-token)
                     {:http-only true :path "/" :same-site :strict})))

(def csrf-middleware
  {:name ::csrf-middleware
   :compile (fn [_ _]
              {:wrap wrap-csrf})})

(def routes
  ["/rest-api"
   [""
    {:middleware [auth-middleware postprocess-middleware]}
    ["/pluss"
     {:post {:parameters  {:query {:x int? :y int? :cake [:enum "yes" "no"]}}
             :description "Add two numbers"
             :handler     (fn [{{{:keys [x y]} :query} :parameters :as req}]
                            {:status 200
                             :body   {:total (+ x y)}})}}]
    span-routes]
   session-routes

   ;; swagger documentation
   [""
    {:no-doc              true
     :swagger             {:info {:title       "glam-rest-api"
                                  :description "Glam REST API"}}}

    ["/swagger.json"
     {:get (swagger/create-swagger-handler)}]

    ["/docs/*"
     {:middleware [csrf-middleware]
      :get        (swagger-ui/create-swagger-ui-handler
                    {:url "/rest-api/swagger.json"
                     :config {:validatorUrl nil
                              :tryItOutEnabled true}})}]]])

(defn rest-handler []
  (ring/ring-handler
    (ring/router
      [routes]
      {:data {:coercion   coercion
              :muuntaja   m/instance
              :swagger    {:id ::api}
              :middleware [swagger/swagger-feature
                           parameters/parameters-middleware
                           muuntaja/format-negotiate-middleware
                           muuntaja/format-response-middleware
                           #_exception/exception-middleware
                           muuntaja/format-request-middleware
                           coercion/coerce-response-middleware
                           coercion/coerce-request-middleware
                           multipart/multipart-middleware]}})
    (ring/create-default-handler)))

