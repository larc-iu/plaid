(ns plaid.server.first-admin-test
  "The first admin is made at startup, from env vars or from a prompt. When
  the account cannot be made, the server exits, and the operator has to be
  told why."
  (:require [clojure.string :as str]
            [buddy.hashers :as hashers]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-clean-db]]
            [plaid.server.sql :as server-sql]
            [plaid.sql.user :as user]
            [taoensso.timbre :as log]))

(use-fixtures :once with-db)
(use-fixtures :each with-clean-db)

(defn- run-prompt
  "Run the interactive branch with `email` typed at the email prompt (a
  vector is typed in turn, one at each email prompt) and `secrets` typed, in
  turn, at each password prompt (nil once either runs out, as at the end of
  input). Returns {:lines logged :exit status-or-nil :out printed}."
  [email & secrets]
  (let [lines (atom [])
        exit (atom nil)
        typed (atom secrets)
        emails (atom (if (vector? email) email (repeat email)))
        out (with-out-str
              (binding [log/*config* (merge log/*config*
                                            {:appenders {:println {:enabled? false}
                                                         :capture {:enabled? true
                                                                   :fn (fn [{:keys [msg_]}]
                                                                         (swap! lines conj (str (force msg_))))}}})]
                (with-redefs [server-sql/console-attached? (constantly true)
                              server-sql/exit! (fn [status] (reset! exit status))
                              server-sql/read-line-secret (fn [] (let [[s] @typed] (swap! typed next) s))
                              read-line (fn [] (let [[e] @emails] (swap! emails next) e))]
                  (server-sql/make-admin-user fix/db))))]
    {:lines @lines :exit @exit :out out}))

(defn- count-of [needle s]
  (count (re-seq (re-pattern (java.util.regex.Pattern/quote needle)) s)))

(defn- password-is? [email password]
  (hashers/check password (:user/password-hash (user/get-internal fix/db email))))

(deftest the-first-admin-prompt-asks-again-until-the-password-is-usable
  (is (nil? (System/getenv "PLAID_ADMIN_EMAIL")) "the env-var branch is not taken")
  (testing "the prompt states the minimum"
    (is (str/includes? (:out (run-prompt "first@b.com" "abc12345" "abc12345"))
                       (str "at least " user/min-password-length " characters"))))
  (testing "a short password is asked again, with the rule, and the admin is made"
    (let [{:keys [exit out]} (run-prompt "second@b.com" "abc1234" "abc12345" "abc12345")]
      (is (nil? exit))
      (is (= 2 (count-of "Enter password" out)) out)
      (is (str/includes? out (str "Password must be at least " user/min-password-length " characters.")) out)
      (is (user/admin? (user/get fix/db "second@b.com")))))
  (testing "a blank password is asked again"
    (let [{:keys [exit out]} (run-prompt "third@b.com" "        " "abc12345" "abc12345")]
      (is (nil? exit))
      (is (= 2 (count-of "Enter password" out)) out)
      (is (user/admin? (user/get fix/db "third@b.com"))))))

;; REV-FX-B: a mistyped email was caught only after the password had been
;; typed twice, and then the server exited.
(deftest the-first-admin-prompt-asks-again-until-the-email-is-one
  (let [{:keys [exit out]} (run-prompt ["not an email" "fourth@b.com"] "abc12345" "abc12345")]
    (is (nil? exit))
    (is (= 2 (count-of "Enter email" out)) out)
    (is (= 1 (count-of "Enter password" out)) out)
    (is (str/includes? out "User ID must be an email address") out)
    (is (user/admin? (user/get fix/db "fourth@b.com"))))
  (testing "the end of input exits, with no account"
    (let [{:keys [exit]} (run-prompt ["not an email"])]
      (is (= 1 exit)))))

(deftest the-first-admin-password-is-typed-twice
  (testing "two passwords that differ are asked again, and the second pair makes the admin"
    (let [{:keys [exit out]} (run-prompt "first@b.com" "abc12345" "abc12346" "xyz98765" "xyz98765")]
      (is (nil? exit))
      (is (= 2 (count-of "Enter password" out)) out)
      (is (= 2 (count-of "Confirm password" out)) out)
      (is (str/includes? out "Passwords do not match.") out)
      (is (password-is? "first@b.com" "xyz98765"))))
  (testing "the end of input exits and logs the reason, with no account"
    (let [{:keys [exit lines]} (run-prompt "second@b.com" "abc12345")]
      (is (= 1 exit))
      (is (seq lines))
      (is (nil? (user/get fix/db "second@b.com"))))))
