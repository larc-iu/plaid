(ns glam.server.middleware
  (:require
    [clojure.pprint :refer [pprint]]
    [clojure.string :as string]
    [clojure.java.io :as io]
    [clojure.tools.reader.edn :as edn]
    [taoensso.timbre :as log]
    [mount.core :as mount]
    [com.fulcrologic.guardrails.core :refer [>defn => | ?]]

    [com.fulcrologic.fulcro.server.api-middleware :refer [handle-api-request
                                                          wrap-transit-params
                                                          wrap-transit-response]]
    [ring.middleware.defaults :refer [wrap-defaults]]
    [ring.util.response :refer [response file-response resource-response]]
    [ring.util.response :as resp]
    [ring.util.request :as ring-req]
    [reitit.ring.middleware.exception :as exception]
    [reitit.ring.middleware.multipart :as multipart]
    [reitit.ring.middleware.muuntaja :as muuntaja]
    [muuntaja.core :as muuc]
    [muuntaja.middleware :as muum]
    [reitit.ring.middleware.parameters :as parameters]
    [reitit.http :as rhttp]
    [hiccup.page :refer [html5]]

    [crux.api :as crux]

    ;; needed for specs
    ;reitit.http.coercion
    [glam.server.config :refer [config]]
    [glam.server.pathom-parser :refer [parser]]
    [glam.server.crux :refer [crux-node crux-session-node]]
    [glam.crux.easy :as cutil])
  (:import (java.io PushbackReader IOException)
           (ring.middleware.session.store SessionStore)
           (java.util UUID)))

;; crux ring session store, from dvingo

(def anti-forgery-token-str "__anti-forgery-token")

(defn make-session-data
  [key data]
  (-> data
      (assoc :__anti-forgery-token (get data anti-forgery-token-str))
      (dissoc anti-forgery-token-str)
      (assoc :crux.db/id key ::session? true)))

(deftype CruxSessionStore [crux-node]
  SessionStore

  (read-session [this key]
    (if (some? key)
      (try
        (let [sess (crux/entity (crux/db crux-node) (UUID/fromString key))]
          (-> sess
              (assoc anti-forgery-token-str (:__anti-forgery-token sess))
              (dissoc :__anti-forgery-token)))
        (catch Exception e
          (log/error "Invalid session. Error reading crux/entity for key: " key)
          {}))
      {}))

  (write-session [_ key data]
    ;(log/info "writing session: at key: " key)
    (let [key (try (cond-> key (some? key) UUID/fromString)
                   (catch Exception e (UUID/randomUUID)))
          key (or key (UUID/randomUUID))
          tx-data (make-session-data key data)]
      (log/trace "Writing session data: " tx-data)
      (log/trace "At key : " key)
      (cutil/put crux-node tx-data)
      key))

  (delete-session [_ key]
    (log/info "Deleting session: " key)
    (cutil/delete crux-node key)
    nil))

(defn crux-session-store [crux-node]
  (CruxSessionStore. crux-node))
;; end ring session store

(def manifest-file "public/js/main/manifest.edn")

(defn load-edn
  "Load edn from an io/reader source
  Tries to read as resource first then filename."
  [source]
  (try
    (with-open [r (io/reader (io/resource source))] (edn/read (PushbackReader. r)))
    (catch IOException e
      (try
        ;; try just a file read
        (with-open [r (io/reader source)] (edn/read (PushbackReader. r)))
        (catch IOException e
          (printf "Couldn't open '%s': %s\n" source (.getMessage e)))
        (catch RuntimeException e
          (printf "Error parsing edn file '%s': %s\n" source (.getMessage e))))
      (printf "Couldn't open '%s': %s\n" source (.getMessage e)))
    (catch RuntimeException e
      (printf "Error parsing edn file '%s': %s\n" source (.getMessage e)))))

(defn get-js-filename []
  (:output-name (first (load-edn manifest-file))))

;; ================================================================================
;; Dynamically generated HTML. We do this so we can safely embed the CSRF token
;; in a js var for use by the client, and to use hashed filename output from shadow.
;; ================================================================================
(defn index [csrf-token]
  (if-let [js-filename (get-js-filename)]
    (do (log/debug "Serving index.html")
        (html5
          [:head {:lang "en"}
           [:title "Application"]
           [:meta {:charset "utf-8"}]
           [:meta {:name "viewport" :content "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"}]
           [:link {:rel "stylesheet" :href "https://fonts.googleapis.com/css?family=Roboto:300,400,500,700&display=swap"}]
           [:link {:rel "stylesheet" :href "https://fonts.googleapis.com/icon?family=Material+Icons"}]
           [:link {:rel "shortcut icon" :href "data:image/x-icon;," :type "image/x-icon"}]
           [:script (str "var fulcro_network_csrf_token = '" csrf-token "';")]]
          [:body
           [:div#app]
           [:script {:src (str "/js/main/" js-filename)}]]))
    (throw (Exception. (str "Error reading JavaScript filename from shadow-cljs manifest.edn file.
    The filename is nil, you probably need to wait for the shadow-cljs build to complete or start it again.
    Check manifest.edn in the shadow-cljs build directory.")))))

(defn wrap-html-routes [ring-handler]
  (fn [{:keys [uri anti-forgery-token] :as req}]
    (cond
      (re-matches #"^/js" uri)
      (ring-handler req)

      (re-matches #"^/api" uri)
      (ring-handler req)

      :else
      (-> (resp/response (index anti-forgery-token))
          (resp/content-type "text/html")))))

(def ^:private not-found-handler
  (fn [req]
    {:status  404
     :headers {"Content-Type" "text/plain"}
     :body    "404"}))

(defn wrap-api [handler parser uri]
  (fn [request]
    (if (= uri (:uri request))
      (handle-api-request
        (:transit-params request)
        (fn [tx] (parser {:ring/request request} tx)))
      (handler request))))

(mount/defstate middleware
  :start
  (let [defaults-config (:ring.middleware/defaults-config config)]
    ;; TODO: CORS support? also need to verify csrf token works
    (-> not-found-handler
        (wrap-api parser "/api")
        wrap-transit-params
        wrap-transit-response
        wrap-html-routes
        ;; If you want to set something like session store, you'd do it against
        ;; the defaults-config here (which comes from an EDN file, so it can't have
        ;; code initialized).
        ;; E.g. (wrap-defaults (assoc-in defaults-config [:session :store] (my-store)))
        (wrap-defaults defaults-config))))