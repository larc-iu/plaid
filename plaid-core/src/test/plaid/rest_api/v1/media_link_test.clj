(ns plaid.rest-api.v1.media-link-test
  "Media links: `POST /documents/:id/media/link` answers a URL whose
  `media-token` lets an audio or video element stream one recording without
  an Authorization header. The token opens that recording for its user and
  nothing else, and dies with the session it rides on."
  (:require [buddy.sign.jwt :as jwt]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler rest-handler
                     with-admin with-test-users admin-request user1-request
                     with-clean-db api-call]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.server.config :as config]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        add-project-reader]]
            [ring.mock.request :as mock]
            [taoensso.timbre :as log])
  (:import [java.io File]
           [java.nio.file FileVisitOption Files]
           [java.nio.file.attribute FileAttribute]
           [java.time Instant]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private secret "fake-secret")

(defn- delete-tree! [root]
  (when (Files/exists root (make-array java.nio.file.LinkOption 0))
    (with-open [paths (Files/walk root (make-array FileVisitOption 0))]
      (doseq [path (reverse (vec (.toList paths)))]
        (Files/deleteIfExists path)))))

(defn- with-media-dir*
  "Run `f` with a throwaway database and media directory, `media-cfg` merged
  into the media config."
  [media-cfg f]
  (let [tmp (Files/createTempDirectory "plaid-media-link-" (make-array FileAttribute 0))
        cfg {:plaid.server.sql/config {:main-db-path (str (.resolve tmp "plaid.db"))}
             :plaid.media/config (merge {:max-file-size-mb 200} media-cfg)}]
    (try
      (with-redefs [config/config cfg] (f))
      (finally (delete-tree! tmp)))))

