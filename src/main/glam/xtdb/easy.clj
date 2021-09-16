(ns glam.xtdb.easy
  "A set of convenience functions for transactions with only one part and other common xtdb operations.
  Functions that end in * return a vector that can be used to build transactions incrementally."
  (:require [xtdb.api :as xt]
            [clojure.pprint :as pprint]
            [taoensso.timbre :as log]
            [clojure.walk :as walk]
            [clojure.tools.reader :as reader])
  (:refer-clojure :exclude [set update merge]))

;; reads ---------------------------------------------------------------------------------
(defn entity [node id]
  "Get an entire entity by :xt/id"
  (xt/entity (xt/db node) id))

(defn entities [node id-vecs]
  "get entities given a seq of 1-tuples of :xt/id"
  (map #(entity node (first %)) id-vecs))

(defn q [node query]
  (xt/q (xt/db node) query))

(defn- find-entity-by-attrs
  "Find an entity by attributes. Options:
    - :id-only? [false] - set to true to return only :xt/id instead of the entire entity
    - :all-results [false] - set to true to return more than just the first entity"
  ([node attrs] (find-entity-by-attrs node attrs {:id-only? false :all-results false}))
  ([node attrs {:keys [id-only? all-results] :as opts}]
   (let [result (xt/q (xt/db node)
                      {:find  ['e]
                       :where (vec (for [[k v] attrs]
                                     ['e k v]))})
         result (if all-results result (ffirst result))
         result (if id-only?
                  result
                  (if (set? result)
                    (entities node result)
                    (entity node result)))]
     result)))

(defn find-entity-id [node attrs] (find-entity-by-attrs node attrs {:id-only? true :all-results false}))
(defn find-entity-ids [node attrs] (find-entity-by-attrs node attrs {:id-only? true :all-results true}))
(defn find-entity [node attrs] (find-entity-by-attrs node attrs {:id-only? false :all-results false}))
(defn find-entities [node attrs] (find-entity-by-attrs node attrs {:id-only? false :all-results true}))

;; match --------------------------------------------------------------------------------
(defn match*
  ([eid doc]
   [:xtdb.api/match eid doc])
  ([eid doc valid-time]
   [:xtdb.api/match eid doc valid-time]))

;; deftx --------------------------------------------------------------------------------
(defn- fully-qualify-symbols
  "This helper mimics the behavior of the syntax quote `, taking a sequence of Clojure forms and
  modifying them so that all symbols are fully qualified. Syntax quote can't be used directly since
  we do not want our result to be quoted."
  [body]
  (walk/postwalk
    (fn [form]
      (if (and (symbol? form) (not (special-symbol? form)))
        ;; Begin copy from https://github.com/clojure/tools.reader/blob/6918abc8b3c009228790cf091097eb3037858ad6/src/main/clojure/clojure/tools/reader.clj#L694
        (if (namespace form)
          (let [maybe-class ((ns-map *ns*)
                             (symbol (namespace form)))]
            (if (class? maybe-class)
              (symbol (.getName ^Class maybe-class) (name form))
              (reader/resolve-symbol form)))
          (let [sym (str form)]
            (cond
              ;; We don't need this here
              ;;(.endsWith sym "#")
              ;;(reader/register-gensym form)

              (.startsWith sym ".")
              form

              :else (reader/resolve-symbol form))))
        ;;end copy from tools.reader
        form))
    body))

;; macro for transactions to avoid race conditions: https://clojurians-log.clojureverse.org/crux/2020-03-24
(defmacro deftx [name bindings & body]
  "Defines a function used for mutations that uses a Crux transaction function under the hood.
  Body must return a valid Crux transaction vector (or return false, error, etc.)
  `install-tx-fns` must be called on the node before the deftx function can work.

  NOTE: XTDB tx fns require all symbols to be fully qualified. This macro will attempt to resolve
  them for you, with the following restriction: you MAY NOT use :refer'd symbols--instead, you must
  either refer to the symbol directly (`foo.bar/baz`) or via a namespace abbreviation (`fb/baz`)."
  (let [kwd-name (keyword (str *ns*) (str name))
        symbol-name (symbol (str name))
        fq-body (fully-qualify-symbols body)]
    `(do
       (def
         ~(vary-meta
            symbol-name
            assoc
            :crux-tx-fn
            `(fn [node#]
               (xt/submit-tx node# [[:xtdb.api/put {:xt/id ~kwd-name
                                                    :xt/fn (quote (fn ~bindings
                                                                    ~@fq-body))}]])))
         (fn ~symbol-name [node# & ~'args]
           (let [tx-map# (xt/submit-tx node# [(into [:xtdb.api/fn ~kwd-name] ~'args)])]
             (xt/await-tx node# tx-map#)
             (xt/tx-committed? node# tx-map#))))
       ;; Also define a version that just returns the transaction
       (def
         ~(symbol (str symbol-name "**"))
         (fn ~symbol-name [node# & ~'args]
           [(into [:xtdb.api/fn ~kwd-name] ~'args)])))))

(defn install-deftx-fns
  "Given a node and a seq of namespace symbols, scan all public vars
  and use any :crux-tx-fn in their metadata to install the tx-fn on
  the node"
  ([node]
   ;; If no namespaces are supplied, take all "glam.xtdb" nses that aren't tests
   (install-deftx-fns
     node
     (->> (all-ns)
          (filter #(clojure.string/starts-with? (str %) "glam.xtdb"))
          (filter #(not (clojure.string/ends-with? (str %) "-test"))))))
  ([node namespaces]
   (doseq [ns-symbol namespaces]
     (when-let [ns (the-ns ns-symbol)]
       (doseq [[vname v] (ns-publics ns)]
         (when-let [tx-install-fn (some-> v meta :crux-tx-fn)]
           ;; evict any already-existing entities with the tx-fn's id
           ;; TODO: is there any cost to doing this over and over? If so, consider
           ;; enabling this only in dev and using a put-if-nil strategy for prod
           (xt/await-tx node (xt/submit-tx node [[:xtdb.api/evict (keyword (str ns) (str vname))]]))
           (tx-install-fn node)))))))

;; tx functions for mutations ------------------------------------------------------------
(def ^:private merge-tx-fn-id ::merge)
(def ^:private merge-tx-fn '(fn [ctx eid m]
                              (let [db (xtdb.api/db ctx)
                                    entity (xtdb.api/entity db eid)]
                                [[:xtdb.api/put (merge entity m)]])))

(def ^:private update-tx-fn-id ::update)
(def ^:private update-tx-fn '(fn [ctx eid k f-symbol & args]
                               (let [db (xtdb.api/db ctx)
                                     entity (xtdb.api/entity db eid)
                                     ;; namespace qualify f with clojure.core if there is none
                                     qualified-f-symbol (if (nil? (namespace f-symbol))
                                                          (symbol "clojure.core" (str f-symbol))
                                                          f-symbol)
                                     f-lambda (-> qualified-f-symbol find-var var-get)]
                                 [[:xtdb.api/put (apply update (into [entity k f-lambda] args))]])))

(defn install-tx-fns! [node]
  "Call this on your xtdb node whenever you start it"
  (let [tx-fn (fn [eid fn] {:xt/id eid :xt/fn fn})
        put* (fn [doc] [:xtdb.api/put doc])]
    (when-not (entity node merge-tx-fn-id)
      (log/info "Installing merge transaction function")
      (xt/submit-tx node [(match* merge-tx-fn-id nil)
                          (put* (tx-fn merge-tx-fn-id merge-tx-fn))]))
    (when-not (entity node update-tx-fn-id)
      (log/info "Installing update transaction function")
      (xt/submit-tx node [(match* update-tx-fn-id nil)
                          (put* (tx-fn update-tx-fn-id update-tx-fn))])))
  ;; install tx-fns defined using `deftx` as well
  (install-deftx-fns node))

;; mutations --------------------------------------------------------------------------------
(defn submit-tx-sync [node tx]
  (let [tx-map (xt/submit-tx node tx)]
    (xt/await-tx node tx-map)
    (xt/tx-committed? node tx-map)))
(def submit! submit-tx-sync)

;; vanilla xtdb mutations
(defn put* [doc]
  [:xtdb.api/put doc])
(defn put [node doc]
  (submit-tx-sync node [(put* doc)]))

(defn delete* [eid]
  [:xtdb.api/delete eid])
(defn delete [node eid]
  (submit-tx-sync node [(delete* eid)]))

(defn evict* [eid]
  [:xtdb.api/evict eid])
(defn evict [node eid]
  (submit-tx-sync node [(evict* eid)]))

;; additional mutations api enabled by our tx-fns
(defn merge*
  "Merges m with some entity identified by eid in a transaction function"
  [eid m]
  [:xtdb.api/fn merge-tx-fn-id eid m])
(defn merge
  "Merges m with some entity identified by eid in a transaction function"
  [node eid m]
  (submit-tx-sync node [(merge* eid m)]))

(defmacro update*
  "Updates some entity identified by eid in a transaction function. f can be any function"
  [eid k f & args]
  `(let [f-symbol# (-> ~f var symbol)]
     [:xtdb.api/fn ~update-tx-fn-id ~eid ~k f-symbol# ~@args]))
(defmacro update
  "Updates some entity identified by eid in a transaction function. f can be any function"
  [node eid k f & args]
  `(submit-tx-sync ~node [(update* ~eid ~k ~f ~@args)]))

(comment
  (def node user/node)
  (deftx foo [node rec]
    (log/info rec)
    [[:xtdb.api/put rec]])

  (install-deftx-fns node)

  (foo node {:xt/id ::tmp})
  (xt/q (xt/db node) '{:find [?e] :where [[?e :xt/id ?eid]] :in [?eid]} :txtl1)

  (fully-qualify-symbols (list 'def 'bar []))

  )
