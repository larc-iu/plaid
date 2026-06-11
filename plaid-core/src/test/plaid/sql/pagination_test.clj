(ns plaid.sql.pagination-test
  "Direct unit tests for the shared keyset paginator. Previously only
  exercised indirectly through endpoints; the 3-column `keyset-where`
  branch had no coverage anywhere."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db db]]
            [plaid.sql.pagination :as pg]
            [plaid.sql.user :as user]))

(use-fixtures :once with-db with-mount-states)
(use-fixtures :each with-clean-db)

;; ============================================================
;; keyset-where — structural equality against the docstring
;; ============================================================

(deftest keyset-where-one-column
  (is (= [:or [:> :c0 "v0"]]
         (pg/keyset-where [:c0] ["v0"]))))

(deftest keyset-where-two-columns
  (is (= [:or
          [:> :c0 "v0"]
          [:and [:= :c0 "v0"] [:> :c1 "v1"]]]
         (pg/keyset-where [:c0 :c1] ["v0" "v1"]))))

(deftest keyset-where-three-columns
  ;; The critical previously-untested branch.
  (is (= [:or
          [:> :c0 "v0"]
          [:and [:= :c0 "v0"] [:> :c1 "v1"]]
          [:and [:= :c0 "v0"] [:= :c1 "v1"] [:> :c2 "v2"]]]
         (pg/keyset-where [:c0 :c1 :c2] ["v0" "v1" "v2"]))))

(deftest keyset-where-nil-cursor
  (is (nil? (pg/keyset-where [:c0 :c1] nil)))
  (is (nil? (pg/keyset-where [:c0 :c1] []))))

;; ============================================================
;; cursor codec round-trip
;; ============================================================

(deftest cursor-round-trip
  (testing "decode(encode v) == (mapv str v)"
    (doseq [v [["alice" "id-1"]
               [1 2 3]
               ["x"]
               ["µ-non-ascii" "id-2" "third"]]]
      (is (= (mapv str v)
             (pg/decode-cursor (pg/encode-cursor v))))))
  (testing "encode of nil/empty is nil"
    (is (nil? (pg/encode-cursor nil)))
    (is (nil? (pg/encode-cursor [])))))

(deftest decode-nil-cursor
  (is (nil? (pg/decode-cursor nil))))

;; ============================================================
;; malformed cursors — all 400, never 500
;; ============================================================

(defn- decode-code
  "Decode `cursor` and return the `:code` from the thrown ex-data, or
  `:no-throw` if decoding (unexpectedly) succeeded."
  [cursor]
  (try
    (pg/decode-cursor cursor)
    :no-throw
    (catch clojure.lang.ExceptionInfo e
      (:code (ex-data e)))))

(defn- b64url
  "base64url-encode a string the same way the codec produces cursors."
  [^String s]
  (-> (java.util.Base64/getUrlEncoder)
      (.withoutPadding)
      (.encodeToString (.getBytes s "UTF-8"))))

(deftest malformed-cursors-all-400
  (testing "invalid base64"
    (is (= 400 (decode-code "!!!not base64!!!"))))
  (testing "valid base64 but not JSON"
    (is (= 400 (decode-code (b64url "this is not json")))))
  (testing "valid JSON missing the \"v\" key"
    (is (= 400 (decode-code (b64url "{\"x\":1}")))))
  (testing "\"v\" present but not a vector"
    (is (= 400 (decode-code (b64url "{\"v\":\"x\"}")))))
  (testing "\"v\" contains a non-scalar element"
    (is (= 400 (decode-code (b64url "{\"v\":[{\"a\":1}]}"))))))

;; ============================================================
;; clamp-limit
;; ============================================================

(deftest clamp-limit-cases
  (is (= 100 (pg/clamp-limit nil)) "nil → default")
  (is (= 100 (pg/clamp-limit 0)) "0 → default")
  (is (= 100 (pg/clamp-limit -5)) "negative → default")
  (is (= 1000 (pg/clamp-limit 5000)) "over max → max")
  (is (= 50 (pg/clamp-limit 50)) "in-range passes through")
  (is (= 20 (pg/clamp-limit "20")) "numeric string parses")
  (is (= 100 (pg/clamp-limit "not-a-number")) "non-numeric → default"))

;; ============================================================
;; paginate — DB-backed boundary semantics
;; ============================================================

