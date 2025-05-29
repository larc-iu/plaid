(ns plaid.xtdb.access
  (:require [plaid.xtdb.common :as pxc]
            [xtdb.api :as xt]
            [taoensso.timbre :as log]))

(def key-symbol-map
  {:project/id        '?p
   :document/id       '?d
   :text-layer/id     '?txtl
   :text/id           '?txt
   :token-layer/id    '?tokl
   :token/id          '?tok
   :span-layer/id     '?sl
   :span/id           '?s
   :relation-layer/id '?rl
   :relation/id       '?r})

(defmulti build-query
  "Build up a query for finding whether a target piece of information is accessible for
  a given user. In the base case, the target is a project, and we inspect whether the user
  id is contained in :project/readers or :project/writers. Otherwise, we need to walk the
  graph from the target until we reach its associated project. This multimethod implements
  the xtdb rules necessary to support this traversal."
  (fn [query-map opts target-id] target-id))

(defmethod build-query :project/id [query-map {:keys [writeable]} _]
  ;; Base case--a project's accessible if its user is listed in writers or readers
  (-> query-map
      (update :where conj '(project-accessible ?p ?u))
      (update :rules conj ['(project-accessible ?p ?u)
                           (if writeable
                             '(or [?p :project/writers ?u]
                                  [?p :project/maintainers ?u])
                             '(or [?p :project/readers ?u]
                                  [?p :project/writers ?u]
                                  [?p :project/maintainers ?u]))])
      (update :rules conj ['(project-accessible ?p ?u)
                           '[?u :user/is-admin true]
                           ;; TODO: this is needed to avoid an "Or join variable never used", but is not needed.
                           ;; Figuring out how to do this without the extra clause would be nice, but is OK for now
                           '[?p :project/id _]])))

(defmethod build-query :document/id [query-map opts _]
  (-> query-map
      (update :where conj '(document-accessible ?d ?p))
      (update :rules conj '[(document-accessible ?d ?p)
                            [?d :document/project ?p]])
      (build-query opts :project/id)))

(defmethod build-query :text-layer/id [query-map opts _]
  (-> query-map
      (update :where conj '(text-layer-accessible ?txtl ?p))
      (update :rules conj '[(text-layer-accessible ?txtl ?p)
                            [?p :project/text-layers ?txtl]])
      (build-query opts :project/id)))

(defmethod build-query :text/id [query-map opts _]
  (-> query-map
      (update :where conj '(text-accessible ?txt ?txtl))
      (update :rules conj '[(text-accessible ?txt ?txtl)
                            [?txt :text/layer ?txtl]])
      (build-query opts :text-layer/id)))

(defmethod build-query :token-layer/id [query-map opts _]
  (-> query-map
      (update :where conj '(token-layer-accessible ?tokl ?txtl))
      (update :rules conj '[(token-layer-accessible ?tokl ?txtl)
                            [?txtl :text-layer/token-layers ?tokl]])
      (build-query opts :text-layer/id)))

(defmethod build-query :token/id [query-map opts _]
  (-> query-map
      (update :where conj '(token-accessible ?tok ?tokl))
      (update :rules conj '[(token-accessible ?tok ?tokl)
                            [?tok :token/layer ?tokl]])
      (build-query opts :token-layer/id)))

(defmethod build-query :span-layer/id [query-map opts _]
  (-> query-map
      (update :where conj '(span-layer-accessible ?sl ?tokl))
      (update :rules conj '[(span-layer-accessible ?sl ?tokl)
                            [?tokl :token-layer/span-layers ?sl]])
      (build-query opts :token-layer/id)))

(defmethod build-query :span/id [query-map opts _]
  (-> query-map
      (update :where conj '(span-accessible ?s ?sl))
      (update :rules conj '[(span-accessible ?s ?sl)
                            [?s :span/layer ?sl]])
      (build-query opts :span-layer/id)))

(defmethod build-query :relation-layer/id [query-map opts _]
  (-> query-map
      (update :where conj '(relation-layer-accessible ?rl ?sl))
      (update :rules conj '[(relation-layer-accessible ?rl ?sl)
                            [?sl :span-layer/relation-layers ?rl]])
      (build-query opts :span-layer/id)))

(defmethod build-query :relation/id [query-map opts _]
  (-> query-map
      (update :where conj '(relation-accessible ?r ?rl))
      (update :rules conj '[(relation-accessible ?r ?rl)
                            [?r :relation/layer ?rl]])
      (build-query opts :relation-layer/id)))


(defn get-accessible-ids
  "Get all accessible IDs of a certain type given a user's privileges on projects.
  `target-key` is something like :project/id"
  [node user-id target-key]
  (let [query (build-query {:find  [(target-key key-symbol-map)]
                            :where [['?u :user/id user-id]]
                            :rules []}
                           {:writeable false}
                           target-key)]
    (map first (xt/q (xt/db node) query))))

(defn ident-readable?
  "Test whether a given ident is readable for a given user."
  [node user-id [target-key target-id]]
  (or
    (-> node xt/db (xt/entity user-id) :user/admin?)
    (let [query (build-query {:find  ['?target]
                              :where [['?u :user/id user-id]
                                      ['?target target-key target-id]
                                      [(list '= '?target (get key-symbol-map target-key))]]
                              :rules []}
                             {:writeable false}
                             target-key)]
      (not (empty? (xt/q (xt/db node) query))))))

(defn ident-writeable?
  "Test whether a given ident is writeable for a given user."
  [node user-id [target-key target-id]]
  (or
    (-> node xt/db (xt/entity user-id) :user/admin?)
    (let [query (build-query {:find  ['?target]
                              :where [['?u :user/id user-id]
                                      ['?target target-key target-id]
                                      [(list '= '?target (get key-symbol-map target-key))]]
                              :rules []}
                             {:writeable true}
                             target-key)]
      (log/info query)
      (not (empty? (xt/q (xt/db node) query))))))

(comment
  (build-query {:find '[?p] :where [['?u :user/id 1]] :rules []} {:writeable true} :text-layer/id))
