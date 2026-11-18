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
            [plaid.rest-api.v1.middleware :as mw]
            [plaid.sql.common :as psc]
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

(deftest a-ref-naming-a-job-is-taken-only-from-that-jobs-starter
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
    (testing "the job's token and its starter may label their writes with the job's ref"
      (is (= 200 (rename token d1 (str "job:" job "/doc:" d1 "/pass:gloss"))))
      (is (= 200 (rename st d1 (str "job:" job "/doc:" d1 "/pass:gloss")))))
    (testing "nobody writes core's undo or redo ref, nor names a job that is not theirs"
      (doseq [who [token st]]
        (is (= 403 (rename who d1 (str "job:" job "/undo"))))
        (is (= 403 (rename who d1 (str "job:" job "/redo")))))
      (is (= 403 (rename token d1 (str "job:" (random-uuid) "/doc:" d1)))))
    (assert-ok-finish (finish! job jh/worker-a "done"))
    (doseq [[label who doc] [["a stranger, in their own project" n own-d]
                             ["a maintainer of Q only, in Q" qm qm-d]
                             ["a maintainer of P, in P" m d1]
                             ["the admin, in P" a d1]]
            pass ["undo" "redo" "doc:x/pass:gloss"]]
      (testing (str label ", ref job:<id>/" pass)
        (is (= 403 (rename who doc (str "job:" job "/" pass))))))
    (doseq [pass ["undo" "redo"]]
      (testing (str "the starter, ref job:<id>/" pass " after the job ended")
        (is (= 403 (rename st d1 (str "job:" job "/" pass))))))
    (testing "other refs stay free labels"
      (is (= 200 (rename n own-d "action:vocab-replace"))))
    (testing "P's job does not read undone"
      (is (nil? (undone r job)))
      (is (nil? (undone a job))))))

(deftest a-line-break-in-a-ref-gets-nothing-past
  ;; REV-CA-3: the ref was matched with `.`, which stops at a line
  ;; terminator, so `job:<P's job>/doc:x` with a newline, a carriage return
  ;; or U+2028 at the end or inside matched no job and was taken from anyone.
  ;; plaid-agent reads `job:<id>/doc:` as a prefix, so the job took that
  ;; person's write for its own. A group ref holding a control character or
  ;; a line terminator is now refused outright (400), and the job rule reads
  ;; any ref that starts `job:`.
  (let [{:keys [p d1 st m]} (jh/world!)
        job (job-id (start! st p))
        refs [(str "job:" job "/doc:x/pass:gloss\n")
              (str "job:" job "/doc:x\r")
              (str "job:" job "/doc:x" (char 0x2028) "y")]]
    (doseq [ref refs]
      (testing (pr-str ref)
        (is (= 400 (rename m d1 ref)) "a maintainer of P, not the starter")
        (is (= 400 (rename st d1 ref)) "the starter too: a ref is one line")))
    (testing "any ref, not only a job's"
      (doseq [c [\newline \return (char 0x2028) (char 0x2029) (char 0x85) (char 1) \tab]]
        (is (= 400 (rename st d1 (str "action:vocab" c "x"))) (pr-str c)))
      (is (= 200 (rename st d1 "action:vocab x ñ")) "a space and a letter are fine"))
    (testing "the job rule itself reads across a line terminator"
      (let [refuse (fn [ref] (#'mw/job-ref-refusal fix/db ref "maintainer@example.com"))]
        (doseq [ref refs]
          (is (some? (refuse ref)) (pr-str ref)))
        (is (some? (refuse (str "job:" job "\n/undo"))))))
    (testing "no such ref was stored"
      (is (empty? (psc/q fix/db {:select [:ref] :from [:operation_groups] :where [:like :ref "job:%"]}))))))
