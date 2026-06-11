(ns plaid.sql.operation-5xx-redaction-test
  "Regression for #114: when a body thrown ExceptionInfo carries no
  `:code` (or carries a 5xx code), `submit-operation*` falls through to
  the 500 branch. Before the fix, the outer catch unconditionally
  surfaced `(ex-message e)` as `:error` — leaking developer-facing
  detail (column names, internal table refs, etc.) to API clients.

  After the fix, 5xx replies carry the generic `\"Internal error\"`
  string and the raw message lives only in the server-side log. 4xx
  flows are left untouched: validators throwing structured app errors
  with `:code 4xx` keep their messages because they're caller-actionable
  by design."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-clean-db]]
            [plaid.sql.operation :as op]))

(use-fixtures :once with-db with-mount-states)
(use-fixtures :each with-clean-db)

(deftest five-xx-ex-info-error-is-redacted
  ;; Body throws ExceptionInfo with NO :code → defaults to 500. The
  ;; raw message must NOT appear in the response :error.
  (let [secret "secret server detail — column my_internal_col"
        result (op/submit-operation*
                db
                {:type :test/regression
                 :description "5xx redaction test"
                 :user nil}
                (fn [_tx]
                  (throw (ex-info secret {:other :data}))))]
    (is (false? (:success result)))
    (is (= 500 (:code result)))
    (is (= "Internal error" (:error result))
        (str "Expected redacted error on 5xx; got " (pr-str (:error result))))
    (is (not= secret (:error result))
        "raw message must not leak into the response")))

(deftest explicit-5xx-code-is-redacted
  ;; Body throws with explicit :code 503. Same redaction policy applies.
  (let [secret "another internal detail"
        result (op/submit-operation*
                db
                {:type :test/regression
                 :description "5xx redaction test"
                 :user nil}
                (fn [_tx]
                  (throw (ex-info secret {:code 503}))))]
    (is (false? (:success result)))
    (is (= 503 (:code result)))
    (is (= "Internal error" (:error result)))))

(deftest four-xx-ex-info-error-is-preserved
  ;; 4xx app-thrown errors are caller-actionable; keep the message.
  (let [msg "Document version conflict"
        result (op/submit-operation*
                db
                {:type :test/regression
                 :description "4xx preserved test"
                 :user nil}
                (fn [_tx]
                  (throw (ex-info msg {:code 409 :document-id "x"}))))]
    (is (false? (:success result)))
    (is (= 409 (:code result)))
    (is (= msg (:error result))
        "4xx flows must preserve the original message")))

(deftest post-commit-failure-does-not-invert-success-to-500
  ;; BUG-10 regression: a throw out of the post-commit hook
  ;; (`post-submit!` — event publish + lock refresh) must not turn a
  ;; successful OLTP commit into a 5xx response. The OLTP write is
  ;; already durable by the time we get here; the most we can do is
  ;; log + continue.
  (with-redefs [op/post-submit! (fn [& _]
                                  (throw (ex-info "simulated post-submit failure"
                                                  {:type :test/post-submit-broke})))]
    (let [result (op/submit-operation*
                  db
                  {:type :test/regression
                   :description "BUG-10 post-submit-failure isolation"
                   :user nil}
                  (fn [_tx] :ok))]
      (is (true? (:success result))
          "the OLTP commit succeeded so the operation must report success despite the post-commit throw")
      (is (= :ok (:extra result))))))

(deftest post-commit-failure-isolates-error-not-just-exception
  ;; The production catch is `(catch Throwable t …)`. The Exception-only
  ;; variant of the test above wouldn't notice if someone narrowed the
  ;; catch back to `(catch Exception …)` — `ExceptionInfo` is itself an
  ;; Exception. Pin the Throwable contract by throwing a java.lang.Error
  ;; (NOT an Exception subclass) and asserting the commit still wins.
  (with-redefs [op/post-submit! (fn [& _]
                                  (throw (Error. "boom — simulated JVM Error from post-submit")))]
    (let [result (op/submit-operation*
                  db
                  {:type :test/regression
                   :description "post-commit Throwable isolation"
                   :user nil}
                  (fn [_tx] :ok))]
      (is (true? (:success result))
          "Throwable (not just Exception) out of post-submit! must not invert the successful commit")
      (is (= :ok (:extra result))))))
