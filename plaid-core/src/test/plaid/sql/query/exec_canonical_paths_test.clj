(ns plaid.sql.query.exec-canonical-paths-test
  "An equality or `in` with a text that has another canonical spelling (ай,
  é) compares in NFC through PLAID_NFC. On a field the compiler reads with a
  scalar subquery (a metadata path) the subquery goes into the function call,
  and these run every such shape through the real executor: before the fix
  each was a SQLite syntax error, a 500."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.common :as psc]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))
(defn- ids [r] (set (map (comp str first) (:results r))))
(defn- run [q] (qe/run db "admin@example.com" q))

(def ^:private ai "\u0430\u0439")             ; ай composed
(def ^:private ai-nfd "\u0430\u0438\u0306")   ; ай with й as и and a breve
(def ^:private e-acute "\u00e9")              ; é composed
(def ^:private e-nfd "e\u0301")

(defn- stored-before!
  "Write a metadata value straight to the database, as a core before
  composing stored it."
  [entity-id k v]
  (psc/execute! db {:update :entity_metadata :set {:value (psc/write-json v)}
                    :where [:and [:= :entity_id (str entity-id)] [:= :key k]]}))

(defn- build!
  "Words over `ай ай é x` with metadata form ай, ай (stored decomposed), é, x.
  A span on each token, a relation from the first span to the second, a
  vocab item per form linked to its token, all with the same form in
  metadata, and the document with genre ай."
  []
  (let [pid  (h/create-test-project admin-request "CanonPaths")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "gloss"))
        rl   (id (h/create-relation-layer admin-request sl "dep"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc (str ai " " ai " " e-acute " x")))
        vl   (id (h/create-vocab-layer admin-request "CanonLex"))
        _    (h/link-vocab-to-project admin-request pid vl)
        mk   (fn [b e form]
               (let [t (id (h/create-token admin-request tokl text b e nil {"form" form}))
                     s (id (h/create-span admin-request sl [t] form {"form" form}))
                     v (id (h/create-vocab-item admin-request vl (str form b) {"form" form}))
                     l (id (h/create-vocab-link admin-request v [t] {"form" form}))]
                 {:t t :s s :v v :l l}))
        a  (mk 0 2 ai)
        b  (mk 3 5 ai)
        c  (mk 6 7 e-acute)
        d  (mk 8 9 "x")
        r  (id (h/create-relation admin-request rl (:s a) (:s b) ai {"form" ai}))]
    (doseq [k [:t :s :v :l]] (stored-before! (k b) "form" ai-nfd))
    (h/update-document-metadata admin-request doc {"genre" ai})
    {:doc doc :tokl tokl :sl sl :rl rl :vl vl :a a :b b :c c :d d :r r}))

(deftest a-metadata-path-compares-canonically
  (let [{:keys [tokl a b c d]} (build!)
        t (fn [where] (ids (run {"find" ["?m"] "where" (into [["token" "?m" {"layer" tokl}]] where)})))
        both #{(str (:t a)) (str (:t b))}]
    (doseq [lit [ai ai-nfd]]
      (testing (str "= and != on ?m.metadata.form with " (pr-str lit))
        (is (= both (t [["=" "?m.metadata.form" lit]])))
        (is (= #{(str (:t c)) (str (:t d))} (t [["!=" "?m.metadata.form" lit]]))))
      (testing "in"
        (is (= both (t [["in" "?m.metadata.form" [lit]]])))))
    (testing "é in both spellings"
      (is (= #{(str (:t c))} (t [["in" "?m.metadata.form" [e-acute]]])))
      (is (= #{(str (:t c))} (t [["=" "?m.metadata.form" e-nfd]]))))
    (testing "an in list mixing a canonical and a plain literal"
      (is (= (conj both (str (:t d))) (t [["in" "?m.metadata.form" [ai "x"]]])))
      (is (= #{(str (:t c)) (str (:t d))} (t [["in" "?m.metadata.form" ["x" e-nfd]]]))))))

(deftest value-and-map-shapes-compare-canonically
  (let [{:keys [tokl a b]} (build!)
        both #{(str (:t a)) (str (:t b))}
        t (fn [where] (ids (run {"find" ["?m"] "where" where})))]
    (testing "a token's value path and value map"
      (is (= both (t [["token" "?m" {"layer" tokl}] ["=" "?m.value" ai]])))
      (is (= both (t [["token" "?m" {"layer" tokl}] ["in" "?m.value" [ai]]])))
      (is (= both (t [["token" "?m" {"layer" tokl "value" ai}]]))))
    (testing "a token's metadata map, a scalar and a list"
      (is (= both (t [["token" "?m" {"layer" tokl "metadata" {"form" ai}}]])))
      (is (= both (t [["token" "?m" {"layer" tokl "metadata" {"form" [ai "zz"]}}]]))))))

(deftest every-kind-with-metadata-compares-canonically
  (let [{:keys [sl rl vl doc a b d r]} (build!)]
    (testing "a span's metadata path and value path"
      (let [both #{(str (:s a)) (str (:s b))}]
        (is (= both (ids (run {"find" ["?s"] "where" [["span" "?s" {"layer" sl}] ["=" "?s.metadata.form" ai]]}))))
        (is (= (conj both (str (:s d)))
               (ids (run {"find" ["?s"] "where" [["span" "?s" {"layer" sl}] ["in" "?s.metadata.form" [ai "x"]]]}))))
        (is (= both (ids (run {"find" ["?s"] "where" [["span" "?s" {"layer" sl}] ["=" "?s.value" ai]]}))))))
    (testing "a relation's metadata path and value map"
      (is (= #{(str r)} (ids (run {"find" ["?r"] "where" [["relation" "?r" {"layer" rl}] ["=" "?r.metadata.form" ai]]}))))
      (is (= #{(str r)} (ids (run {"find" ["?r"] "where" [["relation" "?r" {"layer" rl "value" ai}]]})))))
    (testing "a document's metadata path"
      (is (= #{(str doc)} (ids (run {"find" ["?d"] "where" [["document" "?d" {}] ["in" "?d.metadata.genre" [ai]]]})))))
    (testing "a vocab item's metadata path and form"
      (is (= #{(str (:v a)) (str (:v b))}
             (ids (run {"find" ["?v"] "where" [["vocab" "?v" {"layer" vl}] ["=" "?v.metadata.form" ai-nfd]]}))))
      (is (= #{(str (:v a))}
             (ids (run {"find" ["?v"] "where" [["vocab" "?v" {"layer" vl}] ["in" "?v.form" [(str ai "0")]]]})))))
    (testing "a link's metadata path"
      (is (= #{(str (:l a)) (str (:l b))}
             (ids (run {"find" ["?l"] "where" [["link" "?l" {}] ["in" "?l.metadata.form" [ai "q"]]]})))))))

(deftest grouping-by-a-metadata-path-with-a-canonical-filter
  ;; igt's frequency_list of morphemes: group by the form, count, filtered
  ;; to the forms asked for.
  (let [{:keys [tokl doc]} (build!)
        r (run {"where" [["token" "?m" {"layer" tokl}] ["in" "?m.metadata.form" [ai e-acute]]]
                "return" {"group" ["?m.metadata.form" "?m.doc"] "aggregates" [["count"]]}})
        counts (into {} (map (fn [[form _ n]] [form n]) (:results r)))]
    (is (= #{(str doc)} (set (map (comp str second) (:results r)))))
    (is (= 1 (get counts e-acute)))
    (is (= 2 (+ (get counts ai 0) (get counts ai-nfd 0))))))
