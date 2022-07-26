(ns glam.server.rest-wrappers.core
  (:require [reitit.ring :as ring]
            [reitit.ring.middleware.muuntaja :as muuntaja]
            [reitit.ring.coercion :as coercion]
            [ring.middleware.params :as params]
            [muuntaja.core :as m]))

;; cf. https://github.com/metosin/reitit/blob/master/examples/ring-example/src/example/server.clj
(def routes
  ["/rest-api"
   ["/plus" {:get (fn [{{:strs [x y]} :query-params :as req}]
                    {:status 200
                     :body {:total (+ (Long/parseLong x) (Long/parseLong y))}})
             :post (fn [{{:keys [x y]} :body-params}]
                     {:status 200
                      :body {:total (+ x y)}})}]])

(def rest-handler
  (ring/ring-handler
    (ring/router
      [routes]
      {:data {:muuntaja   m/instance
              :middleware [params/wrap-params
                           muuntaja/format-middleware
                           coercion/coerce-exceptions-middleware
                           coercion/coerce-request-middleware
                           coercion/coerce-response-middleware]}})
    (ring/create-default-handler)))
