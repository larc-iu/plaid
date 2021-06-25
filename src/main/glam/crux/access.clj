(ns glam.crux.access
  (:require [crux.api :as crux]))

(def key-symbol-map
  {:project/id    '?p
   :text-layer/id '?tl})

(defn build-query [query-map target-id]
  (case target-id
    :project/id
    (-> query-map
        (update :where conj '(project-accessible ?p ?u))
        (update :rules conj '[(project-accessible ?p ?u)
                              (or [?p :project/readers ?u]
                                  [?p :project/writers ?u])]))

    :text-layer/id
    (-> query-map
        (update :where conj '(text-layer-accessible ?tl ?p))
        (update :rules conj '[(text-layer-accessible ?tl ?p)
                              [?p :project/text-layers ?tl]])
        (build-query :project/id))))

(defn get-accessible-ids
  [node user-id target-key]
  (map first (crux/q (crux/db node)
                     (build-query {:find  [(target-key key-symbol-map)]
                                   :where [['?u :user/id user-id]]
                                   :rules []}
                                  target-key))))

(comment
  (build-query {:find '[?p] :where [['?u :user/id 1]] :rules []} :text-layer/id))
