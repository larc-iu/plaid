(ns plaid.server.idempotency-sweep
  "Deletes stored Idempotency-Key answers past their retention, at start and
  every 15 minutes, on one daemon thread. A lookup already ignores an old
  row (`plaid.sql.idempotency/lookup`), so this only keeps the table small."
  (:require [mount.core :refer [defstate]]
            [plaid.server.sql :refer [datasource]]
            [plaid.sql.idempotency :as idem]
            [taoensso.timbre :as log])
  (:import [java.util.concurrent Executors ScheduledExecutorService ThreadFactory TimeUnit]))

(def ^:private period-minutes 15)

(defn sweep-once!
  "Delete the rows past retention. Returns how many went."
  [ds]
  (let [n (idem/prune! ds)]
    (when (pos? n)
      (log/info "Deleted" n "idempotency keys past retention"))
    n))

(defstate idempotency-sweep
  :start (let [exec (Executors/newSingleThreadScheduledExecutor
                     (reify ThreadFactory
                       (newThread [_ r]
                         (doto (Thread. ^Runnable r "plaid-idempotency-sweep") (.setDaemon true)))))
               ds datasource]
           (.scheduleWithFixedDelay exec
                                    (fn []
                                      (try (sweep-once! ds)
                                           (catch Throwable t
                                             (log/warn t "Idempotency key sweep failed:" (ex-message t)))))
                                    0 period-minutes TimeUnit/MINUTES)
           exec)
  :stop (when idempotency-sweep
          (.shutdownNow ^ScheduledExecutorService idempotency-sweep)
          nil))
