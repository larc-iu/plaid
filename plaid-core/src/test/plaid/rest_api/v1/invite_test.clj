(ns plaid.rest-api.v1.invite-test
  "End-to-end tests for invite links and admin-issued password resets:
  minting authority, the unauthenticated lookup/redeem pair, use counting
  and exhaustion, revocation, and the invariant that an invite dies with
  the authority that created it."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [ring.mock.request :as mock]
            [plaid.fixtures :as fixtures
             :refer [with-db with-mount-states with-rest-handler with-admin with-test-users
                     with-clean-db rest-handler db api-call
                     admin-request user1-request user2-request
                     assert-ok assert-created assert-no-content assert-forbidden
                     assert-not-found assert-bad-request assert-status]]
            [plaid.sql.invite :as invite]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ---------------------------------------------------------------------------
;; helpers
;; ---------------------------------------------------------------------------

(defn- anon-request
  "A request-fn with NO Authorization header — the state every redeemer is in.
  The public routes must work from here, and the authenticated ones must not."
  [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")))

(defn- mint!
  [request-fn body]
  (api-call request-fn {:method :post :path "/api/v1/invites" :body body}))

(defn- lookup!
  [code]
  (api-call anon-request {:method :post :path "/api/v1/invite-codes/lookup"
                          :body {:code code}}))

(defn- redeem!
  [body]
  (api-call anon-request {:method :post :path "/api/v1/invite-codes/redeem" :body body}))

(defn- login!
  [user-id password]
  (rest-handler (-> (mock/request :post "/api/v1/login")
                    (mock/header "accept" "application/edn")
                    (mock/json-body {:user-id user-id :password password}))))

(defn- token-req-fn
  [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(def ^:private good-password "a-perfectly-fine-password")

(defn- throwaway-user!
  "Create a non-admin user and return `[user-id request-fn]`.

  Tests that reset a password or deactivate an account MUST use one of these
  rather than the standing user1/user2. Both actions bump `password_changes`,
  which invalidates the session token those fixtures bound ONCE for the whole
  namespace — so borrowing a standing user for a destructive test silently
  401s every later test that uses them. `with-clean-db` wipes non-standing
  users between deftests, so these cost nothing to leave behind."
  [user-id]
  (api-call admin-request {:method :post :path "/api/v1/users"
                           :body {:username user-id :password good-password
                                  :is-admin false}})
  (let [resp (login! user-id good-password)
        token (-> resp :body slurp read-string :token)]
    [user-id (token-req-fn token)]))

;; ---------------------------------------------------------------------------
;; code handling
;; ---------------------------------------------------------------------------

(deftest codes-are-high-entropy-and-forgiving-to-type
  (testing "a fresh code is 32 alphabet characters, hyphen-grouped"
    (let [code (invite/generate-code)]
      (is (= 32 (count (clojure.string/replace code "-" ""))))
      (is (re-matches #"[0-9A-HJKMNP-TV-Z]{8}(-[0-9A-HJKMNP-TV-Z]{8}){3}" code))))
  (testing "codes are distinct across a large sample"
    (is (= 500 (count (set (repeatedly 500 invite/generate-code))))))
  (testing "transcription slips normalize to the same digest"
    (let [code (invite/generate-code)
          h (invite/code-hash code)]
      (is (= h (invite/code-hash (clojure.string/lower-case code))))
      (is (= h (invite/code-hash (clojure.string/replace code "-" ""))))
      (is (= h (invite/code-hash (str "  " code "  "))))))
  (testing "characters the alphabet omits fold onto what the reader meant"
    ;; O/0, I/1, L/1 and U/V are the pairs a person reading a code off a
    ;; slide actually confuses, which is why the alphabet drops one of each.
    (is (= (invite/code-hash "0110") (invite/code-hash "OIlO")))
    (is (= (invite/code-hash "V") (invite/code-hash "U"))))
  (testing "a blank code has no digest rather than the digest of empty string"
    (is (nil? (invite/code-hash "")))
    (is (nil? (invite/code-hash "   ")))))

;; ---------------------------------------------------------------------------
;; signup invites
;; ---------------------------------------------------------------------------

(deftest admin-mints-and-a-stranger-redeems
  (let [pid (h/create-test-project admin-request "Field Methods")
        resp (mint! admin-request {:project-id pid :project-role "writer"
                                   :note "Fall 2026" :max-uses 3})]
    (assert-created resp)
    (let [code (-> resp :body :code)
          iid (-> resp :body :id)]
      (testing "the code comes back exactly once, at mint time"
        (is (string? code))
        (is (= "signup" (-> resp :body :kind)))
        (is (= "active" (-> resp :body :status))))

      (testing "an unauthenticated lookup describes the link without leaking"
        (let [pv (lookup! code)]
          (assert-ok pv)
          (is (= "signup" (-> pv :body :kind)))
          (is (= "Field Methods" (-> pv :body :project-name)))
          (is (= "writer" (-> pv :body :project-role)))
          (is (false? (-> pv :body :grant-admin)))
          (testing "and says nothing about who minted it or their bookkeeping"
            (is (nil? (-> pv :body :created-by)))
            (is (nil? (-> pv :body :note)))
            (is (nil? (-> pv :body :uses))))))

      (testing "redeeming creates the account and applies the grant atomically"
        (let [r (redeem! {:code code :username "newbie@example.com"
                          :password good-password})]
          (assert-ok r)
          (is (string? (-> r :body :token)))
          (is (= "newbie@example.com" (-> r :body :user-id)))
          (testing "the returned token is usable immediately"
            (let [me (api-call (token-req-fn (-> r :body :token))
                               {:method :get :path "/api/v1/users/newbie@example.com"})]
              (assert-ok me)
              (is (false? (-> me :body :user/is-admin)))))
          (testing "and the project role landed"
            (let [p (h/get-test-project admin-request pid)]
              (is (some #{"newbie@example.com"} (-> p :body :project/writers)))))))

      (testing "the use count moves, and the code never appears in a listing"
        (let [lr (api-call admin-request {:method :get :path "/api/v1/invites"})
              row (first (filter #(= iid (:id %)) (:entries (:body lr))))]
          (assert-ok lr)
          (is (= 1 (:uses row)))
          (is (= 3 (:max-uses row)))
          (is (nil? (:code row)))))

      (testing "the invite is spent only after max-uses redemptions"
        (assert-ok (redeem! {:code code :username "b@example.com" :password good-password}))
        (assert-ok (redeem! {:code code :username "c@example.com" :password good-password}))
        (let [r (redeem! {:code code :username "d@example.com" :password good-password})]
          (assert-status 410 r)
          (is (re-find #"already been used" (-> r :body :error))))
        (testing "and a spent code still previews, so the page can explain itself"
          (is (= "used" (-> (lookup! code) :body :status))))))))

(deftest bad-codes-are-rejected
  (let [bogus "ZZZZZZZZ-ZZZZZZZZ-ZZZZZZZZ-ZZZZZZZZ"]
    (assert-not-found (lookup! bogus))
    (assert-not-found (redeem! {:code bogus :username "x@example.com"
                                :password good-password}))
    (testing "a blank code is refused rather than matching an empty digest"
      (assert-not-found (redeem! {:code "" :username "x@example.com"
                                  :password good-password})))))

(deftest redemption-validates-without-burning-the-invite
  (let [pid (h/create-test-project admin-request "P")
        code (-> (mint! admin-request {:project-id pid :project-role "reader"}) :body :code)]
    (testing "a short password is refused"
      (assert-bad-request (redeem! {:code code :username "x@example.com" :password "short"})))
    (testing "a username with whitespace is refused"
      (assert-bad-request (redeem! {:code code :username "has space" :password good-password})))
    (testing "a taken username is a 409, not a 500"
      (assert-status 409 (redeem! {:code code :username "user1@example.com"
                                   :password good-password})))
    (testing "none of those consumed a use — the invited person can retry"
      (let [lr (api-call admin-request {:method :get :path "/api/v1/invites"})]
        (is (= 0 (:uses (first (:entries (:body lr)))))))
      (assert-ok (redeem! {:code code :username "finally@example.com"
                           :password good-password})))))

(deftest expired-invites-are-refused
  (let [pid (h/create-test-project admin-request "P")]
    (testing "ttl-days is validated at mint time"
      (assert-bad-request (mint! admin-request {:project-id pid :project-role "reader"
                                                :ttl-days 0}))
      (assert-bad-request (mint! admin-request {:project-id pid :project-role "reader"
                                                :ttl-days 100000})))
    (testing "an invite past its expiry cannot be redeemed"
      (let [resp (mint! admin-request {:project-id pid :project-role "reader"})
            code (-> resp :body :code)]
        ;; Backdate the row directly. Nothing in the REST surface can set an
        ;; expiry in the past, which is exactly why this has to reach past it.
        (plaid.sql.common/execute!
         db {:update :invites
             :set {:expires_at "2020-01-01T00:00:00.000000000Z"}
             :where [:= :id (-> resp :body :id)]})
        (let [r (redeem! {:code code :username "late@example.com" :password good-password})]
          (assert-status 410 r)
          (is (re-find #"expired" (-> r :body :error))))
        (is (= "expired" (-> (lookup! code) :body :status)))))))

;; ---------------------------------------------------------------------------
;; revocation
;; ---------------------------------------------------------------------------

(deftest revocation-kills-the-link
  (let [pid (h/create-test-project admin-request "P")
        resp (mint! admin-request {:project-id pid :project-role "reader"})
        code (-> resp :body :code)
        iid (-> resp :body :id)]
    (assert-no-content (api-call admin-request {:method :delete
                                                :path (str "/api/v1/invites/" iid)}))
    (let [r (redeem! {:code code :username "nope@example.com" :password good-password})]
      (assert-status 410 r)
      (is (re-find #"revoked" (-> r :body :error))))
    (testing "revocation is idempotent"
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/invites/" iid)})))
    (testing "the row survives so the listing still shows it existed"
      (let [lr (api-call admin-request {:method :get :path "/api/v1/invites"})
            row (first (filter #(= iid (:id %)) (:entries (:body lr))))]
        (is (some? row))
        (is (= "revoked" (:status row)))))
    (testing "revoking an unknown invite is a 404"
      (assert-not-found (api-call admin-request
                                  {:method :delete
                                   :path "/api/v1/invites/01a03f68-0000-7000-8000-000000000000"})))))

(deftest only-entitled-users-may-revoke
  (let [pid (h/create-test-project admin-request "P")
        iid (-> (mint! admin-request {:project-id pid :project-role "reader"}) :body :id)]
    (assert-forbidden (api-call user2-request {:method :delete
                                               :path (str "/api/v1/invites/" iid)}))
    (testing "a maintainer of the invite's project may revoke a co-maintainer's link"
      (api-call admin-request {:method :post
                               :path (str "/api/v1/projects/" pid
                                          "/maintainers/user2@example.com")})
      (assert-no-content (api-call user2-request {:method :delete
                                                  :path (str "/api/v1/invites/" iid)})))))

;; ---------------------------------------------------------------------------
;; who may mint what
;; ---------------------------------------------------------------------------

(deftest minting-authority
  (let [pid (h/create-test-project admin-request "P")]
    (testing "an ordinary user may not mint against a project they don't maintain"
      (assert-forbidden (mint! user1-request {:project-id pid :project-role "writer"})))
    (testing "a non-admin may not mint a grantless invite (that is just POST /users)"
      (assert-forbidden (mint! user1-request {})))
    (testing "a non-admin may not grant admin"
      (assert-forbidden (mint! user1-request {:project-id pid :project-role "reader"
                                              :grant-admin true})))
    (testing "a non-admin may not mint a password reset link"
      (assert-forbidden (mint! user1-request {:target-user-id "user2@example.com"})))

    (testing "a project maintainer may mint for their own project"
      (api-call admin-request {:method :post
                               :path (str "/api/v1/projects/" pid
                                          "/maintainers/user1@example.com")})
      (assert-created (mint! user1-request {:project-id pid :project-role "reader"}))
      (testing "but still may not grant admin, or mint elsewhere"
        (assert-forbidden (mint! user1-request {:project-id pid :project-role "reader"
                                                :grant-admin true}))
        (let [other (h/create-test-project admin-request "Other")]
          (assert-forbidden (mint! user1-request {:project-id other
                                                  :project-role "reader"})))))

    (testing "an admin may grant admin, and the redeemed account really is one"
      (let [code (-> (mint! admin-request {:grant-admin true}) :body :code)
            r (redeem! {:code code :username "boss@example.com" :password good-password})]
        (assert-ok r)
        (let [me (api-call admin-request {:method :get
                                          :path "/api/v1/users/boss@example.com"})]
          (is (true? (-> me :body :user/is-admin))))))))

(deftest mint-input-is-validated
  (let [pid (h/create-test-project admin-request "P")]
    (testing "a project grant needs both halves"
      (assert-bad-request (mint! admin-request {:project-id pid}))
      (assert-bad-request (mint! admin-request {:project-role "reader"})))
    (testing "the role must be a real one"
      (assert-bad-request (mint! admin-request {:project-id pid :project-role "overlord"})))
    (testing "an unknown project is a 404"
      (assert-not-found (mint! admin-request
                               {:project-id "01a03f68-0000-7000-8000-000000000000"
                                :project-role "reader"})))
    (testing "max-uses must be positive"
      (assert-bad-request (mint! admin-request {:project-id pid :project-role "reader"
                                                :max-uses 0})))))

(deftest an-invite-dies-with-the-authority-behind-it
  (let [pid (h/create-test-project admin-request "P")]
    (api-call admin-request {:method :post
                             :path (str "/api/v1/projects/" pid
                                        "/maintainers/user1@example.com")})
    (let [code (-> (mint! user1-request {:project-id pid :project-role "writer"}) :body :code)]
      (testing "the link works while the minter still maintains the project"
        (is (= "active" (-> (lookup! code) :body :status))))
      (api-call admin-request {:method :delete
                               :path (str "/api/v1/projects/" pid
                                          "/maintainers/user1@example.com")})
      (testing "and stops the moment they are demoted, without being revoked"
        (let [r (redeem! {:code code :username "toolate@example.com"
                          :password good-password})]
          (assert-forbidden r)
          (is (re-find #"does not maintain" (-> r :body :error))))))))

(deftest a-deactivated-minters-invites-stop-working
  (let [pid (h/create-test-project admin-request "P")
        [minter minter-request] (throwaway-user! "doomed@example.com")]
    (api-call admin-request {:method :post
                             :path (str "/api/v1/projects/" pid "/maintainers/" minter)})
    (let [code (-> (mint! minter-request {:project-id pid :project-role "reader"}) :body :code)]
      (is (string? code))
      ;; Deactivation strips project memberships too, so this covers the
      ;; deactivated-actor branch only if it is checked BEFORE the
      ;; maintainer branch — which is the ordering in check-grant-authority!.
      (api-call admin-request {:method :delete :path (str "/api/v1/users/" minter)})
      (let [r (redeem! {:code code :username "orphan@example.com" :password good-password})]
        (assert-forbidden r)
        (is (re-find #"deactivated" (-> r :body :error)))))))

;; ---------------------------------------------------------------------------
;; listing
;; ---------------------------------------------------------------------------

(deftest listing-is-scoped
  (let [pid (h/create-test-project admin-request "P")]
    (api-call admin-request {:method :post
                             :path (str "/api/v1/projects/" pid
                                        "/maintainers/user1@example.com")})
    (mint! admin-request {:project-id pid :project-role "reader" :note "from admin"})
    (mint! user1-request {:project-id pid :project-role "reader" :note "from user1"})
    (testing "the bare listing shows only what you minted"
      (let [lr (api-call user1-request {:method :get :path "/api/v1/invites"})]
        (assert-ok lr)
        (is (= ["from user1"] (mapv :note (:entries (:body lr)))))))
    (testing "the project listing shows co-maintainers' links too"
      (let [lr (api-call user1-request {:method :get
                                        :path (str "/api/v1/invites?project-id=" pid)})]
        (assert-ok lr)
        (is (= #{"from admin" "from user1"} (set (mapv :note (:entries (:body lr))))))))
    (testing "a non-maintainer cannot read the project listing"
      (assert-forbidden (api-call user2-request
                                  {:method :get
                                   :path (str "/api/v1/invites?project-id=" pid)})))
    (testing "listing requires a login at all"
      (assert-status 401 (api-call anon-request {:method :get :path "/api/v1/invites"})))))

;; ---------------------------------------------------------------------------
;; password resets
;; ---------------------------------------------------------------------------

(deftest password-reset-links
  (let [[target target-request] (throwaway-user! "forgetful@example.com")
        resp (mint! admin-request {:target-user-id target})]
    (assert-created resp)
    (is (= "password-reset" (-> resp :body :kind)))
    (let [code (-> resp :body :code)]
      (testing "the preview names the account so the redeemer knows it's theirs"
        (let [pv (lookup! code)]
          (assert-ok pv)
          (is (= "password-reset" (-> pv :body :kind)))
          (is (= target (-> pv :body :username)))
          (is (nil? (-> pv :body :project-name)))))

      (testing "redeeming sets the new password and returns a live session"
        (let [r (redeem! {:code code :password "brand-new-password"})]
          (assert-ok r)
          (is (= "password-reset" (-> r :body :kind)))
          (is (string? (-> r :body :token)))
          (is (= 200 (:status (login! target "brand-new-password"))))))

      (testing "the old password stops working"
        (is (= 401 (:status (login! target good-password)))))

      (testing "and every session the old password was protecting is dead"
        (assert-status 401 (api-call target-request {:method :get :path "/api/v1/invites"})))

      (testing "a reset link is single-use"
        (assert-status 410 (redeem! {:code code :password "yet-another-password"}))))))

(deftest a-reset-link-dies-if-the-target-is-deactivated
  ;; The target can be closed between minting and redemption. Without the
  ;; in-tx check the reset would "succeed" and hand back a token that
  ;; wrap-read-jwt rejects on the next request.
  (let [[target _] (throwaway-user! "closed@example.com")
        code (-> (mint! admin-request {:target-user-id target}) :body :code)]
    (api-call admin-request {:method :delete :path (str "/api/v1/users/" target)})
    (let [r (redeem! {:code code :password "a-brand-new-password"})]
      (assert-forbidden r)
      (is (re-find #"deactivated" (-> r :body :error))))
    (testing "and works again once the account is reactivated"
      (api-call admin-request {:method :post :path (str "/api/v1/users/" target "/activate")})
      (assert-ok (redeem! {:code code :password "a-brand-new-password"}))
      (is (= 200 (:status (login! target "a-brand-new-password")))))))

(deftest a-reset-preview-follows-a-rename
  ;; `target_user_id` is the immutable user id; a rename changes only
  ;; `username`. The preview has to show what the person is called now, or it
  ;; tells them the link belongs to a name they no longer use.
  (let [[target _] (throwaway-user! "before@example.com")
        code (-> (mint! admin-request {:target-user-id target}) :body :code)]
    (assert-ok (api-call admin-request {:method :patch
                                        :path (str "/api/v1/users/" target)
                                        :body {:username "after@example.com"}}))
    (is (= "after@example.com" (-> (lookup! code) :body :username)))))

(deftest password-reset-links-grant-nothing-else
  (let [pid (h/create-test-project admin-request "P")]
    (testing "a reset cannot be combined with grants or made multi-use"
      (assert-bad-request (mint! admin-request {:target-user-id "user1@example.com"
                                                :grant-admin true}))
      (assert-bad-request (mint! admin-request {:target-user-id "user1@example.com"
                                                :project-id pid :project-role "reader"}))
      (assert-bad-request (mint! admin-request {:target-user-id "user1@example.com"
                                                :max-uses 5})))
    (testing "the target must exist and be active"
      (assert-not-found (mint! admin-request {:target-user-id "ghost@example.com"}))
      (let [[gone _] (throwaway-user! "gone@example.com")]
        (api-call admin-request {:method :delete :path (str "/api/v1/users/" gone)})
        ;; A reset link for a deactivated user would be a way to quietly
        ;; hand out a disabled account, so it is refused at mint time.
        (assert-bad-request (mint! admin-request {:target-user-id gone}))))))

;; ---------------------------------------------------------------------------
;; the credential itself never escapes
;; ---------------------------------------------------------------------------

(deftest the-code-is-never-stored-or-re-served
  (let [pid (h/create-test-project admin-request "P")
        resp (mint! admin-request {:project-id pid :project-role "reader"})
        code (-> resp :body :code)
        iid (-> resp :body :id)]
    (testing "the plaintext code is nowhere in the row"
      (let [row (plaid.sql.common/fetch-by-id db :invites iid)]
        (is (not= code (:code_hash row)))
        (is (= (invite/code-hash code) (:code_hash row)))
        (is (nil? (:code row)))))
    (testing "and the digest never reaches the audit log either"
      ;; The audit image is redacted on purpose: it is retained longer and
      ;; read by more people than the invite it describes.
      (let [images (->> (plaid.sql.common/q db {:select [:post_image]
                                                :from [:audit_writes]
                                                :where [:= :target_table "invites"]})
                        (map :post_image)
                        (clojure.string/join " "))]
        (is (seq images))
        (is (not (clojure.string/includes? images "code_hash")))
        (is (not (clojure.string/includes? images (invite/code-hash code))))))
    (testing "no read path serves the code back"
      (let [lr (api-call admin-request {:method :get :path "/api/v1/invites"})]
        (is (not (clojure.string/includes? (pr-str (:body lr)) code)))))))
