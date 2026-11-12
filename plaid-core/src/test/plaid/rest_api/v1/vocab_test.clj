(ns plaid.rest-api.v1.vocab-test
  (:require [clojure.test :refer :all]
            [clojure.string]
            [plaid.fixtures :refer [with-db
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-success assert-created assert-ok assert-no-content assert-not-found assert-bad-request
                                    with-admin with-test-users user1-request user2-request with-clean-db]]
            [plaid.fixtures :as fix]
            [plaid.sql.common :as psc]
            [plaid.sql.vocab-layer :as vl]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- home!
  "A fresh project, to be a vocabulary's home."
  []
  (create-test-project admin-request (str "Home " (random-uuid))))

(defn- add-role! [project-id role email]
  (assert-no-content (api-call admin-request {:method :post
                                              :path (str "/api/v1/projects/" project-id "/" role "s/" email)})))

(defn- remove-role! [project-id role email]
  (assert-no-content (api-call admin-request {:method :delete
                                              :path (str "/api/v1/projects/" project-id "/" role "s/" email)})))

(deftest vocab-layer-functionality
  (testing "Vocab layer basic CRUD operations"
    ;; Create vocab layer
    (let [vocab-res (create-vocab-layer admin-request (home!) "Test Vocab Layer")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Get vocab layer
      (let [get-res (get-vocab-layer admin-request vocab-id)]
        (assert-ok get-res)
        (is (= "Test Vocab Layer" (-> get-res :body :vocab/name)))
        (is (= vocab-id (-> get-res :body :vocab/id))))

      ;; Update vocab layer
      (let [update-res (update-vocab-layer admin-request vocab-id {:name "Updated Vocab Layer"})]
        (assert-ok update-res)
        (is (= "Updated Vocab Layer" (-> update-res :body :vocab/name))))

      ;; Delete vocab layer
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (assert-not-found (get-vocab-layer admin-request vocab-id))))

  (testing "Vocab layer config round-trips with mixed-case keys"
    (let [vocab-res (create-vocab-layer admin-request (home!) "Config Vocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Set a config value via the config endpoint, using mixed-case editor/key
      ;; names that XTDB v2 would lowercase if not serialized as a JSON string.
      (assert-no-content
       (api-call admin-request {:method :put
                                :path (str "/api/v1/vocab-layers/" vocab-id "/config/MyEditor/displayName")
                                :body "Lexicon"}))

      ;; Read it back and confirm both the value and the key casing survived.
      (let [get-res (get-vocab-layer admin-request vocab-id)]
        (assert-ok get-res)
        (is (= "Config Vocab" (-> get-res :body :vocab/name)))
        (is (= "Lexicon" (get-in (:body get-res) [:config "MyEditor" "displayName"]))
            "Vocab layer config should preserve mixed-case keys"))

      ;; Removing the key should drop it from config.
      (assert-no-content
       (api-call admin-request {:method :delete
                                :path (str "/api/v1/vocab-layers/" vocab-id "/config/MyEditor/displayName")}))
      (let [get-res (get-vocab-layer admin-request vocab-id)]
        (assert-ok get-res)
        (is (nil? (get-in (:body get-res) [:config "MyEditor" "displayName"]))
            "Removed config key should be gone"))

      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  (testing "Vocab layer access follows its home project's roles"
    (let [home (home!)
          vocab-res (create-vocab-layer admin-request home "Maintainer Test Vocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)
      (is (= (str home) (str (-> (get-vocab-layer admin-request vocab-id) :body :vocab/project))))

      ;; Make user1 a maintainer of the home
      (add-role! home "maintainer" "user1@example.com")

      ;; Verify user1 can now access the vocab
      (assert-ok (get-vocab-layer user1-request vocab-id))

      ;; Verify user2 cannot access the vocab
      (assert-status 403 (get-vocab-layer user2-request vocab-id))

      ;; User1 (as the home's maintainer) can give user2 a role there
      (assert-no-content (api-call user1-request {:method :post
                                                  :path (str "/api/v1/projects/" home "/readers/user2@example.com")}))

      ;; Now user2 can access
      (assert-ok (get-vocab-layer user2-request vocab-id))

      ;; Remove user1 from the home
      (remove-role! home "maintainer" "user1@example.com")

      ;; User1 can no longer access
      (assert-status 403 (get-vocab-layer user1-request vocab-id))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  (testing "Vocab layer authorization edge cases"
    (let [vocab-res (create-vocab-layer admin-request (home!) "Auth Test Vocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Non-admin, non-maintainer cannot access
      (assert-status 403 (get-vocab-layer user1-request vocab-id))
      (assert-status 403 (update-vocab-layer user1-request vocab-id {:name "Hacked"}))
      (assert-status 403 (delete-vocab-layer user1-request vocab-id))

      ;; Cannot move it or list its borrowers without permission
      (assert-status 403 (api-call user1-request {:method :post
                                                  :path (str "/api/v1/vocab-layers/" vocab-id "/move")
                                                  :body {:project-id (home!)}}))
      (assert-status 403 (api-call user1-request {:method :get
                                                  :path (str "/api/v1/vocab-layers/" vocab-id "/borrowers")}))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  (testing "Vocab layer invalid operations"
    ;; Create with duplicate name should work (names not unique globally)
    (let [vocab1-res (create-vocab-layer admin-request (home!) "Duplicate Name")
          vocab1-id (-> vocab1-res :body :id)
          vocab2-res (create-vocab-layer admin-request (home!) "Duplicate Name")
          vocab2-id (-> vocab2-res :body :id)]
      (assert-created vocab1-res)
      (assert-created vocab2-res)
      (is (not= vocab1-id vocab2-id))
      (assert-no-content (delete-vocab-layer admin-request vocab1-id))
      (assert-no-content (delete-vocab-layer admin-request vocab2-id)))

    ;; Operations on non-existent vocab
    (let [fake-id (java.util.UUID/randomUUID)]
      (assert-not-found (get-vocab-layer admin-request fake-id))
      (assert-not-found (update-vocab-layer admin-request fake-id {:name "Test"}))
      (assert-not-found (delete-vocab-layer admin-request fake-id))
      ;; A vocabulary the path names that does not exist is a 404 to an
      ;; admin, as an unknown id is everywhere.
      (assert-not-found (api-call admin-request {:method :get
                                                 :path (str "/api/v1/vocab-layers/" fake-id "/borrowers")}))
      (assert-not-found (api-call admin-request {:method :post
                                                 :path (str "/api/v1/vocab-layers/" fake-id "/move")
                                                 :body {:project-id (home!)}})))))

(deftest vocab-item-functionality
  (let [home (home!)
        vocab-res (create-vocab-layer admin-request home "Test Vocab for Items")
        vocab-id (-> vocab-res :body :id)]
    (assert-created vocab-res)

    (testing "Vocab item basic CRUD operations"
      ;; Create vocab item
      (let [item-res (create-vocab-item admin-request vocab-id "test-word")
            item-id (-> item-res :body :id)]
        (assert-created item-res)

        ;; Get vocab item
        (let [get-res (get-vocab-item admin-request item-id)]
          (assert-ok get-res)
          (is (= "test-word" (-> get-res :body :vocab-item/form)))
          (is (= vocab-id (-> get-res :body :vocab-item/layer)))
          (is (= item-id (-> get-res :body :vocab-item/id))))

        ;; Update vocab item
        (let [update-res (update-vocab-item admin-request item-id "updated-word")]
          (assert-ok update-res)
          (is (= "updated-word" (-> update-res :body :vocab-item/form))))

        ;; Delete vocab item
        (assert-no-content (delete-vocab-item admin-request item-id))
        (assert-not-found (get-vocab-item admin-request item-id))))

    (testing "Vocab item with metadata"
      (let [metadata {"confidence" 0.95 "source" "wordnet" "synonyms" ["test" "exam"]}
            item-res (create-vocab-item admin-request vocab-id "metadata-word" metadata)
            item-id (-> item-res :body :id)]
        (assert-created item-res)

        ;; Verify metadata is returned
        (let [get-res (get-vocab-item admin-request item-id)]
          (assert-ok get-res)
          (is (= "metadata-word" (-> get-res :body :vocab-item/form)))
          (is (= metadata (-> get-res :body :metadata))))

        ;; Update metadata
        (let [new-metadata {"updated" true "confidence" 0.99}]
          (assert-ok (update-vocab-item-metadata admin-request item-id new-metadata))
          (let [updated-res (get-vocab-item admin-request item-id)]
            (assert-ok updated-res)
            (is (= "metadata-word" (-> updated-res :body :vocab-item/form)))
            (is (= new-metadata (-> updated-res :body :metadata)))))

        ;; Delete metadata
        (assert-ok (delete-vocab-item-metadata admin-request item-id))
        (let [no-meta-res (get-vocab-item admin-request item-id)]
          (assert-ok no-meta-res)
          (is (= "metadata-word" (-> no-meta-res :body :vocab-item/form)))
          (is (nil? (-> no-meta-res :body :metadata))))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item-id))))

    (testing "Vocab item authorization through vocab layer"
      ;; Make user1 a maintainer of the vocab's home
      (add-role! home "maintainer" "user1@example.com")

      ;; User1 can create, read, update, delete vocab items
      (let [item-res (create-vocab-item user1-request vocab-id "user1-word")
            item-id (-> item-res :body :id)]
        (assert-created item-res)
        (assert-ok (get-vocab-item user1-request item-id))
        (assert-ok (update-vocab-item user1-request item-id "user1-updated"))
        (assert-no-content (delete-vocab-item user1-request item-id)))

      ;; User2 (not a maintainer) cannot access
      (let [item-res (create-vocab-item admin-request vocab-id "admin-word")
            item-id (-> item-res :body :id)]
        (assert-created item-res)
        (assert-status 403 (get-vocab-item user2-request item-id))
        (assert-status 403 (update-vocab-item user2-request item-id "hacked"))
        (assert-status 403 (update-vocab-item-metadata user2-request item-id {"hacked" true}))
        (assert-status 403 (delete-vocab-item user2-request item-id))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item-id)))

      ;; Remove user1 from the home
      (remove-role! home "maintainer" "user1@example.com")

      ;; User1 can no longer access
      (assert-status 403 (create-vocab-item user1-request vocab-id "should-fail")))

    (testing "Vocab item complex metadata"
      (let [complex-metadata {"string" "value"
                              "number" 42
                              "float" 3.14159
                              "boolean" true
                              "nested" {"inner" "data" "count" 5}
                              "array" [1 "two" true]
                              "mixed" {"numbers" [1 2 3] "flag" false}}
            item-res (create-vocab-item admin-request vocab-id "complex-meta" complex-metadata)
            item-id (-> item-res :body :id)]
        (assert-created item-res)

        (let [get-res (get-vocab-item admin-request item-id)
              returned-metadata (-> get-res :body :metadata)]
          (assert-ok get-res)
          (is (= (count complex-metadata) (count returned-metadata)))
          (doseq [[k v] complex-metadata]
            (is (= v (get returned-metadata k)))))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item-id))))

    (testing "Vocab item edge cases"
      ;; Empty form should be allowed
      (let [empty-res (create-vocab-item admin-request vocab-id "")
            empty-id (-> empty-res :body :id)]
        (assert-created empty-res)
        (is (= "" (-> (get-vocab-item admin-request empty-id) :body :vocab-item/form)))
        (assert-no-content (delete-vocab-item admin-request empty-id)))

      ;; Unicode and special characters
      (let [unicode-form "café résumé naïve 中文 🚀 emoji"
            unicode-res (create-vocab-item admin-request vocab-id unicode-form)
            unicode-id (-> unicode-res :body :id)]
        (assert-created unicode-res)
        (is (= unicode-form (-> (get-vocab-item admin-request unicode-id) :body :vocab-item/form)))
        (assert-no-content (delete-vocab-item admin-request unicode-id)))

      ;; Operations on non-existent item
      (let [fake-id (java.util.UUID/randomUUID)]
        (assert-not-found (get-vocab-item admin-request fake-id))
        (assert-not-found (update-vocab-item admin-request fake-id "test"))
        (assert-not-found (update-vocab-item-metadata admin-request fake-id {"test" true}))
        (assert-not-found (delete-vocab-item-metadata admin-request fake-id))
        (assert-not-found (delete-vocab-item admin-request fake-id))))

    (testing "Vocab layer with include-items parameter"
      ;; Create several items
      (let [item1-res (create-vocab-item admin-request vocab-id "item1")
            item1-id (-> item1-res :body :id)
            item2-res (create-vocab-item admin-request vocab-id "item2")
            item2-id (-> item2-res :body :id)]
        (assert-created item1-res)
        (assert-created item2-res)

        ;; Get vocab without items
        (let [no-items-res (get-vocab-layer admin-request vocab-id)]
          (assert-ok no-items-res)
          (is (nil? (-> no-items-res :body :vocab/items))))

        ;; Get vocab with items
        (let [with-items-res (get-vocab-layer admin-request vocab-id true)]
          (assert-ok with-items-res)
          (let [items (-> with-items-res :body :vocab/items)]
            (is (= 2 (count items)))
            (is (some #(= "item1" (:vocab-item/form %)) items))
            (is (some #(= "item2" (:vocab-item/form %)) items))))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item1-id))
        (assert-no-content (delete-vocab-item admin-request item2-id))))

    ;; Clean up vocab layer
    (assert-no-content (delete-vocab-layer admin-request vocab-id))))

(deftest vocab-link-functionality
  ;; Set up basic infrastructure for vocab-link tests
  (let [proj-res (api-call admin-request {:method :post
                                          :path "/api/v1/projects"
                                          :body {:name "VocabLinkProject"}})
        proj-id (-> proj-res :body :id)
        doc-res (api-call admin-request {:method :post
                                         :path "/api/v1/documents"
                                         :body {:project-id proj-id :name "VocabLinkDoc"}})
        doc-id (-> doc-res :body :id)
        tl-res (api-call admin-request {:method :post
                                        :path "/api/v1/text-layers"
                                        :body {:project-id proj-id :name "VocabLinkTextLayer"}})
        tl-id (-> tl-res :body :id)
        text-res (api-call admin-request {:method :post
                                          :path "/api/v1/texts"
                                          :body {:text-layer-id tl-id
                                                 :document-id doc-id
                                                 :body "hello world test"}})
        text-id (-> text-res :body :id)
        tkl-res (api-call admin-request {:method :post
                                         :path "/api/v1/token-layers"
                                         :body {:text-layer-id tl-id :name "VocabLinkTokenLayer"}})
        tkl-id (-> tkl-res :body :id)
        token1-res (api-call admin-request {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl-id
                                                   :text text-id
                                                   :begin 0 :end 5}}) ; "hello"
        token1-id (-> token1-res :body :id)
        token2-res (api-call admin-request {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl-id
                                                   :text text-id
                                                   :begin 6 :end 11}}) ; "world"
        token2-id (-> token2-res :body :id)
        token3-res (api-call admin-request {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl-id
                                                   :text text-id
                                                   :begin 12 :end 16}}) ; "test"
        token3-id (-> token3-res :body :id)
        vocab-home (home!)
        vocab-res (create-vocab-layer admin-request vocab-home "VocabLinkVocab")
        vocab-id (-> vocab-res :body :id)
        item-res (create-vocab-item admin-request vocab-id "greeting")
        item-id (-> item-res :body :id)]

    (assert-created proj-res)
    (assert-created doc-res)
    (assert-created tl-res)
    (assert-created text-res)
    (assert-created tkl-res)
    (assert-created token1-res)
    (assert-created token2-res)
    (assert-created token3-res)
    (assert-created vocab-res)
    (assert-created item-res)

    ;; The project borrows the vocab (its home is another project) before
    ;; creating vocab links
    (assert-no-content (api-call admin-request {:method :post
                                                :path (str "/api/v1/projects/" proj-id "/vocabs/" vocab-id)}))

    (testing "Vocab link basic operations"
      ;; Create vocab link
      (let [link-res (create-vocab-link admin-request item-id [token1-id])
            link-id (-> link-res :body :id)]
        (assert-created link-res)

        ;; Get vocab link
        (let [get-res (get-vocab-link admin-request link-id)]
          (assert-ok get-res)
          (is (= item-id (-> get-res :body :vocab-link/vocab-item)))
          (is (= [token1-id] (-> get-res :body :vocab-link/tokens)))
          (is (= link-id (-> get-res :body :vocab-link/id))))

        ;; Delete vocab link
        (assert-no-content (delete-vocab-link admin-request link-id))
        (assert-not-found (get-vocab-link admin-request link-id))))

    (testing "Vocab link with multiple tokens"
      ;; Create link with multiple tokens
      (let [link-res (create-vocab-link admin-request item-id [token1-id token2-id])
            link-id (-> link-res :body :id)]
        (assert-created link-res)

        (let [get-res (get-vocab-link admin-request link-id)]
          (assert-ok get-res)
          (is (= [token1-id token2-id] (-> get-res :body :vocab-link/tokens))))

        ;; Clean up
        (assert-no-content (delete-vocab-link admin-request link-id))))

    (testing "Vocab link with metadata"
      (let [metadata {"confidence" 0.87 "annotator" "human" "notes" "checked by expert"}
            link-res (create-vocab-link admin-request item-id [token3-id] metadata)
            link-id (-> link-res :body :id)]
        (assert-created link-res)

        ;; Verify metadata is returned
        (let [get-res (get-vocab-link admin-request link-id)]
          (assert-ok get-res)
          (is (= metadata (-> get-res :body :metadata))))

        ;; Update metadata
        (let [new-metadata {"updated" true "confidence" 0.95}]
          (assert-ok (update-vocab-link-metadata admin-request link-id new-metadata))
          (let [updated-res (get-vocab-link admin-request link-id)]
            (assert-ok updated-res)
            (is (= new-metadata (-> updated-res :body :metadata)))))

        ;; Delete metadata
        (assert-ok (delete-vocab-link-metadata admin-request link-id))
        (let [no-meta-res (get-vocab-link admin-request link-id)]
          (assert-ok no-meta-res)
          (is (nil? (-> no-meta-res :body :metadata))))

        ;; Clean up
        (assert-no-content (delete-vocab-link admin-request link-id))))

    (testing "Vocab link dual authorization - project write + vocab read"
      ;; First unlink vocab from project to test initial authorization
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/projects/" proj-id "/vocabs/" vocab-id)}))

      ;; Add user1 as project writer, with no role in the vocab's home
      (let [add-writer-res (api-call admin-request {:method :post
                                                    :path (str "/api/v1/projects/" proj-id "/writers/user1@example.com")})]
        (assert-no-content add-writer-res))

      ;; Add user2 as maintainer of the vocab's home but not project member
      (add-role! vocab-home "maintainer" "user2@example.com")

      ;; User1 has project write but the vocab is not linked - should fail
      (assert-status 403 (create-vocab-link user1-request item-id [token1-id]))

      ;; User2 has vocab read but no project write - should fail
      (assert-status 403 (create-vocab-link user2-request item-id [token1-id]))

      ;; Add vocab to project so user1 gets vocab access
      (let [update-proj-res (api-call admin-request {:method :post
                                                     :path (str "/api/v1/projects/" proj-id "/vocabs/" vocab-id)})]
        (assert-no-content update-proj-res))

      ;; Now user1 should be able to create vocab links (project write + vocab read through project)
      (let [link-res (create-vocab-link user1-request item-id [token2-id])
            link-id (-> link-res :body :id)]
        (assert-created link-res)

        ;; User1 can also read and delete the link
        (assert-ok (get-vocab-link user1-request link-id))
        (assert-no-content (delete-vocab-link user1-request link-id)))

      ;; User2 still cannot create links (vocab read but no project write)
      (assert-status 403 (create-vocab-link user2-request item-id [token3-id]))

      ;; Add user2 as project writer
      (let [add-writer2-res (api-call admin-request {:method :post
                                                     :path (str "/api/v1/projects/" proj-id "/writers/user2@example.com")})]
        (assert-no-content add-writer2-res))

      ;; Now user2 can create links (project write + vocab read as maintainer)
      (let [link-res (create-vocab-link user2-request item-id [token3-id])
            link-id (-> link-res :body :id)]
        (assert-created link-res)
        (assert-no-content (delete-vocab-link user2-request link-id))))

    (testing "Vocab link edge cases"
      ;; Create link to non-existent vocab item — must fail *because the item is missing*,
      ;; not because of some incidental 400 (e.g. project-not-linked).
      (let [fake-item-id (java.util.UUID/randomUUID)
            res (create-vocab-link admin-request fake-item-id [token1-id])]
        (assert-bad-request res)
        (is (clojure.string/includes? (-> res :body :error) "Vocab item")
            "Error should identify the missing vocab item"))

      ;; Create link to non-existent token — must fail *because of the token reference*
      (let [fake-token-id (java.util.UUID/randomUUID)
            res (create-vocab-link admin-request item-id [fake-token-id])]
        (assert-bad-request res)
        (is (= (str "Token not found with id `" fake-token-id "`") (-> res :body :error))
            "Error should name the token that does not exist"))

      ;; Create link with empty token list — must fail *because the list is empty*
      (let [res (create-vocab-link admin-request item-id [])]
        (assert-bad-request res)
        (is (clojure.string/includes? (-> res :body :error) "at least one token")
            "Error should be about requiring at least one token"))

      ;; Operations on non-existent link
      (let [fake-link-id (java.util.UUID/randomUUID)]
        (assert-not-found (get-vocab-link admin-request fake-link-id))
        (assert-not-found (update-vocab-link-metadata admin-request fake-link-id {"test" true}))
        (assert-not-found (delete-vocab-link-metadata admin-request fake-link-id))
        (assert-not-found (delete-vocab-link admin-request fake-link-id))))

    (testing "Vocab link cross-text + cross-token-layer invariants"
      ;; Build a second token-layer ON THE SAME text-layer/text, plus a
      ;; second text-layer (with its own text + token-layer + token) in
      ;; the SAME document. This lets us exercise both cross-layer and
      ;; cross-text rejection paths inside one document.
      (let [tkl2-res (api-call admin-request {:method :post
                                              :path "/api/v1/token-layers"
                                              :body {:text-layer-id tl-id
                                                     :name "VocabLinkTokenLayer2"}})
            tkl2-id (-> tkl2-res :body :id)
            ;; Token on the second token-layer, same text — spans "hello"
            other-layer-token-res (api-call admin-request
                                            {:method :post
                                             :path "/api/v1/tokens"
                                             :body {:token-layer-id tkl2-id
                                                    :text text-id
                                                    :begin 0 :end 5}})
            other-layer-token-id (-> other-layer-token-res :body :id)
            ;; A second text-layer + text + token-layer + token in the
            ;; same document.
            tl2-res (api-call admin-request {:method :post
                                             :path "/api/v1/text-layers"
                                             :body {:project-id proj-id
                                                    :name "VocabLinkTextLayer2"}})
            tl2-id (-> tl2-res :body :id)
            text2-res (api-call admin-request {:method :post
                                               :path "/api/v1/texts"
                                               :body {:text-layer-id tl2-id
                                                      :document-id doc-id
                                                      :body "second text"}})
            text2-id (-> text2-res :body :id)
            tkl3-res (api-call admin-request {:method :post
                                              :path "/api/v1/token-layers"
                                              :body {:text-layer-id tl2-id
                                                     :name "VocabLinkTokenLayer3"}})
            tkl3-id (-> tkl3-res :body :id)
            other-text-token-res (api-call admin-request
                                           {:method :post
                                            :path "/api/v1/tokens"
                                            :body {:token-layer-id tkl3-id
                                                   :text text2-id
                                                   :begin 0 :end 6}})
            other-text-token-id (-> other-text-token-res :body :id)]
        (assert-created tkl2-res)
        (assert-created other-layer-token-res)
        (assert-created tl2-res)
        (assert-created text2-res)
        (assert-created tkl3-res)
        (assert-created other-text-token-res)

        ;; Same text, two different token-layers — must reject.
        (let [res (create-vocab-link admin-request item-id
                                     [token1-id other-layer-token-id])]
          (assert-bad-request res)
          (is (clojure.string/includes? (-> res :body :error) "token layer")
              "Error should call out the cross-token-layer violation"))

        ;; Same document, two different text-layers — must reject.
        (let [res (create-vocab-link admin-request item-id
                                     [token1-id other-text-token-id])]
          (assert-bad-request res)
          (is (or (clojure.string/includes? (-> res :body :error) "text")
                  (clojure.string/includes? (-> res :body :error) "document"))
              "Error should call out the cross-text (or cross-document) violation"))

        ;; Positive control: a vocab-link confined to a single
        ;; (text, token-layer) still works.
        (let [ok-res (create-vocab-link admin-request item-id [token1-id])]
          (assert-created ok-res)
          (assert-no-content (delete-vocab-link admin-request (-> ok-res :body :id))))))

    (testing "Multiple vocab links per token"
      ;; Create multiple vocab items
      (let [item2-res (create-vocab-item admin-request vocab-id "salutation")
            item2-id (-> item2-res :body :id)
            item3-res (create-vocab-item admin-request vocab-id "word")
            item3-id (-> item3-res :body :id)]
        (assert-created item2-res)
        (assert-created item3-res)

        ;; Create multiple links to the same token
        (let [link1-res (create-vocab-link admin-request item-id [token1-id]) ; "greeting" -> "hello"
              link1-id (-> link1-res :body :id)
              link2-res (create-vocab-link admin-request item2-id [token1-id]) ; "salutation" -> "hello"
              link2-id (-> link2-res :body :id)
              link3-res (create-vocab-link admin-request item3-id [token1-id]) ; "word" -> "hello"
              link3-id (-> link3-res :body :id)]
          (assert-created link1-res)
          (assert-created link2-res)
          (assert-created link3-res)

          ;; Verify all links exist and point to the same token
          (is (= [token1-id] (-> (get-vocab-link admin-request link1-id) :body :vocab-link/tokens)))
          (is (= [token1-id] (-> (get-vocab-link admin-request link2-id) :body :vocab-link/tokens)))
          (is (= [token1-id] (-> (get-vocab-link admin-request link3-id) :body :vocab-link/tokens)))

          ;; Clean up
          (assert-no-content (delete-vocab-link admin-request link1-id))
          (assert-no-content (delete-vocab-link admin-request link2-id))
          (assert-no-content (delete-vocab-link admin-request link3-id))
          (assert-no-content (delete-vocab-item admin-request item2-id))
          (assert-no-content (delete-vocab-item admin-request item3-id)))))

    ;; Clean up: the borrowing ends before the vocab can be deleted
    (assert-no-content (delete-vocab-item admin-request item-id))
    (assert-no-content (unlink-vocab-from-project admin-request proj-id vocab-id))
    (assert-no-content (delete-vocab-layer admin-request vocab-id))
    (assert-no-content (delete-test-project admin-request proj-id))
    (assert-no-content (delete-test-project admin-request vocab-home))))

(deftest vocab-integration-scenarios
  (testing "Document enhancement with vocab data - token-layer/vocabs"
    ;; Set up project with vocab
    (let [proj-id (create-test-project admin-request "IntegrationProject")
          doc-id (create-test-document admin-request proj-id "IntegrationDoc")
          tl-res (api-call admin-request {:method :post
                                          :path "/api/v1/text-layers"
                                          :body {:project-id proj-id :name "IntegrationTextLayer"}})
          tl-id (-> tl-res :body :id)
          text-res (api-call admin-request {:method :post
                                            :path "/api/v1/texts"
                                            :body {:text-layer-id tl-id
                                                   :document-id doc-id
                                                   :body "The quick brown fox"}})
          text-id (-> text-res :body :id)
          tkl-res (api-call admin-request {:method :post
                                           :path "/api/v1/token-layers"
                                           :body {:text-layer-id tl-id :name "IntegrationTokenLayer"}})
          tkl-id (-> tkl-res :body :id)
          token1-res (api-call admin-request {:method :post
                                              :path "/api/v1/tokens"
                                              :body {:token-layer-id tkl-id
                                                     :text text-id
                                                     :begin 0 :end 3}}) ; "The"
          token1-id (-> token1-res :body :id)
          token2-res (api-call admin-request {:method :post
                                              :path "/api/v1/tokens"
                                              :body {:token-layer-id tkl-id
                                                     :text text-id
                                                     :begin 4 :end 9}}) ; "quick"
          token2-id (-> token2-res :body :id)
          token3-res (api-call admin-request {:method :post
                                              :path "/api/v1/tokens"
                                              :body {:token-layer-id tkl-id
                                                     :text text-id
                                                     :begin 10 :end 15}}) ; "brown"
          token3-id (-> token3-res :body :id)
          token4-res (api-call admin-request {:method :post
                                              :path "/api/v1/tokens"
                                              :body {:token-layer-id tkl-id
                                                     :text text-id
                                                     :begin 16 :end 19}}) ; "fox"
          token4-id (-> token4-res :body :id)

          ;; Create vocab layers and items
          vocab1-res (create-vocab-layer admin-request proj-id "Articles")
          vocab1-id (-> vocab1-res :body :id)
          vocab2-res (create-vocab-layer admin-request proj-id "Adjectives")
          vocab2-id (-> vocab2-res :body :id)
          vocab3-res (create-vocab-layer admin-request proj-id "Animals")
          vocab3-id (-> vocab3-res :body :id)

          article-item-res (create-vocab-item admin-request vocab1-id "definite-article" {"pos" "DT"})
          article-item-id (-> article-item-res :body :id)
          adjective1-res (create-vocab-item admin-request vocab2-id "speed-adjective" {"semantic" "velocity"})
          adjective1-id (-> adjective1-res :body :id)
          adjective2-res (create-vocab-item admin-request vocab2-id "color-adjective" {"semantic" "color"})
          adjective2-id (-> adjective2-res :body :id)
          animal-item-res (create-vocab-item admin-request vocab3-id "canine" {"species" "vulpes"})
          animal-item-id (-> animal-item-res :body :id)]

      (assert-created tl-res)
      (assert-created text-res)
      (assert-created tkl-res)
      (assert-created token1-res)
      (assert-created token2-res)
      (assert-created token3-res)
      (assert-created token4-res)
      (assert-created vocab1-res)
      (assert-created vocab2-res)
      (assert-created vocab3-res)
      (assert-created article-item-res)
      (assert-created adjective1-res)
      (assert-created adjective2-res)
      (assert-created animal-item-res)

      ;; Create vocab links
      (let [link1-res (create-vocab-link admin-request article-item-id [token1-id] {"confidence" 1.0})
            link1-id (-> link1-res :body :id)
            link2-res (create-vocab-link admin-request adjective1-id [token2-id] {"confidence" 0.9})
            link2-id (-> link2-res :body :id)
            link3-res (create-vocab-link admin-request adjective2-id [token3-id] {"confidence" 0.95})
            link3-id (-> link3-res :body :id)
            link4-res (create-vocab-link admin-request animal-item-id [token4-id] {"confidence" 0.87})
            link4-id (-> link4-res :body :id)]

        (assert-created link1-res)
        (assert-created link2-res)
        (assert-created link3-res)
        (assert-created link4-res)

        ;; Get document with layer data to check vocab enhancement
        (let [doc-with-layers-res (api-call admin-request {:method :get
                                                           :path (str "/api/v1/documents/" doc-id "?include-body=true")})
              doc-data (-> doc-with-layers-res :body)
              text-layer (-> doc-data :document/text-layers first)
              token-layer (-> text-layer :text-layer/token-layers first)
              vocabs (-> token-layer :token-layer/vocabs)]

          (assert-ok doc-with-layers-res)

          ;; Verify vocab structure is correct
          (is (= 3 (count vocabs))) ; Three vocab layers

          ;; Check each vocab layer has correct structure
          (doseq [vocab vocabs]
            (is (contains? vocab :vocab/id))
            (is (contains? vocab :vocab/name))
            (is (contains? vocab :vocab-layer/vocab-links))
            ;; Guard: every vocab here has at least one link, so the per-link
            ;; assertions below cannot be vacuously skipped by an empty list.
            (is (seq (:vocab-layer/vocab-links vocab))
                (str "Vocab '" (:vocab/name vocab) "' should have at least one link"))

            ;; Each vocab-link should have expanded vocab-item
            (doseq [link (:vocab-layer/vocab-links vocab)]
              (is (contains? link :vocab-link/id))
              (is (contains? link :vocab-link/tokens))
              (is (contains? link :vocab-link/vocab-item))
              (is (map? (:vocab-link/vocab-item link))) ; Should be expanded, not just UUID
              (is (contains? (:vocab-link/vocab-item link) :vocab-item/form))))

          ;; Verify specific vocab content
          (let [articles-vocab (first (filter #(= "Articles" (:vocab/name %)) vocabs))
                adjectives-vocab (first (filter #(= "Adjectives" (:vocab/name %)) vocabs))
                animals-vocab (first (filter #(= "Animals" (:vocab/name %)) vocabs))]

            ;; Articles vocab should have one link
            (is (= 1 (count (:vocab-layer/vocab-links articles-vocab))))
            (let [article-link (first (:vocab-layer/vocab-links articles-vocab))]
              (is (= "definite-article" (get-in article-link [:vocab-link/vocab-item :vocab-item/form])))
              (is (= [token1-id] (:vocab-link/tokens article-link)))
              (is (= {"confidence" 1.0} (:metadata article-link))))

            ;; Adjectives vocab should have two links — verify *which* items/tokens
            ;; they expand to, not just the count (a swap would otherwise pass).
            (is (= 2 (count (:vocab-layer/vocab-links adjectives-vocab))))
            (let [adj-links (:vocab-layer/vocab-links adjectives-vocab)
                  by-form (into {} (map (fn [l] [(get-in l [:vocab-link/vocab-item :vocab-item/form]) l])
                                        adj-links))]
              (is (= #{"speed-adjective" "color-adjective"} (set (keys by-form)))
                  "Adjectives links should expand to both adjective items")
              (is (= [token2-id] (:vocab-link/tokens (by-form "speed-adjective"))))
              (is (= [token3-id] (:vocab-link/tokens (by-form "color-adjective")))))

            ;; Animals vocab should have one link
            (is (= 1 (count (:vocab-layer/vocab-links animals-vocab))))
            (let [animal-link (first (:vocab-layer/vocab-links animals-vocab))]
              (is (= "canine" (get-in animal-link [:vocab-link/vocab-item :vocab-item/form])))
              (is (= [token4-id] (:vocab-link/tokens animal-link)))))

          ;; Clean up
          (assert-no-content (delete-vocab-link admin-request link1-id))
          (assert-no-content (delete-vocab-link admin-request link2-id))
          (assert-no-content (delete-vocab-link admin-request link3-id))
          (assert-no-content (delete-vocab-link admin-request link4-id)))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request article-item-id))
        (assert-no-content (delete-vocab-item admin-request adjective1-id))
        (assert-no-content (delete-vocab-item admin-request adjective2-id))
        (assert-no-content (delete-vocab-item admin-request animal-item-id))
        (assert-no-content (delete-vocab-layer admin-request vocab1-id))
        (assert-no-content (delete-vocab-layer admin-request vocab2-id))
        (assert-no-content (delete-vocab-layer admin-request vocab3-id))
        (delete-test-project admin-request proj-id))))

  (testing "Cross-project vocab access through project configuration"
    ;; Create two projects and one shared vocab, whose home is a third
    ;; project user1 has no role in
    (let [proj1-id (create-test-project admin-request "Project1")
          proj2-id (create-test-project admin-request "Project2")
          shared-home (home!)
          shared-vocab-res (create-vocab-layer admin-request shared-home "SharedVocab")
          shared-vocab-id (-> shared-vocab-res :body :id)
          item-res (create-vocab-item admin-request shared-vocab-id "shared-term")
          item-id (-> item-res :body :id)]

      (assert-created shared-vocab-res)
      (assert-created item-res)

      ;; Add user1 as writer to both projects
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj1-id "/writers/user1@example.com")}))
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj2-id "/writers/user1@example.com")}))

      ;; Initially user1 cannot access the vocab
      (assert-status 403 (get-vocab-layer user1-request shared-vocab-id))
      (assert-status 403 (get-vocab-item user1-request item-id))

      ;; Add shared vocab to project1
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj1-id "/vocabs/" shared-vocab-id)}))

      ;; Now user1 can access vocab through project1
      (assert-ok (get-vocab-layer user1-request shared-vocab-id))
      (assert-ok (get-vocab-item user1-request item-id))

      ;; Add shared vocab to project2 as well
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj2-id "/vocabs/" shared-vocab-id)}))

      ;; User1 still has access (through either project)
      (assert-ok (get-vocab-layer user1-request shared-vocab-id))

      ;; Remove vocab from project1
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/projects/" proj1-id "/vocabs/" shared-vocab-id)}))

      ;; User1 still has access through project2
      (assert-ok (get-vocab-layer user1-request shared-vocab-id))

      ;; Remove vocab from project2
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/projects/" proj2-id "/vocabs/" shared-vocab-id)}))

      ;; Now user1 loses access
      (assert-status 403 (get-vocab-layer user1-request shared-vocab-id))

      ;; Clean up
      (assert-no-content (delete-vocab-item admin-request item-id))
      (assert-no-content (delete-vocab-layer admin-request shared-vocab-id))
      (delete-test-project admin-request proj1-id)
      (delete-test-project admin-request proj2-id)))

  (testing "Cascading deletion - vocab layer affects items and links"
    ;; Create infrastructure
    (let [proj-id (create-test-project admin-request "CascadeProject")
          doc-id (create-test-document admin-request proj-id "CascadeDoc")
          tl-res (api-call admin-request {:method :post
                                          :path "/api/v1/text-layers"
                                          :body {:project-id proj-id :name "CascadeTextLayer"}})
          tl-id (-> tl-res :body :id)
          text-res (api-call admin-request {:method :post
                                            :path "/api/v1/texts"
                                            :body {:text-layer-id tl-id
                                                   :document-id doc-id
                                                   :body "test word"}})
          text-id (-> text-res :body :id)
          tkl-res (api-call admin-request {:method :post
                                           :path "/api/v1/token-layers"
                                           :body {:text-layer-id tl-id :name "CascadeTokenLayer"}})
          tkl-id (-> tkl-res :body :id)
          token-res (api-call admin-request {:method :post
                                             :path "/api/v1/tokens"
                                             :body {:token-layer-id tkl-id
                                                    :text text-id
                                                    :begin 0 :end 4}}) ; "test"
          token-id (-> token-res :body :id)
          vocab-res (create-vocab-layer admin-request proj-id "CascadeVocab")
          vocab-id (-> vocab-res :body :id)]

      (assert-created tl-res)
      (assert-created text-res)
      (assert-created tkl-res)
      (assert-created token-res)
      (assert-created vocab-res)

      ;; Create vocab items and links
      (let [item1-res (create-vocab-item admin-request vocab-id "term1")
            item1-id (-> item1-res :body :id)
            item2-res (create-vocab-item admin-request vocab-id "term2")
            item2-id (-> item2-res :body :id)
            link1-res (create-vocab-link admin-request item1-id [token-id])
            link1-id (-> link1-res :body :id)
            link2-res (create-vocab-link admin-request item2-id [token-id])
            link2-id (-> link2-res :body :id)]

        (assert-created item1-res)
        (assert-created item2-res)
        (assert-created link1-res)
        (assert-created link2-res)

        ;; Verify everything exists
        (assert-ok (get-vocab-layer admin-request vocab-id))
        (assert-ok (get-vocab-item admin-request item1-id))
        (assert-ok (get-vocab-item admin-request item2-id))
        (assert-ok (get-vocab-link admin-request link1-id))
        (assert-ok (get-vocab-link admin-request link2-id))

        ;; Delete vocab layer - should cascade to items and links
        (assert-no-content (delete-vocab-layer admin-request vocab-id))

        ;; Verify everything is gone
        (assert-not-found (get-vocab-layer admin-request vocab-id))
        (assert-not-found (get-vocab-item admin-request item1-id))
        (assert-not-found (get-vocab-item admin-request item2-id))
        (assert-not-found (get-vocab-link admin-request link1-id))
        (assert-not-found (get-vocab-link admin-request link2-id)))

      ;; Clean up
      (delete-test-project admin-request proj-id))))

(deftest vocab-edge-cases
  (testing "Complex unicode and special characters in vocab forms"
    (let [vocab-res (create-vocab-layer admin-request (home!) "UnicodeVocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Test various unicode and special character forms
      (let [test-forms ["café résumé" ; Accented characters
                        "中文词汇" ; Chinese characters
                        "العربية" ; Arabic text
                        "🚀🎉💻" ; Emojis
                        "math: ∀x∈ℝ, x²≥0" ; Mathematical symbols
                        "quotes: \"double\" 'single'" ; Quotes
                        "symbols: @#$%^&*()_+-={}[]|\\:;\"'<>?,./" ; Special chars
                        "" ; Empty string
                        "   spaces   " ; Leading/trailing spaces
                        "\t\n\r" ; Whitespace chars
                        "very" (apply str (repeat 1000 "long"))]] ; Very long string

        (doseq [form test-forms]
          (let [item-res (create-vocab-item admin-request vocab-id form)
                item-id (-> item-res :body :id)]
            (assert-created item-res)
            (let [get-res (get-vocab-item admin-request item-id)]
              (assert-ok get-res)
              (is (= form (-> get-res :body :vocab-item/form))))
            (assert-no-content (delete-vocab-item admin-request item-id)))))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  (testing "Large metadata structures and boundary conditions"
    (let [vocab-res (create-vocab-layer admin-request (home!) "MetadataTestVocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Test very large metadata
      (let [large-metadata (into {} (for [i (range 100)]
                                      [(str "key" i) (str "value" i)]))
            item-res (create-vocab-item admin-request vocab-id "large-meta-item" large-metadata)
            item-id (-> item-res :body :id)]
        (assert-created item-res)
        (let [get-res (get-vocab-item admin-request item-id)]
          (assert-ok get-res)
          (is (= 100 (count (-> get-res :body :metadata)))))
        (assert-no-content (delete-vocab-item admin-request item-id)))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  (testing "Permission edge cases and complex inheritance"
    ;; Test complex permission scenarios: the vocab's home is a third
    ;; project, which user1 maintains, and the others borrow it
    (let [home (home!)
          vocab-res (create-vocab-layer admin-request home "PermissionTestVocab")
          vocab-id (-> vocab-res :body :id)
          item-res (create-vocab-item admin-request vocab-id "perm-test-item")
          item-id (-> item-res :body :id)
          proj1-id (create-test-project admin-request "PermProject1")
          proj2-id (create-test-project admin-request "PermProject2")]

      (assert-created vocab-res)
      (assert-created item-res)

      ;; Set up permissions
      (add-role! home "maintainer" "user1@example.com")
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj1-id "/writers/user2@example.com")}))
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj2-id "/maintainers/user2@example.com")}))
      ;; Project1 borrows the vocab
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj1-id "/vocabs/" vocab-id)}))

      ;; Test access patterns
      ;; user1 can access vocab (maintainer of its home)
      (assert-ok (get-vocab-layer user1-request vocab-id))
      (assert-ok (get-vocab-item user1-request item-id))
      (assert-ok (update-vocab-item user1-request item-id "updated-by-user1"))

      ;; user2 reads the vocab through project1 (a writer of a borrowing
      ;; project), and changes no entry: a borrower's members link to it
      (assert-ok (get-vocab-layer user2-request vocab-id))
      (assert-ok (get-vocab-item user2-request item-id))
      (assert-status 403 (update-vocab-item user2-request item-id "updated-by-user2"))
      (assert-status 403 (create-vocab-item user2-request vocab-id "created-by-user2"))
      (assert-status 403 (update-vocab-item-metadata user2-request item-id {"by" "user2"}))

      ;; Remove vocab from project1 - user2 loses access
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/projects/" proj1-id "/vocabs/" vocab-id)}))
      (assert-status 403 (get-vocab-layer user2-request vocab-id))
      (assert-status 403 (get-vocab-item user2-request item-id))

      ;; Project2 borrows it - user2 regains access (as project2 maintainer)
      (assert-no-content (api-call admin-request {:method :post
                                                  :path (str "/api/v1/projects/" proj2-id "/vocabs/" vocab-id)}))
      (assert-ok (get-vocab-layer user2-request vocab-id))
      (assert-ok (get-vocab-item user2-request item-id))

      ;; Clean up: the borrowing ends before the vocab can be deleted
      (assert-no-content (delete-vocab-item admin-request item-id))
      (assert-no-content (unlink-vocab-from-project admin-request proj2-id vocab-id))
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (delete-test-project admin-request proj1-id)
      (delete-test-project admin-request proj2-id)))

  (testing "Invalid requests and malformed data"
    ;; Test various invalid request scenarios
    (let [home (home!)
          vocab-res (create-vocab-layer admin-request home "InvalidTestVocab")
          vocab-id (-> vocab-res :body :id)]
      (assert-created vocab-res)

      ;; Invalid vocab layer operations
      (assert-bad-request (api-call admin-request {:method :post
                                                   :path "/api/v1/vocab-layers"
                                                   :body {:project-id home}})) ; Missing name

      (assert-bad-request (api-call admin-request {:method :post
                                                   :path "/api/v1/vocab-layers"
                                                   :body {:name "" :project-id home}})) ; Empty name

      (assert-bad-request (api-call admin-request {:method :post
                                                   :path "/api/v1/vocab-layers"
                                                   :body {:name "No home"}})) ; Missing project

      ;; Invalid vocab item operations
      (assert-bad-request (api-call admin-request {:method :post
                                                   :path "/api/v1/vocab-items"
                                                   :body {:vocab-layer-id vocab-id}})) ; Missing form

      (assert-bad-request (api-call admin-request {:method :post
                                                   :path "/api/v1/vocab-items"
                                                   :body {:form "test"}})) ; Missing vocab-layer-id

      (let [fake-vocab-id (java.util.UUID/randomUUID)]
        ;; Missing parent vocab-layer on create returns 400 (per the
        ;; review's consensus across relation/token/vocab-item parent
        ;; checks). Was 404 in pre-cleanup, made symmetric in cleanup.
        (assert-bad-request (api-call admin-request {:method :post
                                                     :path "/api/v1/vocab-items"
                                                     :body {:vocab-layer-id fake-vocab-id
                                                            :form "test"}}))) ; Non-existent vocab

      ;; Invalid vocab link operations
      (let [item-res (create-vocab-item admin-request vocab-id "test-item")
            item-id (-> item-res :body :id)]
        (assert-created item-res)

        (assert-bad-request (api-call admin-request {:method :post
                                                     :path "/api/v1/vocab-links"
                                                     :body {:vocab-item item-id}})) ; Missing tokens

        (assert-bad-request (api-call admin-request {:method :post
                                                     :path "/api/v1/vocab-links"
                                                     :body {:tokens []}})) ; Missing vocab-item-id

        (assert-bad-request (api-call admin-request {:method :post
                                                     :path "/api/v1/vocab-links"
                                                     :body {:vocab-item item-id
                                                            :tokens []}})) ; Empty tokens array

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item-id)))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id)))))

