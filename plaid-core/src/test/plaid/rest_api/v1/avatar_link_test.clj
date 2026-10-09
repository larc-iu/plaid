(ns plaid.rest-api.v1.avatar-link-test
  "Avatar tokens: `POST /avatar-link` answers a token that lets an image
  element load any user's profile picture through `?avatar-token=` without an
  Authorization header. The token opens pictures for its user and nothing
  else, and dies with the session it rides on."
  (:require [buddy.sign.jwt :as jwt]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler rest-handler
                     with-admin with-test-users admin-request user1-request
                     with-clean-db api-call]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.server.config :as config]
            [plaid.test-helpers :refer [create-test-project create-test-document]]
            [ring.mock.request :as mock]
            [taoensso.timbre :as log])
  (:import [java.awt Color]
           [java.awt.image BufferedImage]
           [java.io File]
           [java.time Instant]
           [javax.imageio ImageIO]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private secret "fake-secret")

(defn- temp-image! ^File []
  (let [img (BufferedImage. 64 64 BufferedImage/TYPE_INT_RGB)
        g (.createGraphics img)
        file (File/createTempFile "plaid-avatar-link-" ".png")]
    (.setColor g Color/RED)
    (.fillRect g 0 0 64 64)
    (.dispose g)
    (ImageIO/write img "png" file)
    (.deleteOnExit file)
    file))

(defn- upload!
  "Give `user-id` a picture, as an admin. Returns its hash."
  [user-id]
  (let [file (temp-image!)
        resp (rest-handler (-> (admin-request :put (str "/api/v1/users/" user-id "/avatar"))
                               (assoc :multipart-params
                                      {"file" {:filename "a.png" :tempfile file :size (.length file)}})))]
    (is (= 200 (:status resp)))
    (-> resp fix/parse-response-body :user/avatar-hash)))

