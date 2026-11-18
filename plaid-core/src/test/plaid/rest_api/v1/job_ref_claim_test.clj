(ns plaid.rest-api.v1.job-ref-claim-test
  "A `?group-ref=` is the caller's claim about its own write. Core reads
  one kind, `job:<id>/...`, to decide whether a job stands undone and which
  writes are a job's own, so a ref naming a job is taken only from that
  job's own token, and `job:<id>/undo` and `/redo` from nobody: core writes
  those itself (ACL7-1). Before, any account could rename a document of its
  own with `?group-ref=job:<P's job>/undo` and P's job then read undone."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users]]
            [plaid.rest-api.v1.job-helpers :as jh :refer [as call start! job-id claim! finish!]]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- rename [who doc ref]
  (:status (call who :patch (str "/api/v1/documents/" doc "?group-id=" (random-uuid)
                                 "&group-ref=" (java.net.URLEncoder/encode ref "UTF-8"))
                 {:name (str "renamed " (random-uuid))})))

(defn- undone [who job]
  (-> (call who :get (str "/api/v1/jobs/" job)) :body :job/undone))

(defn- assert-ok-finish [resp]
  (is (#{200 204} (:status resp)) (pr-str resp)))

(deftest a-ref-naming-a-job-is-taken-only-from-that-jobs-own-token
  (let [{:keys [p d1 st m r a] :as w} (jh/world!)
        job (job-id (start! st p))
        token (as (-> (claim! jh/worker-a) :body :token))
        ;; a stranger with a project and a document of their own
        n (:n w)
        own-p (h/create-test-project n "Stranger's own")
        own-d (h/create-test-document n own-p "own doc")
        ;; a maintainer of Q only
        qm (jh/user! "qmaint@example.com")
        _ (jh/grant! (:q w) "maintainers" "qmaint@example.com")
        qm-d (h/create-test-document qm (:q w) "q doc 2")]
    (testing "the job's own token may label its writes with its own ref"
      (is (= 200 (rename token d1 (str "job:" job "/doc:" d1 "/pass:gloss")))))
    (testing "the job's own token may not write core's undo or redo ref, nor another job's ref"
      (is (= 403 (rename token d1 (str "job:" job "/undo"))))
      (is (= 403 (rename token d1 (str "job:" job "/redo"))))
      (is (= 403 (rename token d1 (str "job:" (random-uuid) "/doc:" d1)))))
    (assert-ok-finish (finish! job jh/worker-a "done"))
    (doseq [[label who doc] [["a stranger, in their own project" n own-d]
                             ["a maintainer of Q only, in Q" qm qm-d]
                             ["the job's starter, in P" st d1]
                             ["a maintainer of P, in P" m d1]
                             ["the admin, in P" a d1]]
            pass ["undo" "redo" "doc:x/pass:gloss"]]
      (testing (str label ", ref job:<id>/" pass)
        (is (= 403 (rename who doc (str "job:" job "/" pass))))))
    (testing "other refs stay free labels"
      (is (= 200 (rename n own-d "action:vocab-replace"))))
    (testing "P's job does not read undone"
      (is (nil? (undone r job)))
      (is (nil? (undone a job))))))