(deftest vocab-link-project-validation
  "Test that vocab link creation fails when project is not linked to vocab layer"
  (testing "vocab link creation should fail if project is not linked to vocab layer"
    (let [project1-id (create-test-project admin-request "Project 1")
          project2-id (create-test-project admin-request "Project 2")
          vocab-id (-> (create-vocab-layer admin-request project1-id "TestVocab") :body :id)
          doc1-id (create-test-document admin-request project1-id "Doc1")
          doc2-id (create-test-document admin-request project2-id "Doc2")

          ;; Create layers and texts for both projects
          txtl1-res (create-text-layer admin-request project1-id "TextLayer1")
          txtl2-res (create-text-layer admin-request project2-id "TextLayer2")
          _ (assert-created txtl1-res)
          _ (assert-created txtl2-res)
          txtl1-id (-> txtl1-res :body :id)
          txtl2-id (-> txtl2-res :body :id)

          tokl1-res (create-token-layer admin-request txtl1-id "TokenLayer1")
          tokl2-res (create-token-layer admin-request txtl2-id "TokenLayer2")
          _ (assert-created tokl1-res)
          _ (assert-created tokl2-res)
          tokl1-id (-> tokl1-res :body :id)
          tokl2-id (-> tokl2-res :body :id)

          text1-res (create-text admin-request txtl1-id doc1-id "Hello world")
          text2-res (create-text admin-request txtl2-id doc2-id "Goodbye world")
          _ (assert-created text1-res)
          _ (assert-created text2-res)
          text1-id (-> text1-res :body :id)
          text2-id (-> text2-res :body :id)

          token1-res (create-token admin-request tokl1-id text1-id 0 5)
          token2-res (create-token admin-request tokl2-id text2-id 0 7)
          _ (assert-created token1-res)
          _ (assert-created token2-res)
          token1-id (-> token1-res :body :id)
          token2-id (-> token2-res :body :id)]

      ;; Create vocab item
      (let [item-res (create-vocab-item admin-request vocab-id "test")
            _ (assert-created item-res)
            item-id (-> item-res :body :id)]

        ;; The vocab is project1's only

        ;; Should succeed: creating vocab link with token from project1 (linked to vocab)
        (let [link-res (create-vocab-link admin-request item-id [token1-id])]
          (assert-created link-res)
          (let [link-id (-> link-res :body :id)]
            ;; Clean up the link
            (assert-no-content (delete-vocab-link admin-request link-id))))

        ;; Should fail: creating vocab link with token from project2 (not linked to vocab)
        (assert-bad-request (create-vocab-link admin-request item-id [token2-id]))

        ;; Clean up
        (assert-no-content (delete-vocab-item admin-request item-id)))

      ;; Clean up projects and vocabs
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (assert-no-content (delete-test-project admin-request project1-id))
      (assert-no-content (delete-test-project admin-request project2-id)))))

