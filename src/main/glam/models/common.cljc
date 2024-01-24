(ns glam.models.common
  (:require [com.wsscode.pathom.connect :as pc]
            [com.wsscode.pathom.parser :as pp]
            [taoensso.timbre :as log]))

(defn is-layer? [xtdb-entity]
  (some #(contains? xtdb-entity %) [:text-layer/id :token-layer/id :span-layer/id]))

#?(:cljs
   (defn get-document
     "Given a record representing a structural element of a document (e.g. span, token, ...),
     find the ID of the document it belongs to."
     [fulcro-db record]
     (cond
       (nil? record)
       (log/error "get-document was called with a nil record. Does a record have a bad join?,"
                  " or is a join missing from a query?")

       (:span/id record)
       (if-let [token-id (some-> record :span/tokens first :token/id)]
         (get-document fulcro-db (get-in fulcro-db [:token/id token-id]))
         (log/error "Found a span with no tokens!" record))

       (:token/id record)
       (get-document fulcro-db (get-in fulcro-db [:text/id (some-> record :token/text :text/id)]))

       (:text/id record)
       (get-document fulcro-db (get-in fulcro-db [:document/id (some-> record :text/document :document/id)]))

       (:document/id record)
       (:document/id record)

       :else
       (log/error "Unrecognized record type" record))))

(defn server-message [msg]
  {:server/code    200
   :server/message msg
   :server/error?  false})

(defn server-error
  ([code msg]
   {:server/code   code
    :server/message msg
    :server/error?  true})
  ([msg]
   {:server/code    400
    :server/message msg
    :server/error?  true}))

(defn apply-delta [entity delta]
  (let [new-vals (into {} (for [[k {:keys [after]}] delta]
                            [k after]))
        new-entity (merge entity new-vals)]
    new-entity))

(defn validate-delta [record-valid-fn delta]
  (let [new-vals (into {} (for [[k {:keys [after]}] delta]
                            [k after]))]
    (record-valid-fn new-vals)))

(defn try-get-document-ident
  "Use within a Pathom resolver to attempt to extract a document ID from the query.
  Used to facilitate implementation of all document-level resolvers. Assumes that
  the query will have a join on the document ident in the root of the first item in
  the transaction, something like `[{[:document/id :doc1] ...}]`.

  Maybe this should have been expressed on the ::pc/input of every resolver that needs
  it somehow, but this is a more ergonomic solution, and if it's OK for a resolver to
  fail for pretty much any reason, perhaps a query not looking right ought to be one."
  [env]
  (let [[key id :as maybe-ident] (-> env :com.wsscode.pathom.core/path first)]
    (if (and (= 2 (count maybe-ident)) (vector? maybe-ident) (= key :document/id))
      maybe-ident
      (do
        (log/warn (str "try-get-document-ident couldn't find a document ident! This isn't necessarily a problem unless "
                       "you were trying to query for document-level structures and not just layer information. ")
                  "query: " (:com.wsscode.pathom.core/root-query env))
        nil))))
