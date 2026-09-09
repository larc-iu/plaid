(ns plaid.rest-api.v1.preserve-on-split-test
  "`config.plaid.preserveOnSplit` on a token layer: which metadata keys a
  token born of a split inherits from the token it came from.

  Splitting is the only way a token comes to exist from another one, and the
  new row is otherwise born bare, so anything not named here is gone the
  moment the split happens with nothing left for a later pass to find. See the
  manual's `Metadata Preserved Across a Split` for why this is declared on the
  layer and honored by Plaid rather than left to each app."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request api-call assert-created assert-ok assert-no-content
                                    with-admin with-test-users with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- set-layer-config
  "The config endpoint takes the value as the RAW body, not wrapped."
  [layer-id ns-name k v]
  (api-call admin-request {:method :put
                           :path (str "/api/v1/token-layers/" layer-id "/config/" ns-name "/" k)
                           :body v}))

(defn- token-metadata [token-id]
  (-> (api-call admin-request {:method :get :path (str "/api/v1/tokens/" token-id)})
      :body
      :metadata))

(defn- set-token-metadata [token-id m]
  (api-call admin-request {:method :put
                           :path (str "/api/v1/tokens/" token-id "/metadata")
                           :body m}))

(defn- setup []
  (let [proj (create-test-project admin-request "SplitProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        txt (-> (create-text admin-request tl doc "alphabeta") :body :id)
        tkl (-> (create-token-layer admin-request tl "Words") :body :id)
        tok (-> (create-token admin-request tkl txt 0 9) :body :id)]
    (set-token-metadata tok {"prov" "inferred"
                             "provSource" "service:probe"
                             "form" "alphabeta"
                             "orthog:IPA" "alfabeta"})
    {:layer tkl :token tok}))

(defn- right-half-of [token-id position]
  (-> (split-token admin-request token-id position) :body :id))

(deftest undeclared-layer-leaves-the-new-token-bare
  (let [{:keys [token]} (setup)
        right (right-half-of token 5)]
    ;; The default, and what every layer did before this existed.
    (is (empty? (token-metadata right)))
    ;; The surviving half is the original row and is untouched either way.
    (is (= "service:probe" (get (token-metadata token) "provSource")))))

(deftest declared-keys-are-inherited-and-nothing-else-is
  (let [{:keys [layer token]} (setup)
        _ (assert-no-content (set-layer-config layer "plaid" "preserveOnSplit"
                                               ["prov" "provSource" "provConfirmed"]))
        right (token-metadata (right-half-of token 5))]
    (is (= "inferred" (get right "prov")))
    (is (= "service:probe" (get right "provSource")))
    ;; Not declared, so not carried: they describe text this half does not cover.
    (is (nil? (get right "form")))
    (is (nil? (get right "orthog:IPA")))
    ;; A declared key the token does not have is simply absent.
    (is (nil? (get right "provConfirmed")))))

(deftest a-declaration-naming-nothing-the-token-has-is-harmless
  (let [{:keys [layer token]} (setup)
        _ (assert-no-content (set-layer-config layer "plaid" "preserveOnSplit" ["nosuchkey"]))
        right (right-half-of token 5)]
    (is (empty? (token-metadata right)))))

(deftest a-malformed-declaration-is-ignored-rather-than-fatal
  ;; Config is open, so anything can be written there. A split must not break
  ;; because somebody put the wrong shape in.
  (let [{:keys [layer token]} (setup)
        _ (assert-no-content (set-layer-config layer "plaid" "preserveOnSplit" "prov"))
        right (right-half-of token 5)]
    (is (empty? (token-metadata right)))))
