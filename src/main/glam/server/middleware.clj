(ns glam.server.middleware
  (:require
    [clojure.pprint :refer [pprint]]
    [clojure.java.io :as io]
    [clojure.tools.reader.edn :as edn]
    [mount.core :as mount]
    [taoensso.timbre :as log]
    [hiccup.page :refer [html5]]
    [crux.api :as crux]
    [com.fulcrologic.fulcro.server.api-middleware :refer [handle-api-request wrap-transit-params wrap-transit-response]]
    [com.fulcrologic.fulcro.networking.websockets :as fws]
    [taoensso.sente.server-adapters.http-kit :refer [get-sch-adapter]]
    [ring.util.response :as resp :refer [response file-response resource-response]]
    [ring.middleware.defaults :refer [wrap-defaults]]
    [glam.server.config :refer [config]]
    [glam.server.pathom-parser :refer [parser]]
    [glam.server.crux :refer [crux-node crux-session-node]]
    [glam.crux.easy :as gce])
  (:import (java.io PushbackReader IOException)
           (ring.middleware.session.store SessionStore)
           (java.util UUID)))

(def manifest-file "public/js/main/manifest.edn")

(defn load-edn
  "Loads EDN. Tries to read input as resource first, then as filename.
  We need this to read shadow-cljs's manifest.edn file."
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

(defn index
  "Dynamically generated HTML using hiccup. This makes it easy to dynamically embed the CSRF token, which
  will be used by Fulcro to set `X-CSRF-Header` in requests. During development, it also makes it easy
  for us to use whatever JS filename shadow-cljs is compiling to."
  [csrf-token]
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

;; Crux session store --------------------------------------------------------------------------------
;; Replace the default in-memory session store with this. Makes it so you don't need to log in every time
;; you restart your server.

;; see: https://ring-clojure.github.io/ring-anti-forgery/ring.middleware.anti-forgery.html
(defn make-session-data
  [key data]
  (-> data
      (assoc :crux.db/id key
             ::session? true)))

(deftype CruxSessionStore [crux-node]
  SessionStore

  (read-session [this key]
    (if (some? key)
      (try
        (crux/entity (crux/db crux-node) (UUID/fromString key))
        (catch Exception e
          (log/error "Invalid session. Error reading crux/entity for key: " key)
          {}))
      {}))

  (write-session [_ key data]
    (let [key (try (cond-> key (some? key) UUID/fromString)
                   (catch Exception e (UUID/randomUUID)))
          key (or key (UUID/randomUUID))
          tx-data (make-session-data key data)]
      (gce/put crux-node tx-data)
      key))

  (delete-session [_ key]
    (gce/delete crux-node key)
    nil))

(defn crux-session-store [crux-node]
  (CruxSessionStore. crux-node))

;; Route handling
(defn wrap-html-routes
  "Allows all requests to `/chsk` to continue down the handler chain,
  and otherwise terminates the handler chain by serving the index page. This
  allows page refresh to work 'right' from a user's perspective, as refreshing on
  e.g. `/projects/` will simply serve the index, after which the client-side
  routing setup will ensure that the proper components are displayed."
  [ring-handler]
  (fn [{:keys [uri anti-forgery-token] :as req}]
    (cond
      (re-matches #"^/chsk|^/api" uri)
      (ring-handler req)

      :else
      (-> (resp/response (index anti-forgery-token))
          (resp/content-type "text/html")))))

(defn wrap-ajax-api
  "AJAX remote for Fulcro, registered on the client as the :remote remote"
  [parser]
  (fn [request]
    (handle-api-request
      (:transit-params request)
      (fn [tx] (parser {:ring/request request} tx)))))

;; websockets remote for fulcro, registered as :remote
(mount/defstate websockets
  :start
  (let [wrapped-parser (fn wrapped-parser [env tx]
                         (let [response (parser {:ring/request (:request env)} tx)]
                           response))]
    (fws/start! (fws/make-websockets
                  wrapped-parser
                  {:http-server-adapter (get-sch-adapter)
                   :parser-accepts-env? true
                   ;; See Sente for CSRF instructions
                   :sente-options       {:csrf-token-fn :anti-forgery-token}})))
  :stop
  (fws/stop! websockets))

(mount/defstate middleware
  :start
  (let [defaults-config (:ring.middleware/defaults-config config)]
    (-> (wrap-ajax-api parser)
        wrap-transit-params
        wrap-transit-response
        (fws/wrap-api websockets)
        wrap-html-routes
        (wrap-defaults (assoc defaults-config :session {:store (crux-session-store crux-session-node)})))))