(defn- as [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- anonymous [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")))

(defn- close-body! [response]
  (when-let [body (:body response)]
    (when (instance? java.io.Closeable body) (.close ^java.io.Closeable body)))
  response)

(defn- upload! [did content]
  (let [file (File/createTempFile "plaid-media-link-" ".mp3")]
    (spit file content)
    (.deleteOnExit file)
    (rest-handler (-> (admin-request :put (str "/api/v1/documents/" did "/media"))
                      (assoc :multipart-params
                             {"file" {:filename "clip.mp3" :tempfile file :size (.length file)}})))))

(defn- link! [request-fn did]
  (api-call request-fn {:method :post :path (str "/api/v1/documents/" did "/media/link")}))

(defn- media-token-of [url]
  (second (re-find #"[?&]media-token=([^&]+)" url)))

(defn- get-anon [url]
  (close-body! (rest-handler (anonymous :get url))))

(defn- project-with-media! [name]
  (let [pid (create-test-project admin-request name)
        did (create-test-document admin-request pid "Recording")]
    (is (= 201 (:status (upload! did "0123456789"))))
    [pid did]))

(defn- create-user! [email]
  (api-call admin-request {:method :post :path "/api/v1/users"
                           :body {:email email :password "password123" :is-admin false}}))

(defn- session-of [email]
  (-> (rest-handler (-> (mock/request :post "/api/v1/login")
                        (mock/header "accept" "application/edn")
                        (mock/json-body {:user-id email :password "password123"})))
      :body slurp read-string :token))

(deftest a-link-streams-the-recording-without-a-header
  (with-media-dir* {}
    (fn []
      (let [[_ did] (project-with-media! "Media link project")
            res (link! admin-request did)
            {:keys [url expires-at]} (:body res)
            media-path (str "/api/v1/documents/" did "/media")]
        (is (= 200 (:status res)))
        (testing "the link is the media-url with a media token added"
          (is (str/starts-with? url (str media-path "?v=")))
          (is (some? (media-token-of url))))
        (testing "it expires in six hours by default"
          (let [secs (.getEpochSecond (Instant/parse expires-at))
                now (quot (System/currentTimeMillis) 1000)]
            (is (<= (+ now (* 6 3600) -5) secs (+ now (* 6 3600) 5)))
            (is (= secs (:exp (jwt/unsign (media-token-of url) secret))))))
        (testing "the token names the document and the media audience"
          (let [claims (jwt/unsign (media-token-of url) secret)]
            (is (= "media" (:aud claims)))
            (is (= (str did) (:media/document claims)))
            (is (= "admin@example.com" (:user/id claims)))))
        (testing "a GET through the link needs no header"
          (let [resp (get-anon url)]
            (is (= 200 (:status resp)))
            (is (= "private, max-age=31536000, immutable" (get-in resp [:headers "Cache-Control"])))))
        (testing "a range request through the link is answered 206"
          (let [resp (close-body! (rest-handler (-> (anonymous :get url)
                                                    (assoc-in [:headers "range"] "bytes=2-5"))))]
            (is (= 206 (:status resp)))
            (is (= "bytes 2-5/10" (get-in resp [:headers "Content-Range"])))
            (is (= "private, max-age=31536000, immutable" (get-in resp [:headers "Cache-Control"])))))
        (testing "a matching If-None-Match through the link is 304"
          (let [etag (get-in (get-anon url) [:headers "ETag"])
                resp (rest-handler (-> (anonymous :get url)
                                       (assoc-in [:headers "if-none-match"] etag)))]
            (is (= 304 (:status resp)))))
        (testing "minting writes nothing and refuses an Idempotency-Key"
          (is (= 400 (:status (rest-handler (-> (admin-request :post (str media-path "/link"))
                                                (mock/header "Idempotency-Key" "media-link-1")))))))))))

(deftest a-link-is-refused-without-a-recording-or-read-access
  (with-media-dir* {}
    (fn []
      (let [pid (create-test-project admin-request "No media project")
            did (create-test-document admin-request pid "Silent")]
        (testing "no recording: 404"
          (is (= 404 (:status (link! admin-request did)))))
        (testing "a non-member: 403"
          (is (= 201 (:status (upload! did "abc"))))
          (is (= 403 (:status (link! user1-request did)))))
        (testing "no credential: 401"
          (is (= 401 (:status (link! anonymous did)))))))))

(deftest a-media-token-is-accepted-nowhere-else
  (with-media-dir* {}
    (fn []
      (let [[pid did] (project-with-media! "Media token refusals")
            other (create-test-document admin-request pid "Other recording")
            _ (is (= 201 (:status (upload! other "other bytes"))))
            url (-> (link! admin-request did) :body :url)
            token (media-token-of url)
            media-path (str "/api/v1/documents/" did "/media")]
        (testing "as a bearer token on another route"
          (is (= 401 (:status (api-call (as token) {:method :get :path (str "/api/v1/documents/" did)}))))
          (is (= 401 (:status (api-call (as token) {:method :get :path "/api/v1/projects"})))))
        (testing "as a bearer token on the media route itself"
          (is (= 401 (:status (close-body! (rest-handler ((as token) :get media-path)))))))
        (testing "as ?token= on a stream route and on any other"
          (is (= 401 (:status (rest-handler (anonymous :get (str "/api/v1/projects/" pid "/listen?token=" token))))))
          (is (= 401 (:status (rest-handler (anonymous :get (str media-path "?token=" token)))))))
        (testing "as ?media-token= on any other route"
          (is (= 401 (:status (rest-handler (anonymous :get (str "/api/v1/documents/" did "?media-token=" token))))))
          (is (= 401 (:status (rest-handler (anonymous :post (str media-path "/link?media-token=" token))))))
          (is (= 401 (:status (rest-handler (anonymous :delete (str media-path "?media-token=" token))))))
          (is (= 401 (:status (rest-handler (anonymous :get (str "/api/v1/projects/" pid "/listen?media-token=" token)))))))
        (testing "on another document's recording"
          (is (= 401 (:status (get-anon (str "/api/v1/documents/" other "/media?media-token=" token))))))
        (testing "a login token in the URL opens nothing: it is read from the header only"
          (is (= 401 (:status (rest-handler (anonymous :get (str "/api/v1/projects?token=" fix/admin-token))))))
          (is (= 401 (:status (rest-handler (anonymous :get (str "/api/v1/projects/" pid "/listen?token=" fix/admin-token))))))
          (is (= 401 (:status (get-anon (str media-path "?token=" fix/admin-token))))))
        (testing "given twice, a media token or a query token is no credential, and no 500"
          (is (= 401 (:status (get-anon (str media-path "?media-token=" token "&media-token=" token)))))
          (is (= 401 (:status (rest-handler (anonymous :get (str "/api/v1/projects/" pid "/listen?token=" fix/admin-token "&token=" fix/admin-token)))))))
        (testing "a session token passed as media-token lacks the audience"
          (is (= 401 (:status (get-anon (str media-path "?media-token=" fix/admin-token))))))
        (testing "a media token with the right claims but the wrong signature"
          (let [forged (jwt/sign (dissoc (jwt/unsign token secret) :exp) "another-secret")]
            (is (= 401 (:status (get-anon (str media-path "?media-token=" forged)))))))
        (testing "the link itself still works"
          (is (= 200 (:status (get-anon url)))))))))

(deftest a-link-expires
  (with-media-dir* {:link-ttl-seconds -10}
    (fn []
      (let [[_ did] (project-with-media! "Expired link")
            url (-> (link! admin-request did) :body :url)]
        (is (= 401 (:status (get-anon url))))))))

(deftest a-link-dies-with-its-session-and-its-access
  (with-media-dir* {}
    (fn []
      (let [[pid did] (project-with-media! "Session-bound link")
            email "media-link-reader@example.com"]
        (create-user! email)
        (add-project-reader admin-request pid email)
        (testing "a logout revokes the link"
          (let [session (session-of email)
                url (-> (link! (as session) did) :body :url)]
            (is (= 200 (:status (get-anon url))))
            (is (= 204 (:status (api-call (as session) {:method :post :path "/api/v1/logout"}))))
            (is (= 401 (:status (get-anon url))))))
        (testing "losing access to the project stops the link at once"
          (let [session (session-of email)
                url (-> (link! (as session) did) :body :url)]
            (is (= 200 (:status (get-anon url))))
            (is (= 204 (:status (api-call admin-request
                                          {:method :delete
                                           :path (str "/api/v1/projects/" pid "/readers/" email)}))))
            (is (= 403 (:status (get-anon url))))))
        (testing "a deactivated user's link is refused"
          (add-project-reader admin-request pid email)
          (let [url (-> (link! (as (session-of email)) did) :body :url)]
            (is (= 200 (:status (get-anon url))))
            (is (contains? #{200 204}
                           (:status (api-call admin-request
                                              {:method :delete
                                               :path (str "/api/v1/users/" email)}))))
            (is (= 401 (:status (get-anon url))))))))))

(deftest a-link-does-not-outlive-or-outreach-its-credential
  (with-media-dir* {}
    (fn []
      (let [[pid did] (project-with-media! "Scoped link")
            [qid other] (project-with-media! "Out of scope")
            not-after (+ (quot (System/currentTimeMillis) 1000) 600)
            delegated (auth/issue-delegated-token! fix/db secret "admin@example.com" [pid] not-after)]
        (testing "a scoped caller cannot mint a link outside its scope"
          (is (= 403 (:status (link! (as delegated) other)))))
        (testing "a link minted under a delegated token expires with it and keeps its scope"
          (let [res (link! (as delegated) did)
                claims (jwt/unsign (media-token-of (-> res :body :url)) secret)]
            (is (= 200 (:status res)))
            (is (<= (:exp claims) not-after))
            (is (= [(str/lower-case (str pid))] (:scope/projects claims)))
            (is (= 200 (:status (get-anon (-> res :body :url)))))))
        (testing "a link minted under an API token dies when the token is revoked"
          (let [minted (:body (api-call admin-request {:method :post
                                                       :path "/api/v1/users/admin@example.com/tokens"
                                                       :body {:name "media script"}}))
                url (-> (link! (as (:token minted)) did) :body :url)]
            (is (= 200 (:status (get-anon url))))
            (is (= 204 (:status (api-call admin-request
                                          {:method :delete
                                           :path (str "/api/v1/users/admin@example.com/tokens/" (:id minted))}))))
            (is (= 401 (:status (get-anon url))))))
        (is (some? qid))))))

(deftest two-links-minted-at-once-differ
  (with-media-dir* {}
    (fn []
      (let [[_ did] (project-with-media! "Fresh links")
            a (-> (link! admin-request did) :body :url)
            b (-> (link! admin-request did) :body :url)]
        (is (not= a b))
        (is (= 200 (:status (get-anon a))))
        (is (= 200 (:status (get-anon b))))))))

(deftest the-access-log-redacts-the-media-token
  (with-media-dir* {}
    (fn []
      (let [[_ did] (project-with-media! "Logged link")
            url (-> (link! admin-request did) :body :url)
            token (media-token-of url)
            lines (atom [])
            k ::capture]
        (log/merge-config! {:appenders {k {:enabled? true
                                           :fn (fn [data] (swap! lines conj (force (:msg_ data))))}}})
        (try
          (is (= 200 (:status (get-anon url))))
          ;; The name percent-encoded is the same parameter to the route.
          (is (= 200 (:status (get-anon (str/replace url "media-token=" "media%2Dtoken=")))))
          (finally (log/merge-config! {:appenders {k nil}})))
        (let [blob (str/join "\n" @lines)]
          (is (str/includes? blob "media-token=<redacted>"))
          (is (str/includes? blob "media%2Dtoken=<redacted>"))
          (is (not (str/includes? blob token))))))))
