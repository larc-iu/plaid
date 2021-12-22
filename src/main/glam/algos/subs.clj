(ns glam.algos.subs
  (:require [glam.xtdb.common :as gcc]
            [glam.server.pathom-parser :refer [mutation?]]))


(defn get-messages [node tx response]
  (let [messages (transient [])]
    (doseq [item tx]
      (when (and (mutation? item)
                 (gcc/document-mutation? item)
                 ;; response looks like {glam.models.span/batched-update #:server{...}}
                 ;; assume that the mutation response will be the only item in the response
                 ;; and only trigger the push notification if the mutation did not fail
                 (not (-> response (dissoc :com.wsscode.pathom/trace) vals first :server/error?)))
        (when-some [doc-ident (gcc/get-affected-doc node item response)]
          (conj! messages [:glam/document-changed doc-ident]))))
    (persistent! messages)))
