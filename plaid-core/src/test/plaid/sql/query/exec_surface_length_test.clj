(ns plaid.sql.query.exec-surface-length-test
  "A token's surface compared with a literal asks the token's length first
  (SCL6-4), in code points. These run the shapes that get that term through
  the real executor, over a text with an astral letter before and inside the
  tokens, so a length counted in UTF-16 or bytes would drop a match."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h :refer [id]]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- ids [r] (set (map (comp str first) (:results r))))
(defn- run [q] (qe/run db "admin@example.com" q))

(def ^:private hwair "𐍈") ; GOTHIC LETTER HWAIR, one code point, two UTF-16 units

(defn- build!
  "Words over `𐍈 a𐍈b xy` (code points 0, 2-5, 6-8) on one token layer."
  []
  (let [pid  (h/create-test-project admin-request "SurfaceLength")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc (str hwair " a" hwair "b xy")))
        tok  (fn [b e] (str (id (h/create-token admin-request tokl text b e))))]
    {:tokl tokl :h (tok 0 1) :ahb (tok 2 5) :xy (tok 6 8)}))

(deftest a-surface-equality-keeps-every-match
  (let [{:keys [tokl h ahb xy]} (build!)
        t (fn [cmap & where]
            (ids (run {"find" ["?t"] "where" (into [["token" "?t" (merge {"layer" tokl} cmap)]] where)})))
        ahb-lit (str "a" hwair "b")]
    (testing "a value of three code points (four UTF-16 units)"
      (is (= #{ahb} (t {"value" ahb-lit})))
      (is (= #{h} (t {"value" hwair}))))
    (testing "a list of literals of different lengths"
      (is (= #{ahb xy} (t {"value" [ahb-lit "xy"]})))
      (is (= #{h xy} (t {"value" [hwair "xy" "zzz"]}))))
    (testing "= and in on ?t.value"
      (is (= #{ahb} (t {} ["=" "?t.value" ahb-lit])))
      (is (= #{ahb xy} (t {} ["in" "?t.value" ["xy" ahb-lit]]))))
    (testing "a literal of the right length and other letters, and none of any token's length"
      (is (= #{} (t {"value" "ab"})))
      (is (= #{} (t {"value" "abcd"}))))))
