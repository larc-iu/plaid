(ns plaid.server.events-test
  (:require [clojure.core.async :as async]
            [clojure.test :refer [deftest is]]
            [plaid.server.events :as events]))

(deftest full-event-buffer-reports-the-drop
  (let [bus (async/chan 1)]
    (try
      (reset! events/event-bus-drop-count 0)
      (with-redefs [events/event-bus bus]
        (is (true? (#'events/offer-event! {:n 1} :test)))
        (is (false? (#'events/offer-event! {:n 2} :test)))
        (is (= 1 (events/get-drop-count)))
        (is (= {:n 1} (async/poll! bus))
            "The full fixed buffer retains the queued event"))
      (finally
        (async/close! bus)
        (reset! events/event-bus-drop-count 0)))))
