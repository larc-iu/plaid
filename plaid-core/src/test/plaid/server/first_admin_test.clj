(ns plaid.server.first-admin-test
  "The first admin is made at startup, from env vars or from a prompt. When
  the account cannot be made, the server exits, and the operator has to be
  told why."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-clean-db]]
            [plaid.server.sql :as server-sql]
            [plaid.sql.user :as user]
            [taoensso.timbre :as log]))

(use-fixtures :once with-db)
(use-fixtures :each with-clean-db)

(defn- run-prompt
  "Run the interactive branch with `email` and `password` typed at the
  prompt. Returns {:lines logged :exit status-or-nil :out printed}."
  [email password]
  (let [lines (atom [])
        exit (atom nil)
        out (with-out-str
              (binding [log/*config* (merge log/*config*
                                            {:appenders {:println {:enabled? false}
                                                         :capture {:enabled? true
                                                                   :fn (fn [{:keys [msg_]}]
                                                                         (swap! lines conj (str (force msg_))))}}})]
                (with-redefs [server-sql/console-attached? (constantly true)
                              server-sql/exit! (fn [status] (reset! exit status))
                              server-sql/read-line-secret (constantly password)
                              read-line (constantly email)]
                  (server-sql/make-admin-user fix/db))))]
    {:lines @lines :exit @exit :out out}))

(deftest the-first-admin-prompt-says-why-it-failed
  (is (nil? (System/getenv "PLAID_ADMIN_EMAIL")) "the env-var branch is not taken")
  (testing "a short password exits and logs the reason"
    (let [{:keys [lines exit]} (run-prompt "first@b.com" "abc1234")]
      (is (= 1 exit))
      (is (some #(str/includes? % (str "at least " user/min-password-length " characters")) lines)
          (pr-str lines))
      (is (nil? (user/get fix/db "first@b.com")))))
  (testing "the prompt states the minimum"
    (is (str/includes? (:out (run-prompt "first@b.com" "abc1234"))
                       (str "at least " user/min-password-length " characters"))))
  (testing "a long enough password makes the admin"
    (let [{:keys [exit]} (run-prompt "first@b.com" "abc12345")]
      (is (nil? exit))
      (is (user/admin? (user/get fix/db "first@b.com"))))))
