(ns glam.server.rest-api.core
  (:require [reitit.ring :as ring]
            [reitit.ring.coercion :as coercion]
            [reitit.swagger :as swagger]
            [reitit.swagger-ui :as swagger-ui]
            [reitit.ring.middleware.muuntaja :as muuntaja]
            [reitit.ring.middleware.parameters :as parameters]
            [reitit.ring.middleware.exception :as exception]
            [reitit.ring.middleware.multipart :as multipart]
            [reitit.ring.middleware.parameters :as parameters]
            [muuntaja.core :as m]
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

(def routes
  ["/rest-api"
   ["/pluss"
    {:get {:parameters  {:query {:x int? :y int?}}
           :description "Add two numbers"
           :handler     (fn [{{{:keys [x y]} :query} :parameters :as req}]
                          {:status 200
                           :body   {:total (+ x y)}})}}]

   ;; swagger documentation
   [""
    {:no-doc  true
     :swagger {:info {:title       "glam-rest-api"
                      :description "Glam REST API"}}}

    ["/swagger.json"
     {:get (swagger/create-swagger-handler)}]

    ["/docs/*"
     {:get (swagger-ui/create-swagger-ui-handler
             {:url    "/rest-api/swagger.json"
              :config {:validator-url nil}})}]]])

(def rest-handler
  (ring/ring-handler
    (ring/router
      [routes]
      {:data {:coercion   coercion
              :muuntaja   m/instance
              :middleware [swagger/swagger-feature
                           parameters/parameters-middleware
                           muuntaja/format-negotiate-middleware
                           muuntaja/format-response-middleware
                           #_exception/exception-middleware
                           muuntaja/format-request-middleware
                           coercion/coerce-response-middleware
                           coercion/coerce-request-middleware
                           multipart/multipart-middleware]
              :swagger    {:id ::api}}})
    (ring/create-default-handler)))