(defn- seed-users!
  "Create `n` scratch users with deterministic, sortable usernames and
  return the sorted set of [username id] key vectors we expect to walk."
  [n]
  (let [ids (mapv #(format "pg-user-%02d@example.com" %) (range n))]
    (doseq [u ids] (user/create db u false "pw" nil))
    ;; username == id in user/create, so the keyset is [username id].
    (sort (mapv (fn [u] [u u]) ids))))

(defn- walk-paginate
  "Walk every page of `paginate` over the users table on [:username :id],
  collecting the [username id] key vectors and the per-page next-cursor
  presence. Returns {:keys [...] :fulls [...]} where :fulls is a vector of
  booleans (true == that page had a non-nil next-cursor)."
  [limit]
  (loop [cursor nil
         acc []
         fulls []]
    (let [{:keys [entries next-cursor]}
          (pg/paginate db {:select   [:username :id]
                           :from     :users
                           ;; Scope to only the users THIS test seeded — the
                           ;; shared in-memory DB also holds standing test
                           ;; users (admin@, user1@, …) that would otherwise
                           ;; pollute the counts under the full suite.
                           :base-where [:like :username "pg-user-%"]
                           :order-by [:username :id]
                           :limit    limit
                           :cursor-vals cursor
                           :row->entity (fn [r] [(:username r) (:id r)])})
          acc'   (into acc entries)
          fulls' (conj fulls (some? next-cursor))]
      (if next-cursor
        (recur next-cursor acc' fulls')
        {:keys acc' :fulls fulls'}))))

(deftest paginate-full-page-has-cursor
  (testing "next-cursor is non-nil IFF the page is exactly full"
    ;; 6 scratch users; page size 3 → first page full (cursor), second
    ;; page full (cursor), third page empty (no cursor).
    (let [_ (seed-users! 6)
          base [:like :username "pg-user-%"]
          p1 (pg/paginate db {:select [:username :id]
                              :from :users
                              :base-where base
                              :order-by [:username :id]
                              :limit 3})]
      (is (= 3 (count (:entries p1))))
      (is (some? (:next-cursor p1)) "full page → cursor")
      (let [p2 (pg/paginate db {:select [:username :id]
                                :from :users
                                :base-where base
                                :order-by [:username :id]
                                :limit 3
                                :cursor-vals (:next-cursor p1)})]
        (is (= 3 (count (:entries p2))))
        (is (some? (:next-cursor p2)) "second full page → cursor")
        (let [p3 (pg/paginate db {:select [:username :id]
                                  :from :users
                                  :base-where base
                                  :order-by [:username :id]
                                  :limit 3
                                  :cursor-vals (:next-cursor p2)})]
          (is (= 0 (count (:entries p3))))
          (is (nil? (:next-cursor p3)) "empty page → no cursor"))))))

(deftest paginate-reassembles-full-set
  (testing "walking pages reassembles the full set, no dupes, in order"
    (let [expected (seed-users! 7)
          {walked :keys} (walk-paginate 3)]
      (is (= expected walked) "ordered, complete, no overlap")
      (is (= (count walked) (count (distinct walked))) "no dupes"))))

(deftest paginate-non-full-page-no-cursor
  (testing "a page that is not full carries no next-cursor"
    (let [_ (seed-users! 4)
          p (pg/paginate db {:select [:username :id]
                             :from :users
                             :base-where [:like :username "pg-user-%"]
                             :order-by [:username :id]
                             :limit 10})]
      (is (= 4 (count (:entries p))))
      (is (nil? (:next-cursor p))))))

;; ============================================================
;; paginate-coll — in-memory parity
;; ============================================================

(def ^:private sample-coll
  ;; Include a non-ASCII name to exercise the string-compare ordering.
  [{:name "banana" :id "id-3"}
   {:name "apple" :id "id-1"}
   {:name "µango" :id "id-5"}
   {:name "cherry" :id "id-4"}
   {:name "apple" :id "id-2"}])

(def ^:private coll-key-fns [:name :id])

(defn- walk-paginate-coll [limit]
  (loop [cursor nil
         acc []
         fulls []]
    (let [{:keys [entries next-cursor]}
          (pg/paginate-coll sample-coll coll-key-fns limit cursor)
          acc'   (into acc entries)
          fulls' (conj fulls (some? next-cursor))]
      (if next-cursor
        (recur next-cursor acc' fulls')
        {:page-keys acc' :fulls fulls'}))))

(deftest paginate-coll-reassembles
  (testing "pages reassemble the full set, sorted, no dupes"
    (let [expected (sort-by (fn [e] (mapv (comp str e) coll-key-fns)) sample-coll)
          {walked :page-keys} (walk-paginate-coll 2)]
      (is (= expected walked) "deterministic sorted order, complete")
      (is (= (count walked) (count (distinct walked))) "no dupes")
      (is (= 5 (count walked))))))

(deftest paginate-coll-cursor-only-when-full
  (testing "next-cursor non-nil IFF page is exactly full"
    (let [p1 (pg/paginate-coll sample-coll coll-key-fns 2 nil)]
      (is (= 2 (count (:entries p1))))
      (is (some? (:next-cursor p1)) "full page → cursor")
      ;; 5 entries, page 2 → pages of 2,2,1; the last page is short.
      (let [{fulls :fulls} (walk-paginate-coll 2)]
        (is (= [true true false] fulls)
            "full, full, then short page has no cursor")))
    (testing "a single non-full page carries no cursor"
      (let [p (pg/paginate-coll sample-coll coll-key-fns 100 nil)]
        (is (= 5 (count (:entries p))))
        (is (nil? (:next-cursor p)))))))

(deftest paginate-coll-non-ascii-order
  (testing "non-ASCII name sorts by Java String compare (after ASCII)"
    ;; 'µ' (U+00B5) > all ASCII lowercase letters, so µango sorts last.
    (let [{walked :page-keys} (walk-paginate-coll 100)
          names (mapv :name walked)]
      (is (= "µango" (last names))))))
