(ns plaid.rest-api.v1.user-data-test
  "Private per-user key/value storage: round trip of arbitrary JSON, prefix
  listing with/without values, paging, delete, the owner-or-admin ACL, and the
  size cap."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin with-test-users
                                    with-clean-db api-call admin-request user1-request user2-request]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; Values come back with STRING keys (the store is verbatim JSON, not a Plaid
;; entity): identical on the JSON wire, visible here because tests read EDN.

(def u1 "user1@example.com")
(defn- path [user-id & [key]] (str "/api/v1/users/" user-id "/data" (when key (str "/" key))))

(defn- listing
  "The paginated envelope for a listing of `user-id`'s entries."
  ([user-id] (listing user-id ""))
  ([user-id query]
   (:body (api-call user1-request {:method :get :path (str (path user-id) query)}))))

(defn- listed
  "Just the entries of one page, which is what most of these tests are about."
  ([user-id] (:entries (listing user-id)))
  ([user-id query] (:entries (listing user-id query))))

(deftest put-get-list-delete-round-trip
  (let [value {:title "Chat 1" :messages [{:role "user" :content "hi"} {:role "assistant" :content nil
                                                                        :tool_calls [{:id "c1"}]}]
               :n 3 :flag true}]
    (testing "put returns the key and a timestamp; get returns the value verbatim"
      (let [resp (api-call user1-request {:method :put :path (path u1 "igt:assistant:p1:meta:c1") :body value})]
        (is (= 200 (:status resp)))
        (is (= "igt:assistant:p1:meta:c1" (:key (:body resp))))
        (is (string? (:updated-at (:body resp)))))
      (let [{:keys [status body]} (api-call user1-request {:method :get :path (path u1 "igt:assistant:p1:meta:c1")})]
        (is (= 200 status))
        (is (= "Chat 1" (get-in body [:value "title"])))
        (is (= 3 (get-in body [:value "n"])))
        (is (true? (get-in body [:value "flag"])))
        (is (nil? (get-in body [:value "messages" 1 "content"])))
        (is (= "c1" (get-in body [:value "messages" 1 "tool_calls" 0 "id"])))))
    (testing "put replaces"
      (api-call user1-request {:method :put :path (path u1 "igt:assistant:p1:meta:c1") :body {:title "Renamed"}})
      (is (= {"title" "Renamed"} (:value (:body (api-call user1-request {:method :get :path (path u1 "igt:assistant:p1:meta:c1")}))))))
    (testing "listing by prefix, keys only by default, values on request; underscores are literal"
      (api-call user1-request {:method :put :path (path u1 "igt:assistant:p1:msgs:c1") :body [1 2 3]})
      (api-call user1-request {:method :put :path (path u1 "igt:assistant:p2:meta:c9") :body "x"})
      (api-call user1-request {:method :put :path (path u1 "other_app:pref") :body {:dark true}})
      (let [{:keys [status body]} (api-call user1-request {:method :get :path (str (path u1) "?prefix=igt:assistant:p1:")})]
        (is (= 200 status))
        (is (= ["igt:assistant:p1:meta:c1" "igt:assistant:p1:msgs:c1"] (mapv :key (:entries body))))
        (is (nil? (:next-cursor body)))
        (is (every? #(not (contains? % :value)) (:entries body))))
      (is (= [{"title" "Renamed"}]
             (mapv :value (listed u1 "?prefix=igt:assistant:p1:meta:&include-values=true"))))
      (is (= 4 (count (listed u1))))
      (is (= ["other_app:pref"] (mapv :key (listed u1 "?prefix=other_app"))))
      (is (= [] (listed u1 "?prefix=otherXapp"))))
    (testing "delete, then 404"
      (is (= 204 (:status (api-call user1-request {:method :delete :path (path u1 "igt:assistant:p1:msgs:c1")}))))
      (is (= 404 (:status (api-call user1-request {:method :delete :path (path u1 "igt:assistant:p1:msgs:c1")}))))
      (is (= 404 (:status (api-call user1-request {:method :get :path (path u1 "igt:assistant:p1:msgs:c1")})))))))

(deftest glob-narrowing
  "A key convention puts the selector in the MIDDLE: the assistant's keys are
  `<app>:assistant:<project>:<kind>:<id>`, so listing every conversation's small
  sidebar entry across every project cannot be said with a prefix. Without the
  glob the only expressible query also matches every `:conv:` sibling, which is
  a whole transcript apiece."
  (doseq [k ["igt:assistant:p1:meta:c1" "igt:assistant:p1:conv:c1"
             "igt:assistant:p2:meta:c9" "igt:assistant:p2:conv:c9"
             "ud:assistant:p1:meta:c4" "other_app:pref"]]
    (api-call user1-request {:method :put :path (path u1 k) :body {:k k}}))
  (testing "a segment in the middle selects the metas and leaves the transcripts"
    (is (= ["igt:assistant:p1:meta:c1" "igt:assistant:p2:meta:c9"]
           (mapv :key (listed u1 "?pattern=igt:assistant:*:meta:*")))))
  (testing "the glob anchors at both ends, so it is not a substring match"
    (is (= [] (listed u1 "?pattern=assistant:*:meta:*"))))
  (testing "? is one character"
    (is (= ["igt:assistant:p1:meta:c1"]
           (mapv :key (listed u1 "?pattern=igt:assistant:p?:meta:c1")))))
  (testing "prefix and pattern are ANDed"
    (is (= ["ud:assistant:p1:meta:c4"]
           (mapv :key (listed u1 "?prefix=ud:&pattern=*:meta:*")))))
  (testing "values come with the same flag as a prefix listing"
    (is (= [{"k" "igt:assistant:p1:meta:c1"} {"k" "igt:assistant:p2:meta:c9"}]
           (mapv :value (listed u1 "?pattern=igt:assistant:*:meta:*&include-values=true")))))
  (testing "a glob is still scoped to the one user"
    (api-call user2-request {:method :put :path (path "user2@example.com" "igt:assistant:p1:meta:theirs") :body {}})
    (is (= ["igt:assistant:p1:meta:c1" "igt:assistant:p2:meta:c9"]
           (mapv :key (listed u1 "?pattern=igt:assistant:*:meta:*"))))))

(deftest paging-a-users-own-entries
  "The listing is the one place a value can arrive by the megabyte, so it pages
  like every other collection: a cursor over (user, key), the narrowings
  unchanged, and the entries seen exactly once."
  (doseq [k ["igt:assistant:p1:conv:c1" "igt:assistant:p1:meta:c1"
             "igt:assistant:p2:meta:c2" "igt:assistant:p3:meta:c3"
             "other_app:pref"]]
    (api-call user1-request {:method :put :path (path u1 k) :body {:k k}}))
  (testing "a full page carries a cursor and the next page carries the rest"
    (let [first-page (listing u1 "?limit=2")
          cursor (:next-cursor first-page)]
      (is (= ["igt:assistant:p1:conv:c1" "igt:assistant:p1:meta:c1"] (mapv :key (:entries first-page))))
      (is (string? cursor))
      (let [second-page (listing u1 (str "?limit=2&cursor=" cursor))]
        (is (= ["igt:assistant:p2:meta:c2" "igt:assistant:p3:meta:c3"] (mapv :key (:entries second-page))))
        (is (string? (:next-cursor second-page)))
        (is (= ["other_app:pref"] (mapv :key (:entries (listing u1 (str "?limit=2&cursor=" (:next-cursor second-page))))))))))
  (testing "one entry at a time, following the cursor, sees each exactly once"
    (loop [cursor nil seen [] guard 0]
      (let [page (listing u1 (str "?pattern=igt:assistant:*:meta:*&limit=1"
                                  (when cursor (str "&cursor=" cursor))))
            seen (into seen (map :key (:entries page)))]
        (cond
          (> guard 10) (is false "the cursor never ran out")
          (:next-cursor page) (recur (:next-cursor page) seen (inc guard))
          :else (is (= ["igt:assistant:p1:meta:c1" "igt:assistant:p2:meta:c2" "igt:assistant:p3:meta:c3"]
                       seen))))))
  (testing "values still come with the flag, one page at a time"
    (is (= [{"k" "igt:assistant:p1:meta:c1"}]
           (mapv :value (listed u1 "?pattern=igt:assistant:*:meta:*&include-values=true&limit=1")))))
  (testing "a page above the ceiling is refused, and a garbled cursor is a 400"
    (is (= 400 (:status (api-call user1-request {:method :get :path (str (path u1) "?limit=1001")}))))
    (is (= 400 (:status (api-call user1-request {:method :get :path (str (path u1) "?limit=0")}))))
    (is (= 400 (:status (api-call user1-request {:method :get :path (str (path u1) "?cursor=not-a-cursor")})))))
  (testing "a cursor cannot reach another user's entries"
    (api-call user2-request {:method :put :path (path "user2@example.com" "igt:assistant:p1:meta:theirs") :body {}})
    (let [last-page (listing u1 "?limit=5")]
      (is (= 5 (count (:entries last-page))))
      (is (= [] (:entries (listing u1 (str "?limit=5&cursor=" (:next-cursor last-page)))))))))

(deftest scalar-values-and-encoded-keys
  (let [key "igt:assistant:p1:weird%2Fkey"]
    (is (= 200 (:status (api-call user1-request {:method :put :path (path u1 key) :body 42}))))
    (is (= 42 (:value (:body (api-call user1-request {:method :get :path (path u1 key)})))))
    (is (= ["igt:assistant:p1:weird/key"] (mapv :key (listed u1))))))

(deftest owner-or-admin-only
  (api-call user1-request {:method :put :path (path u1 "k") :body {:secret 1}})
  (testing "another user can neither read, list, write, nor delete"
    (is (= 403 (:status (api-call user2-request {:method :get :path (path u1 "k")}))))
    (is (= 403 (:status (api-call user2-request {:method :get :path (path u1)}))))
    (is (= 403 (:status (api-call user2-request {:method :put :path (path u1 "k") :body {}}))))
    (is (= 403 (:status (api-call user2-request {:method :delete :path (path u1 "k")})))))
  (testing "an admin can"
    (is (= {"secret" 1} (:value (:body (api-call admin-request {:method :get :path (path u1 "k")})))))
    (is (= 204 (:status (api-call admin-request {:method :delete :path (path u1 "k")})))))
  (testing "entries are per user: the same key on another user is a different entry"
    (api-call user2-request {:method :put :path (path "user2@example.com" "k") :body 2})
    (is (= 404 (:status (api-call user1-request {:method :get :path (path u1 "k")}))))))

(deftest value-size-cap
  (let [big (apply str (repeat 1000001 "a"))]
    (is (= 413 (:status (api-call user1-request {:method :put :path (path u1 "big") :body big}))))
    (is (= 404 (:status (api-call user1-request {:method :get :path (path u1 "big")}))))))

(deftest a-prefix-holding-an-astral-character-still-matches
  ;; The prefix is compared with SQLite's `substr`, which counts code points,
  ;; against a length taken with Clojure's `count`, which counts UTF-16 units.
  ;; A prefix with one emoji in it asked for one code point too many, so the
  ;; comparison ran past the prefix and matched nothing.
  (let [prefix "igt:🌍:"
        key (str prefix "notes")]
    (api-call user1-request {:method :put :path (path u1 key) :body {:n 1}})
    (api-call user1-request {:method :put :path (path u1 "igt:plain:notes") :body {:n 2}})
    (testing "the owner's own listing"
      (is (= [key] (mapv :key (listed u1 (str "?prefix=" prefix))))))
    (testing "and the admin listing across accounts, which builds the same clause"
      (is (= [key] (mapv :key (:entries (:body (api-call admin-request
                                                         {:method :get
                                                          :path (str "/api/v1/admin/user-data?prefix=" prefix)})))))))))