(deftest vocab-unlink-cleanup
  "Test that unlinking a vocab from a project that borrows it deletes all associated vocab links"
  (testing "unlinking vocab should delete all vocab links for that project"
    (let [project-id (create-test-project admin-request "TestProject")
          vocab-home (home!)
          vocab-id (-> (create-vocab-layer admin-request vocab-home "TestVocab") :body :id)
          doc-id (create-test-document admin-request project-id "TestDoc")

          ;; Create layers and text
          txtl-res (create-text-layer admin-request project-id "TextLayer")
          _ (assert-created txtl-res)
          txtl-id (-> txtl-res :body :id)

          tokl-res (create-token-layer admin-request txtl-id "TokenLayer")
          _ (assert-created tokl-res)
          tokl-id (-> tokl-res :body :id)

          text-res (create-text admin-request txtl-id doc-id "Hello wonderful world")
          _ (assert-created text-res)
          text-id (-> text-res :body :id)

          ;; Create multiple tokens
          token1-res (create-token admin-request tokl-id text-id 0 5)  ; "Hello"
          token2-res (create-token admin-request tokl-id text-id 6 15) ; "wonderful"
          token3-res (create-token admin-request tokl-id text-id 16 21) ; "world"
          _ (assert-created token1-res)
          _ (assert-created token2-res)
          _ (assert-created token3-res)
          token1-id (-> token1-res :body :id)
          token2-id (-> token2-res :body :id)
          token3-id (-> token3-res :body :id)]

      ;; Create vocab items and link vocab to project
      (let [item1-res (create-vocab-item admin-request vocab-id "greeting")
            item2-res (create-vocab-item admin-request vocab-id "adjective")
            item3-res (create-vocab-item admin-request vocab-id "noun")
            _ (assert-created item1-res)
            _ (assert-created item2-res)
            _ (assert-created item3-res)
            item1-id (-> item1-res :body :id)
            item2-id (-> item2-res :body :id)
            item3-id (-> item3-res :body :id)]

        ;; The project borrows the vocab
        (assert-no-content (api-call admin-request {:method :post
                                                    :path (str "/api/v1/projects/" project-id "/vocabs/" vocab-id)}))

        ;; Create vocab links
        (let [link1-res (create-vocab-link admin-request item1-id [token1-id])
              link2-res (create-vocab-link admin-request item2-id [token2-id])
              link3-res (create-vocab-link admin-request item3-id [token3-id])
              _ (assert-created link1-res)
              _ (assert-created link2-res)
              _ (assert-created link3-res)
              link1-id (-> link1-res :body :id)
              link2-id (-> link2-res :body :id)
              link3-id (-> link3-res :body :id)]

          ;; Verify all vocab links exist
          (assert-ok (get-vocab-link admin-request link1-id))
          (assert-ok (get-vocab-link admin-request link2-id))
          (assert-ok (get-vocab-link admin-request link3-id))

          ;; Unlink vocab from project
          (assert-no-content (api-call admin-request {:method :delete
                                                      :path (str "/api/v1/projects/" project-id "/vocabs/" vocab-id)}))

          ;; Verify all vocab links are gone
          (assert-not-found (get-vocab-link admin-request link1-id))
          (assert-not-found (get-vocab-link admin-request link2-id))
          (assert-not-found (get-vocab-link admin-request link3-id))

          ;; Vocab items should still exist
          (assert-ok (get-vocab-item admin-request item1-id))
          (assert-ok (get-vocab-item admin-request item2-id))
          (assert-ok (get-vocab-item admin-request item3-id)))

        ;; Clean up vocab items
        (assert-no-content (delete-vocab-item admin-request item1-id))
        (assert-no-content (delete-vocab-item admin-request item2-id))
        (assert-no-content (delete-vocab-item admin-request item3-id)))

      ;; Clean up project and vocab
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (assert-no-content (delete-test-project admin-request project-id))
      (assert-no-content (delete-test-project admin-request vocab-home)))))

