(ns plaid.rest-api.v1.vocab-home-acl-test
  "Who may do what to a vocabulary, its entries and its links, now that a
  vocabulary belongs to one project, its home (VH-SPEC section 1, with the
  owner's rulings of 2026-11-12 in its section 11). Every row of the
  section's tables is a row here, every column a person:

    hm hw hr  maintainer, writer, reader of the home project A
    bm bw br  maintainer, writer, reader of project B, which borrows the
              vocabulary, holding no role in A
    n         signed in, a member of neither
    admin     an administrator

  A cell that changes the world runs on a world of its own, the refusals of a
  row share one."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.sql.common :as psc]
            [plaid.sql.user :as pxu]
            [plaid.test-helpers :as h :refer [id]]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private emails
  {:hm "hm@example.com" :hw "hw@example.com" :hr "hr@example.com"
   :bm "bm@example.com" :bw "bw@example.com" :br "br@example.com"
   :n "n@example.com"})

(def ^:private columns [:hm :hw :hr :bm :bw :br :n :admin])

(defn- token-request [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- as-user [email]
  (when-not (pxu/get-internal fix/db email)
    (pxu/create fix/db email false "a-long-password-1" nil))
  (token-request (auth/issue-session-token! fix/db "fake-secret" email)))

(defn- scoped [email & project-ids]
  (token-request (auth/issue-delegated-token! fix/db "fake-secret" email project-ids)))

(defn- call [who method path & [body]]
  (api-call who (cond-> {:method method :path path} (some? body) (assoc :body body))))

(defn- enc [ts] (java.net.URLEncoder/encode (str ts) "UTF-8"))

(defn- role! [pid role email]
  (fix/assert-no-content (call admin-request :post (str "/api/v1/projects/" pid "/" role "s/" email))))

(defn- doc-with-token!
  "A document in project `pid` with a text layer, a token layer, a text and
  one token. Returns {:doc :tl :text :tok}."
  [pid label]
  (let [txl (id (h/create-text-layer admin-request pid (str label " text")))
        tkl (id (h/create-token-layer admin-request txl (str label " words")))
        doc (h/create-test-document admin-request pid (str label " doc"))
        text (id (h/create-text admin-request txl doc "kai kaj kak kal kam kan"))
        tok (id (h/create-token admin-request tkl text 0 3))]
    {:doc doc :tkl tkl :text text :tok tok}))

(defn- new-token!
  "A fresh token in `place`, so a link created by one cell never meets
  another's."
  [{:keys [tkl text]} n]
  (id (h/create-token admin-request tkl text (* 4 (mod n 6)) (+ 3 (* 4 (mod n 6))))))

(defn world!
  "Projects A (the home), B (borrows V) and C (a second project hm
  maintains). Vocabulary V of A, with entries kai, kaj, kak, a link from a
  token of A's document and one from B's, a comment by bw on kai. A second
  vocabulary V2 of A that nobody borrows. With `:borrowed? false` B does not
  borrow V."
  ([] (world! {}))
  ([{:keys [borrowed?] :or {borrowed? true}}]
   (let [users (into {:admin admin-request} (map (fn [[k e]] [k (as-user e)])) emails)
         a (h/create-test-project admin-request "Home A")
         b (h/create-test-project admin-request "Borrower B")
         c (h/create-test-project admin-request "Target C")
         _ (do (role! a "maintainer" (:hm emails)) (role! a "writer" (:hw emails)) (role! a "reader" (:hr emails))
               (role! b "maintainer" (:bm emails)) (role! b "writer" (:bw emails)) (role! b "reader" (:br emails))
               (role! c "maintainer" (:hm emails)))
         v (id (call (:hm users) :post "/api/v1/vocab-layers" {:name "Lexicon" :project-id a}))
         v2 (id (call (:hm users) :post "/api/v1/vocab-layers" {:name "Second" :project-id a}))
         _ (when borrowed? (fix/assert-no-content (h/link-vocab-to-project admin-request b v)))
         entry (fn [form] (id (call admin-request :post "/api/v1/vocab-items" {:vocab-layer-id v :form form})))
         [kai kaj kak] (mapv entry ["kai" "kaj" "kak"])
         da (doc-with-token! a "A")
         db* (when borrowed? (doc-with-token! b "B"))
         la (id (h/create-vocab-link admin-request kai [(:tok da)]))
         lb (when borrowed? (id (h/create-vocab-link admin-request kai [(:tok db*)])))
         comment (when borrowed?
                   (-> (call (:bw users) :post "/api/v1/comments"
                             {:entity-type "vocab-item" :entity-id kai :body "a note"})
                       :body :comment/id))]
     (is (every? some? (cond-> [a b c v v2 kai kaj kak la] borrowed? (conj lb comment))) "the world was built")
     {:users users :a a :b b :c c :v v :v2 v2 :kai kai :kaj kaj :kak kak :da da :db db* :la la :lb lb
      :comment comment :ts (java.time.Instant/now)})))

(defn- own
  "What column `who` works from: home members from A, borrower members and
  everyone else from B."
  [w who]
  (if (#{:hm :hw :hr :admin :n} who)
    {:doc (:da w) :link (:la w)}
    {:doc (:db w) :link (:lb w)}))

(def ^:private counter (atom 0))

(defn- rows
  "Section 1 as rows of [label {column status} mutates? (fn [world who] response)].
  A column missing from the map expects 403."
  []
  (let [vl (fn [w] (str "/api/v1/vocab-layers/" (:v w)))
        item (fn [w] (str "/api/v1/vocab-items/" (:kai w)))
        readers {:hm 200 :hw 200 :hr 200 :bm 200 :bw 200 :br 200 :admin 200}]
    [;; 1.1 vocabulary routes
     ["list the vocabularies" (assoc readers :n 200) false
      (fn [_ who & _] (call who :get "/api/v1/vocab-layers"))]
     ["create a vocabulary in A" {:hm 201 :admin 201} true
      (fn [w who & _] (call who :post "/api/v1/vocab-layers" {:name "New" :project-id (:a w)}))]
     ["read V" readers false (fn [w who & _] (call who :get (vl w)))]
     ["read V with its entries as of a time" readers false
      (fn [w who & _] (call who :get (str (vl w) "?include-items=true&as-of=" (enc (:ts w)))))]
     ["rename V" {:hm 200 :admin 200} true (fn [w who & _] (call who :patch (vl w) {:name "Renamed"}))]
     ["delete V while B borrows it" {:hm 409 :admin 409} false (fn [w who & _] (call who :delete (vl w)))]
     ["dry run of delete V while B borrows it" {:hm 409 :admin 409} false
      (fn [w who & _] (call who :delete (str (vl w) "?dry-run=true")))]
     ["read V's history" readers false (fn [w who & _] (call who :get (str (vl w) "/audit")))]
     ["read V's comments" readers false (fn [w who & _] (call who :get (str (vl w) "/comments")))]
     ["count V's comments" readers false (fn [w who & _] (call who :get (str (vl w) "/comments/counts")))]
     ["set V's config" {:hm 204 :admin 204} true (fn [w who & _] (call who :put (str (vl w) "/config/igt/colour") "red"))]
     ["remove V's config" {:hm 204 :admin 204} true (fn [w who & _] (call who :delete (str (vl w) "/config/igt/colour")))]
     ["read an entry as of a time" readers false
      (fn [w who & _] (call who :get (str (vl w) "/items/" (:kai w) "?as-of=" (enc (:ts w)))))]
     ["restore an entry" {:hm 200 :admin 200} true
      (fn [w who & _] (call who :post (str (vl w) "/items/" (:kai w) "/restore?as-of=" (enc (:ts w)))))]
     ["dry run of an entry's restore" {:hm 200 :admin 200} false
      (fn [w who & _] (call who :post (str (vl w) "/items/" (:kai w) "/restore?as-of=" (enc (:ts w)) "&dry-run=true")))]
     ["move V to C" {:hm 200 :admin 200} true (fn [w who & _] (call who :post (str (vl w) "/move") {:project-id (:c w)}))]
     ["list V's borrowers" {:hm 200 :admin 200} false (fn [w who & _] (call who :get (str (vl w) "/borrowers")))]
     ;; 1.2 entry routes
     ["create an entry" {:hm 201 :hw 201 :admin 201} true
      (fn [w who & _] (call who :post "/api/v1/vocab-items" {:vocab-layer-id (:v w) :form (str "new" (swap! counter inc))}))]
     ["create entries in bulk" {:hm 201 :hw 201 :admin 201} true
      (fn [w who & _] (call who :post "/api/v1/vocab-items/bulk" [{:vocab-layer-id (:v w) :form (str "bulk" (swap! counter inc))}]))]
     ["edit entries' fields in bulk" {:hm 200 :hw 200 :admin 200} true
      (fn [w who & _] (call who :patch "/api/v1/vocab-items/bulk"
                            [{:id (:kai w) :metadata [{:op "set" :path ["gloss"] :value "x"}]}]))]
     ["change a form in bulk" {:hm 200 :admin 200} true
      (fn [w who & _] (call who :patch "/api/v1/vocab-items/bulk" [{:id (:kai w) :form "kaii"}]))]
     ["delete entries in bulk" {:hm 204 :admin 204} true
      (fn [w who & _] (call who :delete "/api/v1/vocab-items/bulk" [(:kak w)]))]
     ["read an entry" readers false (fn [w who & _] (call who :get (item w)))]
     ["rename an entry" {:hm 200 :admin 200} true (fn [w who & _] (call who :patch (item w) {:form "kaii"}))]
     ["delete an entry" {:hm 204 :admin 204} true (fn [w who & _] (call who :delete (str "/api/v1/vocab-items/" (:kak w))))]
     ["merge entries" {:hm 200 :admin 200} true
      (fn [w who & _] (call who :post (str (item w) "/merge") {:losers [(:kaj w)]}))]
     ["put an entry's metadata" {:hm 200 :hw 200 :admin 200} true
      (fn [w who & _] (call who :put (str (item w) "/metadata") {"gloss" "x"}))]
     ["patch an entry's metadata" {:hm 200 :hw 200 :admin 200} true
      (fn [w who & _] (call who :patch (str (item w) "/metadata") [{:op "set" :path ["gloss"] :value "y"}]))]
     ["delete an entry's metadata" {:hm 200 :hw 200 :admin 200} true
      (fn [w who & _] (call who :delete (str (item w) "/metadata")))]
     ;; 1.3 link routes, each person in their own project's document
     ["link a token" {:hm 201 :hw 201 :bm 201 :bw 201 :admin 201} true
      (fn [w who col] (call who :post "/api/v1/vocab-links"
                            {:vocab-item (:kaj w) :tokens [(new-token! (:doc (own w col)) (swap! counter inc))]}))]
     ["link tokens in bulk" {:hm 201 :hw 201 :bm 201 :bw 201 :admin 201} true
      (fn [w who col] (call who :post "/api/v1/vocab-links/bulk"
                            [{:vocab-item (:kaj w) :tokens [(new-token! (:doc (own w col)) (swap! counter inc))]}]))]
     ["delete a link" {:hm 204 :hw 204 :bm 204 :bw 204 :admin 204} true
      (fn [w who col] (call who :delete (str "/api/v1/vocab-links/" (:link (own w col)))))]
     ["delete links in bulk" {:hm 204 :hw 204 :bm 204 :bw 204 :admin 204} true
      (fn [w who col] (call who :delete "/api/v1/vocab-links/bulk" [(:link (own w col))]))]
     ["read a link" readers false
      (fn [w who col] (call who :get (str "/api/v1/vocab-links/" (:link (own w col)))))]
     ["put a link's metadata" {:hm 200 :hw 200 :bm 200 :bw 200 :admin 200} true
      (fn [w who col] (call who :put (str "/api/v1/vocab-links/" (:link (own w col)) "/metadata") {"note" "x"}))]
     ;; 1.4 project routes
     ["link V2 to B (borrow)" {:admin 204} true
      (fn [w who & _] (call who :post (str "/api/v1/projects/" (:b w) "/vocabs/" (:v2 w))))]
     ["link V to A, its home" {:hm 204 :admin 204} false
      (fn [w who & _] (call who :post (str "/api/v1/projects/" (:a w) "/vocabs/" (:v w))))]
     ["unlink V from B" {:hm 204 :bm 204 :admin 204} true
      (fn [w who & _] (call who :delete (str "/api/v1/projects/" (:b w) "/vocabs/" (:v w))))]
     ["dry run of unlinking V from B" {:hm 200 :bm 200 :admin 200} false
      (fn [w who & _] (call who :delete (str "/api/v1/projects/" (:b w) "/vocabs/" (:v w) "?dry-run=true")))]
     ["unlink V from A, its home" {:hm 409 :admin 409} false
      (fn [w who & _] (call who :delete (str "/api/v1/projects/" (:a w) "/vocabs/" (:v w))))]
     ["delete A while B borrows V" {:hm 409 :admin 409} false
      (fn [w who & _] (call who :delete (str "/api/v1/projects/" (:a w))))]
     ["dry run of deleting A while B borrows V" {:hm 409 :admin 409} false
      (fn [w who & _] (call who :delete (str "/api/v1/projects/" (:a w) "?dry-run=true")))]
     ["comment on an entry" {:hm 201 :hw 201 :bm 201 :bw 201 :admin 201} true
      (fn [w who & _] (call who :post "/api/v1/comments" {:entity-type "vocab-item" :entity-id (:kai w) :body "hi"}))]
     ["delete bw's comment on an entry" {:hm 204 :bw 204 :admin 204} true
      (fn [w who & _] (call who :delete (str "/api/v1/comments/" (:comment w))))]
     ["list the users" {:hm 200 :bm 200 :admin 200} false (fn [_ who & _] (call who :get "/api/v1/users"))]]))

(deftest every-cell-of-section-one
  (doseq [[label expected mutates? action] (rows)]
    (testing label
      (let [shared (world!)]
        (doseq [who columns
                :let [want (get expected who 403)
                      success? (< 199 want 300)
                      w (if (and mutates? success?) (world!) shared)
                      resp (action w (get-in w [:users who]) who)]]
          (is (= want (:status resp))
              (str label ", " (name who) ": wanted " want ", got " (:status resp) " " (pr-str (:body resp)))))))))

(deftest the-vocabulary-maintainer-routes-are-gone
  (let [{:keys [v users]} (world! {:borrowed? false})]
    (doseq [who columns
            method [:post :delete]]
      (is (#{404 405} (:status (call (get-in users [who]) method
                                     (str "/api/v1/vocab-layers/" v "/maintainers/" (:hw emails)))))
          (str (name who) " " (name method))))))

