(ns plaid.server.sse-wire-test
  "The SSE `data:` payload is a documented contract (see the manual's
  Real-time Messaging > Event Reference). It is produced by projecting the
  internal bus event through `events/wire-payload`.

  The bug this guards: the bus event carries BOTH :event/projects (routing
  metadata for the distributor) and :audit/projects (the payload field), and
  clojure.data.json serializes a keyword by `name`, dropping the namespace.
  Serializing the raw event therefore emitted a JSON object with the key
  \"projects\" twice."
  (:require [clojure.test :refer :all]
            [clojure.data.json :as json]
            [plaid.server.events :as events]))

(defn- wire-json [event]
  (json/write-str (events/wire-payload event)))

(defn- key-order
  "The TOP-LEVEL keys of a JSON object string, in emitted order, duplicates
  included. Depth-aware so nested objects (`ops`, a message's `data`) don't
  contribute their own keys. The values here contain no escaped quotes."
  [s]
  (loop [chars (seq s), depth 0, in-str? false, buf nil, ks []]
    (if-let [c (first chars)]
      (let [rest' (rest chars)]
        (cond
          in-str? (if (= c \")
                    ;; String closed. At depth 1 it is a key iff a colon follows.
                    (let [k (apply str (reverse buf))
                          nxt (first (drop-while #{\space} rest'))]
                      (recur rest' depth false nil
                             (if (and (= depth 1) (= nxt \:)) (conj ks k) ks)))
                    (recur rest' depth true (cons c buf) ks))
          (= c \") (recur rest' depth true nil ks)
          (#{\{ \[} c) (recur rest' (inc depth) false nil ks)
          (#{\} \]} c) (recur rest' (dec depth) false nil ks)
          :else (recur rest' depth false nil ks)))
      ks)))

(def ^:private audit-event
  {:event/type :audit-log
   :event/projects #{"p1"}
   :audit/id "a1"
   :audit/projects #{"p1"}
   :audit/documents #{"d1"}
   :audit/user "u@example.com"
   :audit/time (java.util.Date. 0)
   :audit/ops [{:op/id "a1"
                :op/type "document:update"
                :op/project "p1"
                :op/document "d1"
                :op/description "Update document d1"}]})

(def ^:private message-event
  {:event/type :message
   :event/projects #{"p1"}
   :message/id "m1"
   :message/project "p1"
   :message/user "u@example.com"
   :message/time (java.util.Date. 0)
   :message/data {"case-marker" "ERG"}})

(deftest audit-event-payload-has-no-duplicate-keys
  (let [ks (key-order (wire-json audit-event))]
    (is (= (count ks) (count (distinct ks)))
        (str "duplicate key in the audit-log payload: " (pr-str ks)))
    (is (= ["type" "id" "projects" "documents" "user" "time" "ops"] ks)
        "documented key set, `type` first")))

(deftest message-event-payload-has-no-duplicate-keys
  (let [ks (key-order (wire-json message-event))]
    (is (= (count ks) (count (distinct ks)))
        (str "duplicate key in the message payload: " (pr-str ks)))
    (is (= ["type" "id" "project" "user" "time" "data"] ks)
        "documented key set")
    (is (= {"case-marker" "ERG"}
           (get (json/read-str (wire-json message-event)) "data"))
        "the sender's own payload keys pass through verbatim")))

(deftest routing-metadata-never-reaches-the-wire
  (doseq [event [audit-event message-event]]
    (let [payload (events/wire-payload event)]
      (is (not (contains? payload :event/type)))
      (is (not (contains? payload :event/projects))))))

(deftest type-mirrors-the-sse-event-name
  (is (= "audit-log" (:type (events/wire-payload audit-event))))
  (is (= "message" (:type (events/wire-payload message-event))))
  (is (= "unknown" (:type (events/wire-payload {:event/type :something-else})))))
