(ns glam.server.pathom-parser
  (:require
    [com.wsscode.pathom.connect :as pc]
    [com.wsscode.pathom.core :as p]
    [dv.pathom :refer [build-parser]]
    [glam.server.neo4j :refer [neo4j-conn]]
    [glam.models.project :refer [project-resolvers]]
    [glam.models.session :as session]
    [glam.models.user :as user]
    [glam.models.common :refer [server-error]]
    [glam.server.config :refer [config]]
    [glam.server.crux :refer [crux-node]]
    [neo4j-clj.core :as neo4j]
    [dv.pathom :as dp]
    [com.wsscode.pathom.viz.ws-connector.core :as pathom-viz]
    [taoensso.timbre :as log]))

(def all-resolvers
  [session/resolvers
   user/resolvers
   project-resolvers])


#_(def parser
    (let [{:keys [trace? index-explorer? log-responses?
                  connect-viz? sensitive-keys]} (::config config)]
      (build-parser
        {:resolvers          all-resolvers
         :trace?             trace?
         :index-explorer?    index-explorer?
         :log-responses?     log-responses?
         :enable-pathom-viz? connect-viz?
         :sensitive-keys     sensitive-keys
         :env-additions      (fn [env] {:crux-node    crux-node
                                        :neo4j        (neo4j/get-session neo4j-conn)
                                        :config       config
                                        :current-user (user/get-current-user env)})})))


(def env-additions
  (fn [env]
    (let [session (neo4j/get-session neo4j-conn)]
      {
       :neo4j        session
       :config       config
       :current-user (user/get-current-user (assoc env :neo4j session))})))

(def parser
  (let [{:keys [trace? index-explorer?
                log-responses? connect-viz?
                handle-errors? sensitive-keys]} (::config config)
        base-plugins [(pc/connect-plugin {::pc/register all-resolvers})
                      (dp/preprocess-parser-plugin dp/log-requests)
                      dp/query-params-to-env-plugin
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
                                         env-additions (conj (p/env-wrap-plugin (dp/mk-augment-env-request env-additions)))
                                         trace? (conj p/trace-plugin)
                                         )})
        parser (cond->> parser
                        connect-viz?
                        (pathom-viz/connect-parser {::pathom-viz/parser-id ::parser}))]
    (fn wrapped-parser [env tx]
      (when-not (vector? tx) (throw (Exception. "You must pass a vector for the transaction.")))
      ;; Add trace - pathom-viz already adds it so only add if that's not included.
      (let [tx (if (and trace? (not connect-viz?))
                 (conj tx :com.wsscode.pathom/trace) tx)
            resp (parser env tx)]
        (when log-responses?
          (dp/log-response! sensitive-keys resp))
        resp))))