(deftest vocab-multi-project-scenario
  "Test complex scenario with multiple projects and selective unlinking"
  (testing "unlinking vocab should only affect links from that specific project"
    (let [project1-id (create-test-project admin-request "Project1")
          project2-id (create-test-project admin-request "Project2")
          vocab-id (-> (create-vocab-layer admin-request project2-id "SharedVocab") :body :id)

          ;; Setup project 1
          doc1-id (create-test-document admin-request project1-id "Doc1")
          txtl1-res (create-text-layer admin-request project1-id "TextLayer1")
          _ (assert-created txtl1-res)
          txtl1-id (-> txtl1-res :body :id)
          tokl1-res (create-token-layer admin-request txtl1-id "TokenLayer1")
          _ (assert-created tokl1-res)
          tokl1-id (-> tokl1-res :body :id)
          text1-res (create-text admin-request txtl1-id doc1-id "Hello world")
          _ (assert-created text1-res)
          text1-id (-> text1-res :body :id)
          token1-res (create-token admin-request tokl1-id text1-id 0 5)
          _ (assert-created token1-res)
          token1-id (-> token1-res :body :id)

          ;; Setup project 2
          doc2-id (create-test-document admin-request project2-id "Doc2")
          txtl2-res (create-text-layer admin-request project2-id "TextLayer2")
          _ (assert-created txtl2-res)
          txtl2-id (-> txtl2-res :body :id)
          tokl2-res (create-token-layer admin-request txtl2-id "TokenLayer2")
          _ (assert-created tokl2-res)
          tokl2-id (-> tokl2-res :body :id)
          text2-res (create-text admin-request txtl2-id doc2-id "Hello universe")
          _ (assert-created text2-res)
          text2-id (-> text2-res :body :id)
          token2-res (create-token admin-request tokl2-id text2-id 0 5)
          _ (assert-created token2-res)
          token2-id (-> token2-res :body :id)]

      ;; Create vocab item
      (let [item-res (create-vocab-item admin-request vocab-id "greeting")
            _ (assert-created item-res)
            item-id (-> item-res :body :id)]

        ;; Project1 borrows the vocab of project2
        (assert-no-content (api-call admin-request {:method :post
                                                    :path (str "/api/v1/projects/" project1-id "/vocabs/" vocab-id)}))

        ;; Create vocab links in both projects
        (let [link1-res (create-vocab-link admin-request item-id [token1-id])
              link2-res (create-vocab-link admin-request item-id [token2-id])
              _ (assert-created link1-res)
              _ (assert-created link2-res)
              link1-id (-> link1-res :body :id)
              link2-id (-> link2-res :body :id)]

          ;; Verify both links exist
          (assert-ok (get-vocab-link admin-request link1-id))
          (assert-ok (get-vocab-link admin-request link2-id))

          ;; Unlink vocab from project1 only
          (assert-no-content (api-call admin-request {:method :delete
                                                      :path (str "/api/v1/projects/" project1-id "/vocabs/" vocab-id)}))

          ;; Only project1's link should be gone
          (assert-not-found (get-vocab-link admin-request link1-id))
          (assert-ok (get-vocab-link admin-request link2-id))

          ;; Clean up remaining link
          (assert-no-content (delete-vocab-link admin-request link2-id)))

        ;; Clean up vocab item
        (assert-no-content (delete-vocab-item admin-request item-id)))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (assert-no-content (delete-test-project admin-request project1-id))
      (assert-no-content (delete-test-project admin-request project2-id)))))

