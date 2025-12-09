(ns plaid.rest-api.v1.health
  (:import [java.time Instant]))

(def health-routes
  [["/health"
    {:get {:summary "Health check endpoint"
           :handler (fn [_]
                      {:status 200
                       :body   {:status    "healthy"
                                :timestamp (str (Instant/now))}})}}]])