(deftest a-vocabulary-carries-its-home-and-no-maintainers
  (let [{:keys [a b v users]} (world!)
        read (:body (call (:bm users) :get (str "/api/v1/vocab-layers/" v)))]
    (is (= (str a) (str (:vocab/project read))))
    (is (not (contains? read :vocab/maintainers)))
    (testing "a borrower's project lists it with its home"
      (let [pv (some #(when (= (str v) (str (:vocab/id %))) %) (:project/vocabs (:body (call (:bm users) :get (str "/api/v1/projects/" b)))))]
        (is (= (str a) (str (:vocab/project pv))))
        (is (not (contains? pv :vocab/maintainers)))))))

(deftest a-borrower-maintainer-with-a-role-in-the-home-may-borrow
  (let [{:keys [a b v2 users]} (world!)]
    (testing "without a role in A"
      (let [resp (call (:bm users) :post (str "/api/v1/projects/" b "/vocabs/" v2))]
        (is (= 403 (:status resp)))
        (is (= "Linking a vocabulary needs access to the project it belongs to." (-> resp :body :error)))))
    (testing "as a reader of A"
      (role! a "reader" (:bm emails))
      (is (= 204 (:status (call (:bm users) :post (str "/api/v1/projects/" b "/vocabs/" v2))))))))

(defn- op-count []
  (:n (psc/q1 fix/db {:select [[[:count :*] :n]] :from [:operations]})))

(deftest linking-a-vocabulary-to-its-home-writes-nothing
  (let [{:keys [a v users]} (world!)
        before (op-count)]
    (is (= 204 (:status (call (:hm users) :post (str "/api/v1/projects/" a "/vocabs/" v)))))
    (is (= before (op-count)))))

(deftest the-refusals-say-why
  (let [{:keys [a b c v kai users]} (world!)]
    (is (= {:error "A vocabulary cannot be unlinked from its own project."}
           (:body (call (:hm users) :delete (str "/api/v1/projects/" a "/vocabs/" v)))))
    (is (= {:error "1 other project uses this vocabulary." :other-projects 1}
           (:body (call (:hm users) :delete (str "/api/v1/vocab-layers/" v)))))
    (is (= {:error "1 other project uses a vocabulary of this project." :other-projects 1}
           (:body (call (:hm users) :delete (str "/api/v1/projects/" a)))))
    (is (= "Moving a vocabulary needs maintainer rights on both projects."
           (-> (call (:hm users) :post (str "/api/v1/vocab-layers/" v "/move") {:project-id b}) :body :error)))
    (is (= "Moving a vocabulary needs maintainer rights on both projects."
           (-> (call (:bm users) :post (str "/api/v1/vocab-layers/" v "/move") {:project-id b}) :body :error)))
    (is (= "Only a maintainer of the vocabulary's project can rename, merge or delete its entries."
           (-> (call (:hw users) :patch (str "/api/v1/vocab-items/" kai) {:form "kaii"}) :body :error)))
    (is (= "Only a maintainer of the vocabulary's project can rename, merge or delete its entries."
           (-> (call (:hw users) :delete (str "/api/v1/vocab-items/" kai)) :body :error)))
    (let [w2 (id (call admin-request :post "/api/v1/vocab-layers" {:name "Of C" :project-id c}))
          resp (call admin-request :post "/api/v1/vocab-items/bulk"
                     [{:vocab-layer-id v :form "x"} {:vocab-layer-id w2 :form "y"}])]
      (is (= 400 (:status resp)))
      (is (= "Entries in one call must be in vocabularies of one project." (-> resp :body :error))))
    (is (= "Listing users requires admin or project-maintainer privileges."
           (-> (call (:hw users) :get "/api/v1/users") :body :error)))))

(deftest with-no-borrower-the-home-maintainer-deletes
  (testing "the vocabulary, after a dry run"
    (let [{:keys [v users]} (world! {:borrowed? false})]
      (is (= {:links 1} (:body (call (:hm users) :delete (str "/api/v1/vocab-layers/" v "?dry-run=true")))))
      (is (= 204 (:status (call (:hm users) :delete (str "/api/v1/vocab-layers/" v)))))))
  (testing "the project, after a dry run naming the vocabularies it takes"
    (let [{:keys [a v v2 users]} (world! {:borrowed? false})
          preview (call (:hm users) :delete (str "/api/v1/projects/" a "?dry-run=true"))]
      (is (= 200 (:status preview)))
      (is (= #{[(str v) "Lexicon"] [(str v2) "Second"]}
             (set (map (juxt (comp str :id) :name) (-> preview :body :vocabularies)))))
      (is (= 204 (:status (call (:hm users) :delete (str "/api/v1/projects/" a)))))
      (testing "and a vocabulary of a project being deleted is gone to everyone"
        (is (= 404 (:status (call admin-request :get (str "/api/v1/vocab-layers/" v)))))
        (is (= 403 (:status (call (:hm users) :get (str "/api/v1/vocab-layers/" v)))))
        (is (not-any? #(= (str v) (str (:vocab/id %)))
                      (-> (call admin-request :get "/api/v1/vocab-layers") :body)))))))

(defn- parse-uuid* [x] (if (uuid? x) x (parse-uuid (str x))))

(deftest the-home-maintainer-ends-a-borrowing
  (let [{:keys [b v users]} (world!)
        path (str "/api/v1/projects/" b "/vocabs/" v)]
    (testing "the dry run answers the links and nothing else"
      (is (= {:links 1} (:body (call (:hm users) :delete (str path "?dry-run=true"))))))
    (testing "the borrowers are listed, by name only to who may read them"
      (is (= [{:id b :name nil}] (mapv #(update % :id parse-uuid*) (:body (call (:hm users) :get (str "/api/v1/vocab-layers/" v "/borrowers"))))))
      (is (= [{:id b :name "Borrower B"}] (mapv #(update % :id parse-uuid*) (:body (call admin-request :get (str "/api/v1/vocab-layers/" v "/borrowers")))))))
    (is (= 204 (:status (call (:hm users) :delete path))))
    (is (empty? (:body (call (:hm users) :get (str "/api/v1/vocab-layers/" v "/borrowers")))))
    (testing "a project that does not borrow it is not the home maintainer's to touch"
      (is (= 403 (:status (call (:hm users) :delete path)))))))

(deftest a-delegated-token-follows-the-home
  (let [{:keys [a b v kai users] :as w} (world!)
        hm-a (scoped (:hm emails) a)
        hm-b (scoped (:hm emails) b)
        bw-b (scoped (:bw emails) b)]
    (testing "reads through any linking project in scope where the user has a role"
      (is (= 200 (:status (call hm-a :get (str "/api/v1/vocab-layers/" v)))))
      (is (= 200 (:status (call bw-b :get (str "/api/v1/vocab-layers/" v)))))
      (is (= 403 (:status (call hm-b :get (str "/api/v1/vocab-layers/" v))))))
    (testing "writes and maintains entries only with the home in scope"
      (is (= 201 (:status (call hm-a :post "/api/v1/vocab-items" {:vocab-layer-id v :form "s1"}))))
      (is (= 200 (:status (call hm-a :patch (str "/api/v1/vocab-items/" kai) {:form "kaix"}))))
      (is (= 403 (:status (call hm-b :post "/api/v1/vocab-items" {:vocab-layer-id v :form "s2"}))))
      (is (= 403 (:status (call bw-b :post "/api/v1/vocab-items" {:vocab-layer-id v :form "s3"})))))
    (testing "links in its own project's documents"
      (is (= 201 (:status (call bw-b :post "/api/v1/vocab-links"
                                {:vocab-item kai :tokens [(new-token! (:db w) 3)]})))))
    (testing "never creates, moves or borrows a vocabulary, nor lists who borrows it"
      (doseq [[method path body] [[:post "/api/v1/vocab-layers" {:name "S" :project-id a}]
                                  [:post (str "/api/v1/vocab-layers/" v "/move") {:project-id b}]
                                  [:post (str "/api/v1/projects/" b "/vocabs/" v) nil]
                                  [:delete (str "/api/v1/projects/" b "/vocabs/" v) nil]]]
        (is (= 403 (:status (call hm-a method path body))) path)))
    (is (= (str "A delegated token cannot rename, move or delete a vocabulary, change its settings, link or "
                "unlink it, or restore its entries.")
           (-> (call hm-a :patch (str "/api/v1/vocab-layers/" v) {:name "S"}) :body :error)))))

(deftest entry-rights-follow-the-home-role-whatever-project-the-caller-works-from
  ;; The FLEx import into an existing lexicon: a maintainer of the home who
  ;; works in a borrowing project still writes entries.
  (let [{:keys [a b v kai users]} (world!)]
    (role! b "maintainer" (:hm emails))
    (is (= 201 (:status (call (:hm users) :post "/api/v1/vocab-items" {:vocab-layer-id v :form "flex"}))))
    (is (= 200 (:status (call (:hm users) :patch (str "/api/v1/vocab-items/" kai) {:form "kaiy"}))))
    (is (some? a))))

(deftest the-homes-activity-lists-its-vocabulary-operations
  (let [{:keys [a b v kai users]} (world!)
        types (fn [pid] (set (for [e (:entries (:body (call admin-request :get (str "/api/v1/projects/" pid "/audit"))))
                                   op (:audit/ops e)]
                               (:op/type op))))]
    (fix/assert-ok (call (:hm users) :patch (str "/api/v1/vocab-layers/" v) {:name "Renamed"}))
    (fix/assert-ok (call (:hm users) :patch (str "/api/v1/vocab-items/" kai) {:form "kaiz"}))
    (let [ta (types a) tb (types b)]
      (is (contains? ta :vocab/update) (pr-str ta))
      (is (contains? ta :vocab-item/merge) (pr-str ta))
      (is (not-any? #(re-find #"^:vocab(-item)?/" (str %)) tb) (pr-str tb)))))
