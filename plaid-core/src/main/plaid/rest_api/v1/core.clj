(ns plaid.rest-api.v1.core
  (:require [reitit.ring :as ring]
            [reitit.ring.coercion :as coercion]
            [reitit.openapi :as openapi]
            [reitit.swagger-ui :as swagger-ui]
            [reitit.coercion.malli]
            [reitit.ring.middleware.muuntaja :as muuntaja]
            [reitit.ring.middleware.parameters :as parameters]
            [reitit.ring.middleware.exception :as exception]
            [reitit.ring.middleware.multipart :as multipart]
            [reitit.ring.coercion :as rrc]
            [muuntaja.core :as m]
            [malli.util :as mu]
            [plaid.server.config :refer [config]]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.rest-api.v1.auth :as pra :refer [authentication-routes logout-routes]]
            [plaid.rest-api.v1.user :refer [user-routes]]
            [plaid.rest-api.v1.api-token :refer [api-token-routes]]
            [plaid.rest-api.v1.project :refer [project-routes]]
            [plaid.rest-api.v1.message :refer [message-routes]]
            [plaid.rest-api.v1.document :refer [document-routes]]
            [plaid.rest-api.v1.text :refer [text-routes]]
            [plaid.rest-api.v1.text-layer :refer [text-layer-routes]]
            [plaid.rest-api.v1.token-layer :refer [token-layer-routes]]
            [plaid.rest-api.v1.token :refer [token-routes]]
            [plaid.rest-api.v1.span :refer [span-routes]]
            [plaid.rest-api.v1.span-layer :refer [span-layer-routes]]
            [plaid.rest-api.v1.relation-layer :refer [relation-layer-routes]]
            [plaid.rest-api.v1.relation :refer [relation-routes]]
            [plaid.rest-api.v1.audit :refer [audit-routes]]
            [plaid.rest-api.v1.batch :refer [batch-routes]]
            [plaid.rest-api.v1.vocab-layer :refer [vocab-layer-routes]]
            [plaid.rest-api.v1.vocab-item :refer [vocab-item-routes]]
            [plaid.rest-api.v1.vocab-link :refer [vocab-link-routes]]
            [plaid.rest-api.v1.query :refer [query-routes]]
            [plaid.rest-api.v1.health :refer [health-routes]]))

(def coercion
  (reitit.coercion.malli/create
   {:transformers {:body {:default reitit.coercion.malli/default-transformer-provider
                          :formats {"application/json" reitit.coercion.malli/json-transformer-provider}}
                   :string {:default reitit.coercion.malli/string-transformer-provider}
                   :response {:default reitit.coercion.malli/default-transformer-provider}}
     ;; set of keys to include in error messages
    :error-keys #{:type :coercion :in :schema :value :errors :humanized #_:transformed}
     ;; support lite syntax?
    :lite true
     ;; schema identity function (default: close all map schemas)
    :compile mu/closed-schema
     ;; validate request & response
    :validate true
     ;; top-level short-circuit to disable request & response coercion
    :enabled true
     ;; strip-extra-keys (effects only predefined transformers)
    :strip-extra-keys true
     ;; add/set default values
    :default-values true
     ;; malli options
    :options nil}))

(defn routes []
  ;; #119 — OpenAPI / Swagger UI exposure is gated by config. Default is
  ;; true (preserves current behavior). Operators running a hardened
  ;; production deployment can flip `:plaid.api :expose-openapi?` to
  ;; false to omit the spec and the docs UI entirely, both of which
  ;; would otherwise leak API surface area to unauthenticated callers
  ;; (or to authenticated ones who shouldn't see internal routes).
  (let [expose-openapi? (get-in config [:plaid.api :expose-openapi?] true)]
    (into ["/api/v1"
           {:responses {200 {:description "Response"}}}

           health-routes
           authentication-routes

           ;; Login required
           [""
            {:openapi {:security [{:auth []}]}
             :middleware [pra/wrap-login-required]}

            ;; `?as-of=` is only meaningful on document-scoped GETs (the
            ;; OLAP replica only mirrors document state). Everything else
            ;; rejects it with 400 via `wrap-reject-as-of`; document
            ;; routes route through OLAP via `wrap-route-as-of`. These
            ;; can't live in the global middleware stack — reitit applies
            ;; global middleware outermost, which means a global reject
            ;; would fire before a per-route router could intercept.
            [""
             {:middleware [prm/wrap-reject-as-of]}
             logout-routes
             user-routes
             api-token-routes
             project-routes
             message-routes
             text-routes
             text-layer-routes
             token-layer-routes
             token-routes
             span-routes
             span-layer-routes
             relation-routes
             relation-layer-routes
             audit-routes
             batch-routes
             vocab-layer-routes
             vocab-item-routes
             vocab-link-routes
             query-routes]

            [""
             {:middleware [prm/wrap-route-as-of]}
             document-routes]]]

          (when expose-openapi?
            [;; swagger documentation
             [""
              {:no-doc true}
              ["/openapi.json"
               {:get {:openapi {:info {:title "plaid-api-v1"
                                       :description "Plaid's REST API"
                                       :version "v1.0"}
                                :components {:securitySchemes {:auth {:type "http"
                                                                      :scheme "bearer"
                                                                      :bearerFormat "JWT"}}}}
                      :handler (openapi/create-openapi-handler)}}]
              ["/docs/*"
               {:middleware []
                :get (swagger-ui/create-swagger-ui-handler
                      {:url "/api/v1/openapi.json"
                       :config {:validatorUrl nil
                                :tryItOutEnabled true
                                :persistAuthorization true}})}]]]))))

(defn rest-handler [db secret-key]
  (let [;; Create custom muuntaja instance that preserves fractional seconds
        muuntaja-instance (m/create
                           (-> m/default-options
                               (assoc-in [:formats "application/json" :opts :date-format] "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")))
        handler (ring/ring-handler
                 (ring/router
                  [(routes)]
                  {:data {:coercion coercion
                          :muuntaja muuntaja-instance
                          :swagger {:id ::api}
                          :middleware [#_exception/exception-middleware ;; CLAUDE: DO NOT UNCOMMENT THIS
                                       rrc/coerce-exceptions-middleware
                                       parameters/parameters-middleware
                                       muuntaja/format-negotiate-middleware
                                       muuntaja/format-response-middleware
                                       ;; Between response-encode (outer) and
                                       ;; request-decode (inner): catches a
                                       ;; :muuntaja/decode throw and returns a
                                       ;; 400 that the outer response middleware
                                       ;; still JSON-encodes. See its docstring.
                                       prm/wrap-malformed-json-400
                                       muuntaja/format-request-middleware
                                       coercion/coerce-response-middleware
                                       ;; Run BEFORE coerce-request-middleware so v2-format UUID
                                       ;; values for ?document-version= return a clear 400 rather
                                       ;; than malli's generic coercion error (or worse, the v2-
                                       ;; era silent OCC bypass).
                                       prm/wrap-reject-uuid-document-version
                                       coercion/coerce-request-middleware
                                       multipart/multipart-middleware
                                       [prm/wrap-request-extras db secret-key]
                                       pra/wrap-read-jwt
                                       prm/wrap-logging
                                       ;; Inside wrap-read-jwt: needs the
                                       ;; :api-token/id it sets on the request.
                                       prm/wrap-api-token-id
                                       openapi/openapi-feature]}})
                 (ring/create-default-handler))]
    ;; Wrap handler to inject itself into requests for bulk operations
    (fn [request]
      (handler (assoc request :rest-handler handler)))))

