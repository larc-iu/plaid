(ns plaid.test-runner
  (:require [eftest.runner :as eftest]))

(defn -main [& args]
  (let [opts (loop [args args, opts {}]
               (if (empty? args)
                 opts
                 (case (first args)
                   "--namespace" (recur (drop 2 args)
                                        (assoc opts :ns (symbol (second args))))
                   "--var"       (recur (drop 2 args)
                                        (assoc opts :var (second args)))
                   ;; default: skip unknown
                   (recur (rest args) opts))))
        tests (cond
                (:ns opts)  (do (require (:ns opts))
                                (eftest/find-tests (:ns opts)))
                (:var opts) (do (require (symbol (namespace (symbol (:var opts)))))
                                (eftest/find-tests (resolve (symbol (:var opts)))))
                :else       (eftest/find-tests "src/test"))
        results (eftest/run-tests tests {:multithread? false})]
    (System/exit (if (or (pos? (:fail results 0))
                          (pos? (:error results 0)))
                   1 0))))
