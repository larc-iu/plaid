(ns plaid.sql.query.deferred-group-keys-property-test
  "A differential test of `plaid.sql.query.compile/deferred-group-keys`: over
  random data and random group shapes, a grouped query answers exactly what it
  answered when every group key was read once per match. Metadata values are
  missing, JSON null, numbers, strings, booleans, maps and arrays, one key
  mixing types across entities."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.compile]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))

(defn- pick [^java.util.Random rnd xs] (nth xs (.nextInt rnd (count xs))))

(def ^:private values
  "What a metadata key may hold. ::missing leaves the key out."
  [::missing ::missing nil 0 1 2 1.5 "a" "b" "" true false {"n" 1} {"n" nil} {} [1 2] []])

(defn- random-metadata [rnd]
  (let [k (pick rnd values)
        m (pick rnd [::missing {"n" (pick rnd [1 2 "x" nil])} {"n" {"deep" 3}}])]
    (cond-> {"other" 1}
      (not= ::missing k) (assoc "k" k)
      (not= ::missing m) (assoc "m" m))))

(defn- build! [^java.util.Random rnd seed]
  (let [pid  (h/create-test-project admin-request (str "DeferredGroupKeys " seed))
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        vl   (id (h/create-vocab-layer admin-request (str "DeferredGroupKeys lexicon " seed)))
        _    (h/link-vocab-to-project admin-request pid vl)
        items (vec (for [i (range 4)]
                     (id (h/create-vocab-item admin-request vl (str "e" i) (random-metadata rnd)))))]
    (doseq [i (range 4)]
      (let [d (h/create-test-document admin-request pid (str "d" i))
            n (+ 2 (.nextInt rnd 4))
            body (apply str (repeat n "ab "))
            tx (id (h/create-text admin-request txtl d body))]
        (h/update-document-metadata admin-request d (random-metadata rnd))
        (doseq [j (range n)]
          (let [t (id (h/create-token admin-request tokl tx (* 3 j) (+ 2 (* 3 j))))]
            (when (.nextBoolean rnd)
              (h/update-token-metadata admin-request t (random-metadata rnd)))
            (when (.nextBoolean rnd)
              (h/create-vocab-link admin-request (pick rnd items) [t]))
            (dotimes [_ (.nextInt rnd 3)]
              (let [s (id (h/create-span admin-request sl [t] (pick rnd ["N" "V" 7 nil])))]
                (when (.nextBoolean rnd)
                  (h/update-span-metadata admin-request s (random-metadata rnd)))))))))
    {:words tokl :pos sl :vocab vl}))

(def ^:private token-terms
  ["?d" "?t" "?t.value" "?d.metadata.k" "?d.metadata.m.n" "?t.metadata.k" "?t.metadata.m"
   "?d.metadata.absent"])

(def ^:private span-terms
  ["?s" "?s.value" "?s.metadata.k" "?s.metadata.m.n.deep"])

(def ^:private vocab-terms
  ["?v" "?v.metadata.k" "?v.metadata.m.n" "?v.form" "?tl" "?tl.config.plaid.role"])

(defn- shapes
  "{label [where terms]}: a where clause and the group keys it can take."
  [{:keys [words pos vocab]}]
  (let [base [["token" "?t" {"layer" words}] ["document" "?d" {}] ["=" "?t.doc" "?d"]]]
    {"every var bound"
     [(into base [["span" "?s" {"layer" pos}] ["covers" "?s" "?t"]])
      (into token-terms span-terms)]
     "?s bound in both branches of an or"
     [(conj base ["or"
                  [["span" "?s" {"layer" pos "value" "N"}] ["covers" "?s" "?t"]]
                  [["span" "?s" {"layer" pos "value" 7}] ["covers" "?s" "?t"]]])
      (into token-terms span-terms)]
     "an or whose branches bind the same vars differently"
     [(conj base ["or"
                  [["span" "?s" {"layer" pos}] ["covers" "?s" "?t"] ["=" "?t.begin" 0]]
                  [["span" "?s" {"layer" pos "value" "V"}] ["covers" "?s" "?t"]]])
      (into token-terms span-terms)]
     "igt's link count"
     [[["vocab" "?v" {"layer" vocab}]
       ["vocab-link" "?t" "?v"]
       ["token" "?t" {"layer" "?tl"}]
       ["token-layer" "?tl" {}]
       ["document" "?d" {}] ["=" "?t.doc" "?d"]]
      (into token-terms vocab-terms)]}))

(defn- random-group [^java.util.Random rnd terms]
  (let [n (inc (.nextInt rnd 5))]
    (vec (distinct (repeatedly n #(pick rnd terms))))))

(defn- answer [body]
  (try
    (let [r (qe/run db "admin@example.com" body)]
      {:columns (:columns r) :rows (frequencies (:results r)) :truncated (:truncated r)})
    (catch clojure.lang.ExceptionInfo e
      {:error (ex-message e) :code (:code (ex-data e))})))

(deftest a-deferred-group-key-answers-as-a-per-match-key
  (let [real @#'plaid.sql.query.compile/deferred-group-keys
        deferred-runs (atom 0)]
    (doseq [seed (range 6)]
      (let [rnd (java.util.Random. seed)
            layers (build! rnd seed)]
        (doseq [[label [where terms]] (shapes layers)
                _ (range 15)]
          (let [group (random-group rnd terms)
                body {"where" where
                      "return" {"group" group "aggregates" [["count"]]}}
                per-match (with-redefs [plaid.sql.query.compile/deferred-group-keys (fn [& _] {})]
                            (answer body))
                deferred (with-redefs [plaid.sql.query.compile/deferred-group-keys
                                       (fn [& args]
                                         (let [r (apply real args)]
                                           (when (seq r) (swap! deferred-runs inc))
                                           r))]
                           (answer body))]
            (testing (str "seed " seed ", " label ", group " group)
              (is (nil? (:error per-match)) "the per-match query runs")
              (is (seq (:rows per-match)) "the query matches something")
              (is (= per-match deferred)))))))
    (is (< 50 @deferred-runs) "many of the shapes defer a key")))