(defn- as [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- anonymous [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")))

(defn- mint [request-fn]
  (api-call request-fn {:method :post :path "/api/v1/avatar-link"}))

(defn- token-of [request-fn]
  (-> (mint request-fn) :body :token))

(defn- avatar-path [user-id] (str "/api/v1/users/" user-id "/avatar"))

(defn- get-anon [url]
  (rest-handler (anonymous :get url)))

(defn- picture [user-id token]
  (:status (get-anon (str (avatar-path user-id) "?avatar-token=" token))))

(defn- create-user! [email]
  (api-call admin-request {:method :post :path "/api/v1/users"
                           :body {:email email :password "password123" :is-admin false}}))

(defn- session-of [email]
  (-> (rest-handler (-> (mock/request :post "/api/v1/login")
                        (mock/header "accept" "application/edn")
                        (mock/json-body {:user-id email :password "password123"})))
      :body slurp read-string :token))

(defmacro ^:private with-media-config
  "Run `body` with `m` as the media config. The config state is not started
  in these tests, so this is the whole config."
  [m & body]
  `(with-redefs [config/config {:plaid.media/config ~m}]
     ~@body))

(deftest a-token-shows-any-users-picture-without-a-header
  (let [hash (upload! "user1@example.com")
        _ (upload! "admin@example.com")
        res (mint user1-request)
        {:keys [token expires-at]} (:body res)]
    (is (= 200 (:status res)))
    (testing "it expires in a day by default"
      (let [secs (.getEpochSecond (Instant/parse expires-at))
            now (quot (System/currentTimeMillis) 1000)]
        (is (<= (+ now 86400 -5) secs (+ now 86400 5)))
        (is (= secs (:exp (jwt/unsign token secret))))))
    (testing "the token carries the avatar audience and names no user or document"
      (let [claims (jwt/unsign token secret)]
        (is (= "avatar" (:aud claims)))
        (is (= "user1@example.com" (:user/id claims)))
        (is (not (contains? claims :media/document)))))
    (testing "it opens the caller's own picture and another user's"
      (is (= 200 (picture "user1@example.com" token)))
      (is (= 200 (picture "admin@example.com" token))))
    (testing "with ?v= the picture is cached as immutable"
      (let [resp (get-anon (str (avatar-path "user1@example.com") "?avatar-token=" token "&v=" hash))]
        (is (= 200 (:status resp)))
        (is (= "private, max-age=31536000, immutable" (get-in resp [:headers "Cache-Control"])))))
    (testing "a user with no picture is a 404, an unknown user too"
      (is (= 404 (picture "user2@example.com" token)))
      (is (= 404 (picture "nobody@example.com" token))))
    (testing "minting writes nothing and refuses an Idempotency-Key"
      (is (= 400 (:status (rest-handler (-> (admin-request :post "/api/v1/avatar-link")
                                            (mock/header "Idempotency-Key" "avatar-link-1")))))))
    (testing "no credential: 401"
      (is (= 401 (:status (mint anonymous)))))))

(deftest an-avatar-token-is-accepted-nowhere-else
  (upload! "user1@example.com")
  (let [token (token-of admin-request)
        pid (create-test-project admin-request "Avatar token refusals")
        did (create-test-document admin-request pid "Doc")
        media-path (str "/api/v1/documents/" did "/media")
        pic (avatar-path "user1@example.com")]
    (testing "as a bearer token on the avatar route and elsewhere"
      (is (= 401 (:status (rest-handler ((as token) :get pic)))))
      (is (= 401 (:status (api-call (as token) {:method :get :path "/api/v1/users/user1@example.com"}))))
      (is (= 401 (:status (api-call (as token) {:method :get :path "/api/v1/projects"}))))
      (is (= 401 (:status (mint (as token))))))
    (testing "as ?token= on the avatar route and on a stream route"
      (is (= 401 (:status (get-anon (str pic "?token=" token)))))
      (is (= 401 (:status (get-anon (str "/api/v1/projects/" pid "/listen?token=" token))))))
    (testing "as ?media-token= on the media route"
      (is (= 401 (:status (get-anon (str media-path "?media-token=" token))))))
    (testing "as ?avatar-token= on any other route or method"
      (is (= 401 (:status (get-anon (str "/api/v1/users/user1@example.com?avatar-token=" token)))))
      (is (= 401 (:status (get-anon (str "/api/v1/projects?avatar-token=" token)))))
      (is (= 401 (:status (get-anon (str media-path "?avatar-token=" token)))))
      (is (= 401 (:status (rest-handler (anonymous :delete (str pic "?avatar-token=" token))))))
      (is (= 401 (:status (rest-handler (anonymous :post (str "/api/v1/avatar-link?avatar-token=" token)))))))
    (testing "given twice it is no credential, and no 500"
      (is (= 401 (picture "user1@example.com" (str token "&avatar-token=" token)))))
    (testing "a session token passed as avatar-token lacks the audience"
      (is (= 401 (picture "user1@example.com" fix/admin-token))))
    (testing "an avatar token with the right claims but the wrong signature"
      (let [forged (jwt/sign (dissoc (jwt/unsign token secret) :exp) "another-secret")]
        (is (= 401 (picture "user1@example.com" forged)))))
    (testing "the token itself still works"
      (is (= 200 (picture "user1@example.com" token))))))

(deftest a-media-token-does-not-open-pictures
  (upload! "user1@example.com")
  (let [{media :token} (auth/issue-media-token! fix/db secret "admin@example.com"
                                                (random-uuid) {})
        pic (avatar-path "user1@example.com")]
    (testing "as ?avatar-token="
      (is (= 401 (picture "user1@example.com" media))))
    (testing "as ?media-token= on the avatar route, where it is not read"
      (is (= 401 (:status (get-anon (str pic "?media-token=" media))))))))

(deftest a-token-expires
  (upload! "user1@example.com")
  (with-media-config {:avatar-link-ttl-seconds -10}
    (is (= 401 (picture "user1@example.com" (token-of admin-request))))))

(deftest a-token-does-not-outlive-its-credential
  (with-media-config {:avatar-link-ttl-seconds (* 400 86400)}
    (let [session-exp (:exp (jwt/unsign fix/admin-token secret))
          claims (jwt/unsign (token-of admin-request) secret)]
      (is (= session-exp (:exp claims))))))

(deftest a-token-dies-with-its-session
  (upload! "admin@example.com")
  (let [email "avatar-link-user@example.com"]
    (create-user! email)
    (testing "a logout revokes it"
      (let [session (session-of email)
            token (token-of (as session))]
        (is (= 200 (picture "admin@example.com" token)))
        (is (= 204 (:status (api-call (as session) {:method :post :path "/api/v1/logout"}))))
        (is (= 401 (picture "admin@example.com" token)))))
    (testing "a password change revokes it"
      (let [session (session-of email)
            token (token-of (as session))]
        (is (= 200 (picture "admin@example.com" token)))
        (is (= 200 (:status (api-call admin-request {:method :patch
                                                     :path (str "/api/v1/users/" email)
                                                     :body {:password "password123"}}))))
        (is (= 401 (picture "admin@example.com" token)))))
    (testing "deactivation revokes it"
      (let [token (token-of (as (session-of email)))]
        (is (= 200 (picture "admin@example.com" token)))
        (is (contains? #{200 204} (:status (api-call admin-request
                                                     {:method :delete
                                                      :path (str "/api/v1/users/" email)}))))
        (is (= 401 (picture "admin@example.com" token)))))))

(deftest api-and-scoped-tokens
  (upload! "admin@example.com")
  (testing "a token minted under an API token dies when that token is revoked"
    (let [minted (:body (api-call admin-request {:method :post
                                                 :path "/api/v1/users/admin@example.com/tokens"
                                                 :body {:name "avatar script"}}))
          token (token-of (as (:token minted)))]
      (is (= (str (:id minted)) (:link/api-token (jwt/unsign token secret))))
      (is (= 200 (picture "admin@example.com" token)))
      (is (= 204 (:status (api-call admin-request
                                    {:method :delete
                                     :path (str "/api/v1/users/admin@example.com/tokens/" (:id minted))}))))
      (is (= 401 (picture "admin@example.com" token)))))
  (testing "a token scoped to projects cannot mint one, as it cannot read pictures"
    (let [pid (create-test-project admin-request "Scoped")
          not-after (+ (quot (System/currentTimeMillis) 1000) 600)
          delegated (auth/issue-delegated-token! fix/db secret "admin@example.com" [pid] not-after)]
      (is (= 403 (:status (rest-handler ((as delegated) :get (avatar-path "admin@example.com"))))))
      (is (= 403 (:status (mint (as delegated))))))))

(deftest the-access-log-redacts-the-avatar-token
  (upload! "user1@example.com")
  (let [token (token-of admin-request)
        lines (atom [])
        k ::capture]
    (log/merge-config! {:appenders {k {:enabled? true
                                       :fn (fn [data] (swap! lines conj (force (:msg_ data))))}}})
    (try
      (is (= 200 (picture "user1@example.com" token)))
      (is (= 200 (:status (get-anon (str (avatar-path "user1@example.com") "?avatar%2Dtoken=" token)))))
      (finally (log/merge-config! {:appenders {k nil}})))
    (let [blob (str/join "\n" @lines)]
      (is (str/includes? blob "avatar-token=<redacted>"))
      (is (str/includes? blob "avatar%2Dtoken=<redacted>"))
      (is (not (str/includes? blob token))))))
