(ns plaid.rest-api.v1.vocab-item-merge-test
  "`POST /vocab-items/:id/merge` moves every link of the losers to the
  survivor inside one transaction, so a link made after the caller looked
  is moved rather than deleted with its entry (D7, V6 H6-1). And a delete
  given `expected-link-count` is refused when the entry gained or lost a
  link since the count was shown."
  (:require [clojure.data.json]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request user1-request with-admin with-test-users
                                    api-call assert-status assert-no-content with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-text-layer
                                        create-token-layer create-text create-token
                                        create-vocab-layer create-vocab-item
                                        create-vocab-link link-vocab-to-project
                                        get-document]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- merge! [request-fn survivor losers]
  (api-call request-fn {:method :post
                        :path (str "/api/v1/vocab-items/" survivor "/merge")
                        :body {:losers losers}}))

(defn- links-of [item]
  (->> (psc/q db {:select [:vl.id :vlt.token_id]
                  :from [[:vocab_links :vl]]
                  :join [[:vocab_link_tokens :vlt] [:= :vlt.vocab_link_id :vl.id]]
                  :where [:= :vl.vocab_item_id (str item)]})
       (map (juxt (comp str :id) (comp str :token_id)))
       set))

(defn- item-exists? [id]
  (some? (psc/fetch-by-id db :vocab_items id)))

(defn- doc-version [doc]
  (-> (get-document admin-request doc) :body :document/version))

(defn- setup!
  "Three documents with one word each, two vocabularies linked to the
  project, and entries: `s` (the survivor), `l1`, `l2` in the first, `x` in
  the second."
  []
  (let [proj (create-test-project admin-request "Merge")
        tl (-> (create-text-layer admin-request proj "T") :body :id)
        tkl (-> (create-token-layer admin-request tl "W") :body :id)
        vocab (-> (create-vocab-layer admin-request "Lex") :body :id)
        other (-> (create-vocab-layer admin-request "Other") :body :id)
        _ (assert-no-content (link-vocab-to-project admin-request proj vocab))
        _ (assert-no-content (link-vocab-to-project admin-request proj other))
        docs (vec (for [i (range 3)]
                    (let [doc (-> (api-call admin-request {:method :post :path "/api/v1/documents"
                                                           :body {:project-id proj :name (str "D" i)}})
                                  :body :id)
                          text (-> (create-text admin-request tl doc "cat sat") :body :id)
                          tok (-> (create-token admin-request tkl text 0 3) :body :id)]
                      {:doc doc :token tok})))
        item (fn [v form] (-> (create-vocab-item admin-request v form) :body :id))]
    {:proj proj :vocab vocab :docs docs
     :s (item vocab "cat") :l1 (item vocab "cat") :l2 (item vocab "kat") :x (item other "cat")}))

(defn- link! [item token & [metadata]]
  (-> (if metadata
        (create-vocab-link admin-request item [token] metadata)
        (create-vocab-link admin-request item [token]))
      :body :id))

