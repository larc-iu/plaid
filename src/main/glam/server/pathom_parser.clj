(ns glam.server.pathom-parser
  (:require [com.wsscode.pathom.connect :as pc]
            [com.wsscode.pathom.core :as p]
            [glam.models.project :refer [project-resolvers]]
            [glam.models.text-layer :refer [text-layer-resolvers]]
            [glam.models.token-layer :refer [token-layer-resolvers]]
            [glam.models.span-layer :refer [span-layer-resolvers]]
            [glam.models.session :as session]
            [glam.models.user :as user]
            [glam.models.common :refer [server-error]]
            [glam.server.config :refer [config]]
            [glam.server.crux :refer [crux-node]]
    ;[com.wsscode.pathom.viz.ws-connector.core :as pathom-viz]
            [taoensso.timbre :as log]))

(def all-resolvers
  [session/resolvers
   user/resolvers
   project-resolvers
   text-layer-resolvers
   token-layer-resolvers
   span-layer-resolvers])

(def env-additions
  (fn [env]
    {:crux         crux-node
     :config       config
     :current-user (user/get-current-user (assoc env :crux crux-node))}))

(defn mk-augment-env-request
  [get-config-map]
  (fn augment-env-request
    [env]
    (merge env (get-config-map env))))

(def parser
  (let [{:keys [trace? index-explorer?
                log-responses? connect-viz?
                handle-errors? sensitive-keys]} (::config config)
        base-plugins [(pc/connect-plugin {::pc/register all-resolvers})
                      (p/pre-process-parser-plugin
                        (fn log-requests [{:keys [env tx] :as req}]
                          (println)
                          (log/debug "Pathom transaction:")
                          (println)
                          req))
                      (p/post-process-parser-plugin p/elide-not-found)]
        parser (p/parser
                 {::p/fail-fast? true
                  ::p/mutate     pc/mutate
                  ::p/env        {::p/reader                 [p/map-reader
                                                              pc/reader2
                                                              pc/index-reader
                                                              pc/open-ident-reader
                                                              p/env-placeholder-reader]
                                  ::p/placeholder-prefixes   #{">"}
                                  ::pc/mutation-join-globals [:tempids]}
                  ::p/plugins    (cond-> base-plugins
                                         #_#_handle-errors? (conj p/error-handler-plugin)
                                         env-additions (conj (p/env-wrap-plugin (mk-augment-env-request env-additions)))
                                         trace? (conj p/trace-plugin)
                                         )})
        parser (cond->> parser
                        ;connect-viz?
                        ;(pathom-viz/connect-parser {::pathom-viz/parser-id ::parser})
                        )]
    (fn wrapped-parser [env tx]
      (when-not (vector? tx) (throw (Exception. "You must pass a vector for the transaction.")))
      ;; Add trace - pathom-viz already adds it so only add if that's not included.
      (let [tx (if (and trace? (not connect-viz?))
                 (conj tx :com.wsscode.pathom/trace) tx)
            resp (parser env tx)]
        resp))))

