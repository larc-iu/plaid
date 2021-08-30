(ns glam.crux.common
  (:require [glam.crux.easy :as gce]
            [taoensso.timbre :as log]
            [clojure.pprint :refer [pprint]]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]))

(defmulti get-affected-doc (fn [crux-node [id-kwd id :as ident]] id-kwd))

(defn document-mutation? [mutation]
  (#{"glam.models.document"
     "glam.models.text"
     "glam.models.text-layer"
     "glam.models.token"
     "glam.models.token-layer"
     "glam.models.span"
     "glam.models.span-layer"} (-> mutation first namespace)))

(defn try-get-ident [mutation]
  (let [{document-id :document/id
         text-id :text/id
         token-id :token/id
         span-id :span/id} (second mutation)]
    (cond document-id [:document/id document-id]
          text-id [:text/id text-id]
          token-id [:token/id token-id]
          span-id [:span/id span-id]
          :else nil)))

(defn get-affected-doc [node [mutation-symbol params :as mutation] pathom-response]
  (let [starting-ident (try-get-ident mutation)
        starting-ident (if (tempid/tempid? (second starting-ident))
                         (if-let [resolved-id (get-in pathom-response [mutation-symbol :tempids (second starting-ident)])]
                           [(first starting-ident) resolved-id]
                           nil)
                         starting-ident)]
    (loop [[id-type id :as ident] starting-ident]
      (case id-type
        :document/id ident
        :text/id (recur [:document/id (:text/document (gce/entity node id))])
        :token/id (recur [:text/id (:token/text (gce/entity node id))])
        :span/id (recur [:token/id (first (:span/tokens (gce/entity node id)))])
        nil))))
