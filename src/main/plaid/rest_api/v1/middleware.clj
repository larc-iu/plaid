(ns plaid.rest-api.v1.middleware
  (:require [plaid.xtdb.user :as pxu]
            [taoensso.timbre :as log]))

(defn wrap-request-extras [handler xtdb secret-key]
  (fn [request]
    (handler (-> request
                 (assoc :xtdb xtdb)
                 (assoc :secret-key secret-key)))))

(defn wrap-logging [handler]
  (fn [request]
    (let [req-id (hash request)]
      (log/debug (str "Received request " req-id ": " (-> request
                                                         (dissoc :secret-key)
                                                         (dissoc :xtdb)
                                                         (dissoc :headers)
                                                         (dissoc :reitit.core/match)
                                                         (dissoc :reitit.core/router)
                                                         (dissoc :async-channel)
                                                         (dissoc :muuntaja/response)
                                                         (dissoc :cookies))
                      "\n"
                      "Headers: " (-> request :headers (dissoc "authorization"))))
      (let [response (handler request)]
        (log/debug (str "Sending response to request " req-id ": " response))
        response))))
