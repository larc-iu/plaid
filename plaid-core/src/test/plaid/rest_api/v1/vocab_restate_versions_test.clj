(ns plaid.rest-api.v1.vocab-restate-versions-test
  "A deep document read names each linked vocabulary's name and maintainers,
  so a vocabulary rename, a maintainer added or removed, and a user
  deactivation that takes a maintainership away restate every document that
  links the vocabulary. Each bumps those documents' versions and names them in
  X-Document-Versions (R14). A document that links no entry of the vocabulary
  reads the same and keeps its version."
  (:require [clojure.data.json :as json]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler rest-handler
                                    admin-request with-admin api-call
                                    assert-status assert-no-content with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-text-layer
                                        create-token-layer create-text create-token
                                        create-vocab-layer create-vocab-item
                                        create-vocab-link link-vocab-to-project
                                        update-vocab-layer add-vocab-maintainer
                                        remove-vocab-maintainer get-document]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- doc-version [doc]
  (-> (get-document admin-request doc) :body :document/version))

(defn- new-doc! [proj tl tkl doc-name]
  (let [doc (-> (api-call admin-request {:method :post :path "/api/v1/documents"
                                         :body {:project-id proj :name doc-name}})
                :body :id)
        text (-> (create-text admin-request tl doc "cat sat") :body :id)
        tok (-> (create-token admin-request tkl text 0 3) :body :id)]
    {:doc doc :token tok}))

(defn- setup!
  "Two documents linking an entry of `vocab`, and a third in the same project
  linking nothing."
  []
  (let [proj (create-test-project admin-request "Restate")
        tl (-> (create-text-layer admin-request proj "T") :body :id)
        tkl (-> (create-token-layer admin-request tl "W") :body :id)
        vocab (-> (create-vocab-layer admin-request "Lex") :body :id)
        _ (assert-no-content (link-vocab-to-project admin-request proj vocab))
        item (-> (create-vocab-item admin-request vocab "cat") :body :id)
        linked (vec (for [i (range 2)]
                      (let [{:keys [doc token]} (new-doc! proj tl tkl (str "D" i))]
                        (create-vocab-link admin-request item [token])
                        doc)))
        unlinked (:doc (new-doc! proj tl tkl "Bare"))]
    {:vocab vocab :linked linked :unlinked unlinked}))

(defn- header-versions [resp]
  (some-> (get-in resp [:headers "X-Document-Versions"]) json/read-str))

(defn- assert-restated!
  "Every linked document went up by one and the answer names it at its new
  version. The unlinked one kept its version and is not named."
  [{:keys [linked unlinked]} before-linked before-unlinked resp]
  (let [after (mapv doc-version linked)
        named (header-versions resp)]
    (is (= (mapv inc before-linked) after))
    (is (= (zipmap (map str linked) after) named))
    (is (= before-unlinked (doc-version unlinked)))))

(deftest a-rename-bumps-every-linking-document
  (let [{:keys [vocab linked unlinked] :as fx} (setup!)
        before (mapv doc-version linked)
        before-bare (doc-version unlinked)
        resp (update-vocab-layer admin-request vocab {:name "Lexicon"})]
    (assert-status 200 resp)
    (assert-restated! fx before before-bare resp)
    (is (= "Lexicon" (-> (api-call admin-request {:method :get
                                                  :path (str "/api/v1/documents/" (first linked)
                                                             "?include-body=true")})
                         :body :document/text-layers first :text-layer/token-layers first
                         :token-layer/vocabs first :vocab/name)))
    (testing "a rename to the same name restates nothing"
      (let [again (update-vocab-layer admin-request vocab {:name "Lexicon"})]
        (assert-status 200 again)
        (is (nil? (header-versions again)))
        (is (= (mapv inc before) (mapv doc-version linked)))))))

(deftest a-maintainer-change-bumps-every-linking-document
  (let [{:keys [vocab linked unlinked] :as fx} (setup!)
        _ (assert-status 201 (rest-handler (-> (admin-request :post "/api/v1/users")
                                               (mock/json-body {:email "m@example.com"
                                                                :password "hunter22"
                                                                :is-admin false}))))]
    (testing "adding a maintainer"
      (let [before (mapv doc-version linked)
            before-bare (doc-version unlinked)
            resp (add-vocab-maintainer admin-request vocab "m@example.com")]
        (assert-no-content resp)
        (assert-restated! fx before before-bare resp)))
    (testing "adding them again restates nothing"
      (let [before (mapv doc-version linked)
            resp (add-vocab-maintainer admin-request vocab "m@example.com")]
        (assert-no-content resp)
        (is (nil? (header-versions resp)))
        (is (= before (mapv doc-version linked)))))
    (testing "removing a maintainer"
      (let [before (mapv doc-version linked)
            before-bare (doc-version unlinked)
            resp (remove-vocab-maintainer admin-request vocab "m@example.com")]
        (assert-no-content resp)
        (assert-restated! fx before before-bare resp)))))

(deftest a-deactivation-bumps-the-documents-of-every-vocabulary-it-leaves
  (let [{:keys [vocab linked unlinked] :as fx} (setup!)
        _ (assert-status 201 (rest-handler (-> (admin-request :post "/api/v1/users")
                                               (mock/json-body {:email "gone@example.com"
                                                                :password "hunter22"
                                                                :is-admin false}))))
        _ (assert-no-content (add-vocab-maintainer admin-request vocab "gone@example.com"))
        before (mapv doc-version linked)
        before-bare (doc-version unlinked)
        resp (api-call admin-request {:method :delete :path "/api/v1/users/gone@example.com"})]
    (assert-no-content resp)
    (assert-restated! fx before before-bare resp)))
