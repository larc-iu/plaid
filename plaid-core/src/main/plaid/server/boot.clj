(ns plaid.server.boot
  "Bringing the mount states up, and taking them back down when one of them
  does not come up.

  Split out of plaid.server.main for the same reason as
  plaid.server.reexec: requiring main registers every mount defstate
  (http-server included) in the JVM-wide registry and changes what a bare
  (mount/start) in any other test brings up. This ns requires nothing
  stateful."
  (:require [mount.core :as mount]
            [taoensso.timbre :as log]))

(defn start-cleanly!
  "Start every registered mount state with `args`. Returns nil when they all
  came up, or the exit code the process should die with when one did not.

  The states start in dependency order, so a throw leaves everything before
  it running: an http-kit server already bound to the port, the instance
  lock still held, and a datasource whose WAL is never checkpointed. The
  process would then sit there, dead but holding all three, and the next
  start would refuse the port. Stopping what started returns the port, the
  lock and the WAL before the exit."
  [args]
  (try
    (mount/start-with-args args)
    nil
    (catch Throwable t
      (log/error t "Startup failed")
      (try
        (mount/stop)
        (catch Throwable stop-t
          (log/error stop-t "Stopping after the failed startup did not finish")))
      1)))
