(ns plaid.rest-api.v1.middleware
  (:require [clojure.instant :as instant]
            [plaid.xtdb.user :as pxu]
            [taoensso.timbre :as log]
            [xtdb.api :as xt]))

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

(defn wrap-as-of-db
  "Enriches the request object with :db, which will hold either the current or an historical state of the database."
  [handler]
  (fn [request]
    (let [as-of (get-in request [:params :as-of])
          db (if as-of
               (xt/db (:xtdb request) (instant/read-instant-date as-of))
               (xt/db (:xtdb request)))]

      (cond
        ;; Need to forbid as-of with requests which are not GETs because of how they could be used to circumvent
        ;; the current state of a user's permissions: if currently lacks privileges they had in the past, they could
        ;; use an as-of to make the permissions check happen in the past. It's a little annoying to deal with this
        ;; later on in the implementation of permissions checking, so we will just reject any write with an as-of.
        (and as-of (not= (:request-method request) :get))
        {:status 400 :body {:error "as-of query parameter is only allowed with GETs"}}

        as-of
        (handler (assoc request :db (xt/db (:xtdb request) (instant/read-instant-date as-of))))

        :else
        (handler (assoc request :db db))))))
