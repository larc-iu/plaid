(ns plaid.rest-api.v1.health)

(def health-routes
  [["/health"
    {:get {:summary "Health check endpoint"
           :handler (fn [_]
                      {:status 200
                       :body   {:status "healthy"}})}}]])