(deftest a-merge-moves-every-link-and-drops-the-duplicates
  (let [{:keys [docs s l1 l2]} (setup!)
        [t0 t1 t2] (map :token docs)
        s-t0 (link! s t0)
        l1-t1 (link! l1 t1 {"note" "kept"})
        l1-t0 (link! l1 t0)
        ;; Made "after the Preview": the merge reads it inside its own
        ;; transaction, so it moves too.
        l2-t2 (link! l2 t2)
        l2-t1 (link! l2 t1)
        before (mapv (comp doc-version :doc) docs)
        resp (merge! admin-request s [l1 l2])]
    (assert-status 200 resp)
    (is (= {:moved 2 :duplicates 2} (select-keys (:body resp) [:moved :duplicates])))
    (is (= #{(str l1) (str l2)} (set (map str (get-in resp [:body :removed])))))
    (testing "the survivor holds one link per word, the moved ones keeping their ids"
      (is (= #{[(str s-t0) (str t0)] [(str l1-t1) (str t1)] [(str l2-t2) (str t2)]}
             (links-of s))))
    (testing "a moved link keeps its metadata"
      (is (= "kept" (-> (psc/q1 db {:select [:value] :from :entity_metadata
                                    :where [:and [:= :entity_type "vocab-link"]
                                            [:= :entity_id (str l1-t1)] [:= :key "note"]]})
                        :value
                        clojure.data.json/read-str))))
    (testing "the duplicates and the losers are gone"
      (is (nil? (psc/fetch-by-id db :vocab_links l1-t0)))
      (is (nil? (psc/fetch-by-id db :vocab_links l2-t1)))
      (is (not (item-exists? l1)))
      (is (not (item-exists? l2)))
      (is (item-exists? s)))
    (testing "every document that held a loser's link is bumped and told"
      (is (every? true? (map < before (mapv (comp doc-version :doc) docs))))
      (is (some? (get-in resp [:headers "X-Document-Versions"]))))
    (testing "a retry of the same merge changes nothing"
      (let [again (merge! admin-request s [l1 l2])]
        (assert-status 200 again)
        (is (= {:moved 0 :duplicates 0 :removed []} (:body again)))))))

(deftest a-merge-that-cannot-go-changes-nothing
  (let [{:keys [docs s l1 x]} (setup!)
        l1-link (link! l1 (:token (first docs)))]
    (testing "a loser from another vocabulary"
      (assert-status 400 (merge! admin-request s [l1 x]))
      (is (item-exists? l1))
      (is (item-exists? x))
      (is (= #{[(str l1-link) (str (:token (first docs)))]} (links-of l1))))
    (testing "the survivor among the losers"
      (assert-status 400 (merge! admin-request s [s l1])))
    (testing "no losers"
      (assert-status 400 (merge! admin-request s [])))
    (testing "a survivor that is gone"
      (assert-status 404 (merge! admin-request (random-uuid) [l1])))
    (testing "a writer who does not maintain the vocabulary"
      (let [{:keys [proj]} (setup!)]
        (api-call admin-request {:method :post :path (str "/api/v1/projects/" proj "/writers/user1@example.com")})
        (assert-status 403 (merge! user1-request s [l1]))
        (is (item-exists? l1))))))

(deftest a-merge-rolls-back-with-its-batch
  (let [{:keys [docs s l1]} (setup!)
        l1-link (link! l1 (:token (first docs)))
        resp (api-call admin-request
                       {:method :post :path "/api/v1/batch"
                        :body [{:path (str "/api/v1/vocab-items/" s "/merge") :method "POST" :body {:losers [l1]}}
                               {:path (str "/api/v1/vocab-items/" (random-uuid)) :method "DELETE"}]})]
    (is (>= (:status resp) 400))
    (is (item-exists? l1))
    (is (= #{[(str l1-link) (str (:token (first docs)))]} (links-of l1)))))

(deftest a-delete-confirmed-over-a-count-refuses-a-changed-one
  (let [{:keys [docs s]} (setup!)
        del (fn [n] (api-call admin-request {:method :delete
                                             :path (str "/api/v1/vocab-items/" s "?expected-link-count=" n)}))]
    (link! s (:token (first docs)))
    (testing "the dialog said 0 uses, and someone linked a word since"
      (let [resp (del 0)]
        (assert-status 409 resp)
        (is (string? (get-in resp [:body :error])))
        (is (= 1 (get-in resp [:body :links])) "the refusal carries the count it found"))
      (is (item-exists? s))
      (is (= 1 (count (links-of s)))))
    (testing "in a batch the refusal carries the count too"
      (let [resp (api-call admin-request
                           {:method :post :path "/api/v1/batch"
                            :body [{:path (str "/api/v1/vocab-items/" s "?expected-link-count=3") :method "DELETE"}]})]
        (assert-status 409 resp)
        (is (= 1 (get-in resp [:body :links])))))
    (testing "the count shown is the count stored"
      (assert-status 204 (del 1))
      (is (not (item-exists? s))))))

(defn- metadata-of [etype id]
  (into {} (map (fn [{:keys [key value]}] [key (clojure.data.json/read-str value)]))
        (psc/q db {:select [:key :value] :from :entity_metadata
                   :where [:and [:= :entity_type etype] [:= :entity_id (str id)]]})))

(defn- put-metadata! [kind id m]
  (assert-status 200 (api-call admin-request {:method :put
                                              :path (str "/api/v1/" kind "/" id "/metadata")
                                              :body m})))

(deftest a-merge-repoints-every-metadata-reference-to-a-loser
  (let [{:keys [proj vocab docs s l1 l2 x]} (setup!)
        [{d0 :doc t0 :token} {d1 :doc t1 :token}] docs
        ;; A document in a project the vocabulary is not linked to.
        other-proj (create-test-project admin-request "Elsewhere")
        _ (is (some? proj))
        other-doc (-> (api-call admin-request {:method :post :path "/api/v1/documents"
                                               :body {:project-id other-proj :name "E"}})
                      :body :id)
        sl1 (str l1) sl2 (str l2) ss (str s)
        sib (-> (create-vocab-item admin-request vocab "dog") :body :id)]
    ;; An app's own pointer on a token, as a node picked from an entry keeps it.
    (put-metadata! "tokens" t0 {"app" {"entry" sl1 "entryVocab" (str vocab) "var" "s1x"}})
    ;; The same document holds a link that moves.
    (link! l1 t0)
    (put-metadata! "tokens" t1 {"refs" [sl2 ss "other"] "note" (str "about " sl1)})
    (put-metadata! "documents" d1 {"pick" sl2})
    (put-metadata! "documents" other-doc {"pick" sl1})
    (put-metadata! "vocab-items" sib {"seeAlso" [sl1 sl2]})
    (put-metadata! "vocab-items" s {"parent" sl1})
    (put-metadata! "vocab-items" x {"seeAlso" [sl1]})
    (let [before (mapv doc-version [d0 d1])
          resp (merge! admin-request s [l1 l2])]
      (assert-status 200 resp)
      (testing "a pointer to a loser now names the survivor"
        (is (= {"app" {"entry" ss "entryVocab" (str vocab) "var" "s1x"}} (metadata-of "token" t0)))
        (is (= {"pick" ss} (metadata-of "document" d1))))
      (testing "a list that already names the survivor drops the loser, and a mention in prose is no reference"
        (is (= {"refs" [ss "other"] "note" (str "about " sl1)} (metadata-of "token" t1))))
      (testing "another entry of the vocabulary follows the merge, once"
        (is (= {"seeAlso" [ss]} (metadata-of "vocab-item" sib))))
      (testing "the survivor's own reference is the caller's, and other vocabularies and unlinked projects are untouched"
        (is (= {"parent" sl1} (metadata-of "vocab-item" s)))
        (is (= {"seeAlso" [sl1]} (metadata-of "vocab-item" x)))
        (is (= {"pick" sl1} (metadata-of "document" other-doc))))
      (testing "a document whose metadata was rewritten is bumped"
        (is (every? true? (map < before (mapv doc-version [d0 d1])))))
      (testing "the rewrite is in the merge's own audit entry"
        (let [op-id (:id (psc/q1 db {:select [:id] :from :operations
                                     :where [:= :op_type "vocab-item/merge-into"]
                                     :order-by [[:ts :desc]] :limit 1}))
              rows (set (map (juxt :target_table (comp str :target_id) :change_type)
                             (psc/q db {:select [:target_table :target_id :change_type] :from :audit_writes
                                        :where [:= :op_id op-id]})))]
          (is (contains? rows ["tokens" (str t0) "update"]))
          (is (= 1 (count (psc/q db {:select [:id] :from :audit_writes
                                     :where [:and [:= :op_id op-id] [:= :target_id (str d0)]
                                             [:= :change_type "doc-version-bump"]]})))
              "a document with a moved link and a rewritten pointer is bumped once")
          (is (contains? rows ["documents" (str d1) "update"])))))))
