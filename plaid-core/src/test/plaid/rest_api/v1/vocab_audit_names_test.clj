(ns plaid.rest-api.v1.vocab-audit-names-test
  "A vocabulary's operations belong to its home, and its History is read by
  every project that borrows it, so an audit read names a project only to
  someone who may read it (REV-VH-B-3): not in a description (a move into
  another project, the vocabulary's own home, an unlink), not in
  `op/project`, not in `audit/projects`. And a home maintainer's end of a
  borrowing is named in the vocabulary's History and the home's Activity,
  not only in the borrower's (REV-VH-A-3).

    hm  maintains A (V's home) and D, no role in B or C
    ar  reads A only
    bm  maintains B, which borrows V
    cm  maintains C, which borrows V, no role in A, B or D
    admin"
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.server.events :as events]
            [plaid.sql.user :as pxu]
            [plaid.test-helpers :as h :refer [id]]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- as-user [email]
  (when-not (pxu/get-internal fix/db email)
    (pxu/create fix/db email false "a-long-password-1" nil))
  (let [token (auth/issue-session-token! fix/db "fake-secret" email)]
    (fn [method path]
      (-> (mock/request method path)
          (mock/header "accept" "application/edn")
          (mock/header "Authorization" (str "Bearer " token))))))

(defn- call [who method path & [body]]
  (api-call who (cond-> {:method method :path path} (some? body) (assoc :body body))))

(defn- role! [pid role email]
  (fix/assert-no-content (call admin-request :post (str "/api/v1/projects/" pid "/" role "s/" email))))

(defn- world!
  "A owns V, B and C borrow it, C's document links one of its entries. hm
  moves V to D and back, renames it, and ends B's borrowing."
  []
  (let [users (into {:admin admin-request}
                    (map (fn [k] [k (as-user (str (name k) "@example.com"))]))
                    [:hm :ar :bm :cm])
        p (fn [n] (h/create-test-project admin-request n))
        [a b c d] (mapv p ["Ayvale" "Bramble" "Cedar" "Dunmore"])
        _ (do (role! a "maintainer" "hm@example.com") (role! d "maintainer" "hm@example.com")
              (role! a "reader" "ar@example.com")
              (role! b "maintainer" "bm@example.com") (role! c "maintainer" "cm@example.com"))
        v (id (call (:hm users) :post "/api/v1/vocab-layers" {:name "Lexicon" :project-id a}))
        kai (id (call admin-request :post "/api/v1/vocab-items" {:vocab-layer-id v :form "kai"}))
        _ (doseq [x [b c]] (fix/assert-no-content (h/link-vocab-to-project admin-request x v)))
        txl (id (h/create-text-layer admin-request c "T"))
        tkl (id (h/create-token-layer admin-request txl "W"))
        doc (h/create-test-document admin-request c "Cedar doc")
        text (id (h/create-text admin-request txl doc "kai"))
        tok (id (h/create-token admin-request tkl text 0 3))
        _ (id (h/create-vocab-link admin-request kai [tok]))
        move! (fn [to] (is (= 200 (:status (call (:hm users) :post (str "/api/v1/vocab-layers/" v "/move")
                                                 {:project-id to})))))]
    (move! d)
    (move! a)
    (fix/assert-ok (call (:hm users) :patch (str "/api/v1/vocab-layers/" v) {:name "Lexicon 2"}))
    (fix/assert-no-content (call (:hm users) :delete (str "/api/v1/projects/" b "/vocabs/" v)))
    {:users users :a a :b b :c c :d d :v v :doc doc}))

(defn- entries [resp] (-> resp :body :entries))

(defn- descriptions [resp]
  (vec (for [e (entries resp) op (:audit/ops e)] (:op/description op))))

(defn- names-in [resp] (set (re-seq #"Ayvale|Bramble|Cedar|Dunmore" (pr-str (:body resp)))))

(defn- ids-in [resp ids] (set (filter #(str/includes? (pr-str (:body resp)) (str %)) ids)))

(deftest a-vocabularys-history-names-no-project-its-reader-cannot-read
  (let [{:keys [users a b c d v]} (world!)
        history (fn [who] (call (who users) :get (str "/api/v1/vocab-layers/" v "/audit")))]
    (testing "a borrower's maintainer with no role in its home, nor in where it went"
      (let [resp (history :cm)]
        (is (= 200 (:status resp)))
        (is (= #{} (names-in resp)) "no project's name")
        (is (= #{} (ids-in resp [a b d])) "no other project's id")
        (is (every? empty? (map :audit/projects (entries resp))))
        (is (not-any? :op/project (mapcat :audit/ops (entries resp))))
        (is (= #{"Create vocabulary “Lexicon”" "Move vocabulary “Lexicon” to another project"
                 "Rename vocabulary “Lexicon” to “Lexicon 2”" "Unlink vocabulary “Lexicon 2” from another project"}
               (set (remove #(str/starts-with? % "Create vocab item") (descriptions resp)))))))
    (testing "the home's maintainer reads A and D, not B"
      (let [resp (history :hm)
            ds (set (descriptions resp))]
        (is (contains? ds "Move vocabulary “Lexicon” to project “Dunmore”"))
        (is (contains? ds "Move vocabulary “Lexicon” to project “Ayvale”"))
        (is (contains? ds "Unlink vocabulary “Lexicon 2” from another project")
            "hm ended B's borrowing, and cannot read B")
        (is (not (contains? (names-in resp) "Bramble")))
        (is (= #{} (ids-in resp [b c])))))
    (testing "an admin reads every name"
      (let [ds (set (descriptions (history :admin)))]
        (is (contains? ds "Unlink vocabulary “Lexicon 2” from project “Bramble”"))
        (is (contains? ds "Move vocabulary “Lexicon” to project “Dunmore”"))))))

(deftest the-end-of-a-borrowing-is-in-the-homes-activity-and-the-borrowers
  (let [{:keys [users a b v]} (world!)
        activity (fn [who pid] (call (who users) :get (str "/api/v1/projects/" pid "/audit")))]
    (testing "the home's Activity, read by its maintainer"
      (let [resp (activity :hm a)
            unlink (first (filter #(some (comp #{:vocab/unlink} :op/type) (:audit/ops %)) (entries resp)))]
        (is (some? unlink) "listed")
        (is (= ["Unlink vocabulary “Lexicon 2” from another project"] (mapv :op/description (:audit/ops unlink))))
        (is (= "hm@example.com" (-> unlink :audit/user :user/id)))
        (is (= #{} (ids-in resp [b])) "B's id is not given")))
    (testing "the home's Activity, read by a reader of A alone: the move into D is not named either"
      (let [ds (set (descriptions (activity :ar a)))]
        (is (contains? ds "Move vocabulary “Lexicon” to another project"))
        (is (not-any? #(str/includes? % "Dunmore") ds))))
    (testing "the borrower's Activity names its own project, and the unlink there is one entry"
      (let [resp (activity :bm b)]
        (is (some #{"Unlink vocabulary “Lexicon 2” from project “Bramble”"} (descriptions resp)))
        (is (not-any? #(= :vocab/unlink (:op/type %)) (mapcat :audit/ops (entries resp))))
        (is (= #{} (ids-in resp [a])) "the home's id is not given")))
    (testing "in a log that holds both, the unlink is one entry of two operations"
      (let [resp (call admin-request :get "/api/v1/audit")
            unit (first (filter #(some (comp #{:vocab/unlink} :op/type) (:audit/ops %)) (entries resp)))]
        (is (= #{:project/remove-vocab :vocab/unlink} (set (map :op/type (:audit/ops unit)))))))))

(deftest a-documents-history-names-no-project-its-reader-cannot-read
  (let [{:keys [users a doc]} (world!)
        resp (call (:cm users) :get (str "/api/v1/documents/" doc "/audit"))
        rename (first (filter #(some (comp #{:vocab/update} :op/type) (:audit/ops %)) (entries resp)))]
    (is (= 200 (:status resp)))
    (is (some? rename) "the rename restated C's document, so its History lists it")
    (is (empty? (:audit/projects rename)))
    (is (not-any? :op/project (:audit/ops rename)))
    (is (= #{} (ids-in resp [a])))
    (is (not (contains? (names-in resp) "Ayvale")))))

(deftest an-event-names-no-other-project-to-a-projects-listeners
  (let [event {:event/type :audit-log
               :event/projects #{"A" "D"}
               :audit/ops [{:op/id "o" :op/type "vocab:move" :op/project "A"
                            :op/description "Move vocabulary “V” to project “Dunmore”"
                            :op/named-project "D"
                            :op/anonymous-description "Move vocabulary “V” to another project"}]}
        op-for (fn [pid] (first (:audit/ops (events/for-project event pid))))]
    (testing "A's listeners: their own project, the target unnamed"
      (is (= {:op/id "o" :op/type "vocab:move" :op/project "A"
              :op/description "Move vocabulary “V” to another project"}
             (op-for "A"))))
    (testing "D's listeners: D named, A's id not given"
      (is (= {:op/id "o" :op/type "vocab:move" :op/project nil
              :op/description "Move vocabulary “V” to project “Dunmore”"}
             (op-for "D"))))))