(deftest vocab-layer-project-linking
  (testing "Link and unlink vocab layers to projects"
    (let [;; Create two projects and a vocab layer
          proj-a (create-test-project admin-request "VocabLinkProjA")
          proj-b (create-test-project admin-request "VocabLinkProjB")
          proj-c (create-test-project admin-request "VocabLinkProjC")
          vocab-res (create-vocab-layer admin-request proj-c "LinkTestVocab")
          vocab-id (-> vocab-res :body :id)
          _ (assert-created vocab-res)]

      ;; Vocab layer is linked to its home, C, only
      (is (some #(= vocab-id (:vocab/id %)) (-> (get-test-project admin-request proj-c) :body :project/vocabs)))
      ;; Project B borrows it
      (assert-no-content (link-vocab-to-project admin-request proj-b vocab-id))

      ;; Verify project B now lists the vocab, with its home
      (let [proj-b-res (get-test-project admin-request proj-b)]
        (assert-ok proj-b-res)
        (is (some #(= vocab-id (:vocab/id %)) (-> proj-b-res :body :project/vocabs)))
        (is (= (str proj-c) (str (:vocab/project (some #(when (= vocab-id (:vocab/id %)) %)
                                                       (-> proj-b-res :body :project/vocabs)))))))

      ;; Project A should NOT have the vocab
      (let [proj-a-res (get-test-project admin-request proj-a)]
        (assert-ok proj-a-res)
        (is (not (some #(= vocab-id (:vocab/id %)) (-> proj-a-res :body :project/vocabs)))))

      ;; Unlink vocab from project B
      (assert-no-content (unlink-vocab-from-project admin-request proj-b vocab-id))

      ;; Verify project B no longer lists the vocab
      (let [proj-b-res (get-test-project admin-request proj-b)]
        (assert-ok proj-b-res)
        (is (not (some #(= vocab-id (:vocab/id %)) (-> proj-b-res :body :project/vocabs)))))

      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (assert-no-content (delete-test-project admin-request proj-a))
      (assert-no-content (delete-test-project admin-request proj-b))
      (assert-no-content (delete-test-project admin-request proj-c)))))

(deftest vocab-get-accessible-shape-matches-get
  ;; Regression guard for Task #67: `get-accessible` was rewritten from
  ;; an N+1 `(mapv #(get db %) ids)` into a batched hydrator. The REST
  ;; consumer iterates the hydrated records and serializes them, so any
  ;; shape drift breaks `GET /vocab-layers`. Mirrors
  ;; `project-test/get-accessible-shape-matches-get`.
  (testing "batched batch-hydrate-vocab-layers entry equals (get db id)"
    (let [vocab-res (create-vocab-layer admin-request (home!) "Shape Parity Vocab")
          vocab-id (-> vocab-res :body :id)
          _ (assert-created vocab-res)
          db fix/db
          single (vl/get db vocab-id)
          batched-list (vl/batch-hydrate-vocab-layers db [vocab-id])
          batched (first batched-list)]
      (is (some? single)
          "single-id get should return a vocab map")
      (is (some? batched)
          "batch-hydrate-vocab-layers should include the vocab")
      (is (= (set (keys single)) (set (keys batched)))
          "key sets must match")
      (is (= (:vocab/id single) (:vocab/id batched)))
      (is (= (:vocab/name single) (:vocab/name batched)))
      (is (= (:config single) (:config batched)))
      ;; The home is set, so the comparison is not of two nils.
      (is (some? (:vocab/project single)))
      (is (= (:vocab/project single) (:vocab/project batched)))
      ;; Clean up
      (assert-no-content (delete-vocab-layer admin-request vocab-id))))

  (testing "batch-hydrate-vocab-layers returns a vector on empty input"
    (let [db fix/db
          result (vl/batch-hydrate-vocab-layers db [])]
      (is (vector? result)
          "must return a vector (not a lazy seq)"))))

(deftest linking-a-vocab-requires-access-to-its-home
  ;; Linking a vocabulary to a project (borrowing it) lets every member of
  ;; that project read it and link tokens to it, so it takes a maintainer of
  ;; the borrowing project who also holds a role in the vocabulary's home (or
  ;; an admin). Unlinking only withdraws that, so it stays a maintainer act
  ;; of the borrowing project.
  (let [proj (create-test-project admin-request "LinkGateProj")
        other-home (create-test-project admin-request "NotUser1s home")
        own-home (create-test-project admin-request "User1s home")
        other-vocab (-> (create-vocab-layer admin-request other-home "NotUser1s") :body :id)
        own-vocab (-> (create-vocab-layer admin-request own-home "User1s") :body :id)
        item (-> (create-vocab-item admin-request other-vocab "secret") :body :id)
        link-op (fn [vocab-id] {:path (str "/api/v1/projects/" proj "/vocabs/" vocab-id)
                                :method "POST"})]
    (add-role! proj "maintainer" "user1@example.com")
    (add-role! own-home "reader" "user1@example.com")
    (add-role! other-home "maintainer" "user2@example.com")

    (testing "a project maintainer cannot link a vocabulary whose home they have no role in"
      (let [r (link-vocab-to-project user1-request proj other-vocab)]
        (assert-status 403 r)
        (is (= "Linking a vocabulary needs access to the project it belongs to."
               (-> r :body :error))))
      (assert-status 403 (get-vocab-item user1-request item)))

    (testing "nor through a batch"
      (assert-status 403 (api-call user1-request {:method :post :path "/api/v1/batch"
                                                  :body [(link-op other-vocab)]}))
      (assert-status 403 (get-vocab-item user1-request item)))

    (testing "nor can one who reads the vocabulary through another project that borrows it"
      (let [other-proj (create-test-project admin-request "LinkGateOther")]
        (assert-no-content (link-vocab-to-project admin-request other-proj other-vocab))
        (add-role! other-proj "writer" "user1@example.com")
        (assert-ok (get-vocab-item user1-request item))
        (assert-status 403 (link-vocab-to-project user1-request proj other-vocab))
        (remove-role! other-proj "writer" "user1@example.com")
        (assert-status 403 (get-vocab-item user1-request item))))

    (testing "an unknown vocabulary id answers 403 to a non-admin"
      (assert-status 403 (link-vocab-to-project user1-request proj (random-uuid))))

    (testing "a maintainer of the vocabulary's home who does not maintain the project cannot link it"
      (assert-status 403 (link-vocab-to-project user2-request proj other-vocab)))

    (testing "a project maintainer with any role in the vocabulary's home can link it"
      (assert-no-content (link-vocab-to-project user1-request proj own-vocab)))

    (testing "unlinking stays with the project maintainer"
      (assert-no-content (link-vocab-to-project admin-request proj other-vocab))
      (assert-ok (get-vocab-item user1-request item))
      (assert-no-content (unlink-vocab-from-project user1-request proj other-vocab))
      (assert-status 403 (get-vocab-item user1-request item)))))

(deftest vocab-delete-refused-while-another-project-links-it
  ;; R58, kept under the home model: a vocabulary is deleted only when no
  ;; other project links it, whether or not the person deleting can read
  ;; that project. Core is the one that knows every link.
  (let [proj-a (create-test-project admin-request "OnlyInA")
        proj-b (create-test-project admin-request "OnlyInB")
        vocab-id (-> (create-vocab-layer admin-request proj-a "OnlyInVocab") :body :id)]
    (assert-no-content (link-vocab-to-project admin-request proj-b vocab-id))
    (testing "refused while another project links it, and nothing goes"
      (assert-status 409 (delete-vocab-layer admin-request vocab-id))
      (assert-ok (get-vocab-layer admin-request vocab-id)))
    (testing "deleted once only its home links it"
      (assert-no-content (unlink-vocab-from-project admin-request proj-b vocab-id))
      (assert-no-content (delete-vocab-layer admin-request vocab-id))
      (assert-not-found (get-vocab-layer admin-request vocab-id)))
    (assert-no-content (delete-test-project admin-request proj-a))
    (assert-no-content (delete-test-project admin-request proj-b))))

(deftest vocab-delete-refused-while-borrowed
  ;; SEAM-2 under the home model (Luke 2026-11-12): a vocabulary another
  ;; project borrows is not deleted, by its home's maintainer nor by an
  ;; admin. The 409 counts those projects and names none of them. A project
  ;; being deleted stands in no one's way. The dry run answers the same
  ;; refusal, or the links the delete would remove.
  (let [proj-a (create-test-project admin-request "MineA")
        proj-b (create-test-project admin-request "TheirsB")
        proj-c (create-test-project admin-request "TheirsC")
        vocab-id (-> (create-vocab-layer admin-request proj-a "Shared lexicon") :body :id)
        item (-> (create-vocab-item admin-request vocab-id "kai") :body :id)
        linked-doc! (fn [proj]
                      (let [tl (-> (create-text-layer admin-request proj "TL") :body :id)
                            tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
                            doc (create-test-document admin-request proj "Doc")
                            text (-> (create-text admin-request tl doc "kai kai") :body :id)
                            t1 (-> (create-token admin-request tkl text 0 3) :body :id)
                            t2 (-> (create-token admin-request tkl text 4 7) :body :id)]
                        (assert-created (create-vocab-link admin-request item [t1]))
                        (assert-created (create-vocab-link admin-request item [t2]))
                        doc))
        delete! (fn [req & {:keys [dry-run]}]
                  (api-call req {:method :delete
                                 :path (str "/api/v1/vocab-layers/" vocab-id
                                            (when dry-run "?dry-run=true"))}))]
    (linked-doc! proj-a)
    (doseq [p [proj-b proj-c]]
      (assert-no-content (link-vocab-to-project admin-request p vocab-id))
      (linked-doc! p))
    (add-role! proj-a "maintainer" "user1@example.com")
    (add-role! proj-b "reader" "user1@example.com")
    (testing "a member of the home who does not maintain it may not delete it"
      (add-role! proj-a "writer" "user2@example.com")
      (assert-status 403 (delete! user2-request))
      (assert-status 403 (delete! user2-request :dry-run true)))
    (testing "refused while other projects link it, counted and not named, to its maintainer and an admin"
      (doseq [resp [(delete! user1-request) (delete! user1-request :dry-run true)
                    (delete! admin-request) (delete! admin-request :dry-run true)]]
        (assert-status 409 resp)
        (is (= 2 (-> resp :body :other-projects)))
        (is (= "2 other projects use this vocabulary." (-> resp :body :error)))
        (is (not (re-find #"TheirsB|TheirsC" (pr-str (:body resp)))))
        (is (not (re-find (re-pattern (str proj-b "|" proj-c)) (pr-str (:body resp))))))
      (assert-ok (get-vocab-layer admin-request vocab-id))
      (is (= 6 (count (psc/q fix/db {:select [:id] :from [:vocab_links]})))))
    (testing "one project left in the way is said in the singular"
      (assert-no-content (unlink-vocab-from-project admin-request proj-b vocab-id))
      (let [resp (delete! user1-request :dry-run true)]
        (assert-status 409 resp)
        (is (= 1 (-> resp :body :other-projects)))
        (is (= "1 other project uses this vocabulary." (-> resp :body :error)))))
    (testing "a project being deleted stands in no one's way"
      (psc/execute! fix/db {:update :projects :set {:deleted_at "2026-11-11T00:00:00Z"}
                            :where [:= :id proj-c]})
      (let [resp (delete! user1-request :dry-run true)]
        (assert-ok resp)
        (is (= {:links 2} (:body resp)) "the links in the home's documents"))
      (assert-ok (get-vocab-layer admin-request vocab-id)))
    (testing "deleted once no other live project links it"
      (assert-no-content (delete! user1-request))
      (assert-not-found (get-vocab-layer admin-request vocab-id))
      (is (empty? (psc/q fix/db {:select [:id] :from [:vocab_links]})))))
  (testing "an admin deletes a vocabulary no other project links"
    (let [proj (create-test-project admin-request "Elsewhere")
          vocab-id (-> (create-vocab-layer admin-request proj "Admin's") :body :id)]
      (assert-no-content (api-call admin-request {:method :delete
                                                  :path (str "/api/v1/vocab-layers/" vocab-id)}))
      (assert-not-found (get-vocab-layer admin-request vocab-id)))))

(deftest deleting-an-unfinished-import-takes-its-vocabularies
  ;; The unfinished import's Delete (igt UnfinishedImport) deletes the
  ;; project, which takes the vocabularies whose home it is. It is refused
  ;; while another project borrows one of them, until that borrowing ends.
  (let [proj-a (create-test-project admin-request "Import")
        only-a (-> (create-vocab-layer admin-request proj-a "Only in the import") :body :id)
        shared (-> (create-vocab-layer admin-request proj-a "Also elsewhere") :body :id)
        proj-b (create-test-project admin-request "Elsewhere")]
    (add-role! proj-a "maintainer" "user1@example.com")
    (assert-no-content (link-vocab-to-project admin-request proj-b shared))
    (let [resp (delete-test-project user1-request proj-a)]
      (assert-status 409 resp)
      (is (= "1 other project uses a vocabulary of this project." (-> resp :body :error))))
    (assert-ok (get-vocab-layer admin-request only-a))
    (testing "the home's maintainer ends the borrowing, then the project and both vocabularies go"
      (assert-no-content (unlink-vocab-from-project user1-request proj-b shared))
      (assert-no-content (delete-test-project user1-request proj-a))
      (assert-not-found (get-vocab-layer admin-request only-a))
      (assert-not-found (get-vocab-layer admin-request shared)))
    (assert-no-content (delete-test-project admin-request proj-b))))
