(ns plaid.server.audit)

;; A little sketch from Claude for later. The idea is that this will help us log who committed
;; each change.
;; (def ^:dynamic *user* nil)
;; (def ^:dynamic *action* nil)
;; (defmacro defnaudit
;;   "Like defn, but automatically binds *user* and *action* from the request parameter.
;;    Expects extract-user and extract-action functions to be available.
;;    Function must have arity 1 (single request parameter).
;;    Does not support docstrings or metadata - use plain defn for those cases."
;;   [name params & body]
;;   (let [request-gensym (gensym "request")]
;;     `(defn ~name
;;        [~request-gensym]
;;        (let [~@params ~request-gensym]
;;          (binding [*user* (extract-user ~request-gensym)
;;                    *action* (extract-action ~request-gensym)]
;;          ~@body)))))