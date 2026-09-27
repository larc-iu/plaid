(ns plaid.sql.query.exec-scope-test
  "The query's access boundary for variables that name no layer id: every
  kind of variable a reader can bind sees its own projects' rows and no
  other's, a vocabulary is visible through a grant to a readable project, a
  vocabulary granted to no project is visible to nobody, a deleted project's
  rows are gone, and the admin sees every project."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request assert-no-content]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- build!
  "Project `pname`: one text 'aa bb', two word tokens, a NOUN span on each, a
  relation between the spans, the vocabularies `vocabs` granted to it, and a
  link from the first word to `item`."
  [pname vocabs item]
  (let [pid  (h/create-test-project admin-request pname)
        _    (doseq [v vocabs] (h/link-vocab-to-project admin-request pid v))
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        rl   (id (h/create-relation-layer admin-request sl "dep"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb"))
        t0   (id (h/create-token admin-request tokl text 0 2))
        t1   (id (h/create-token admin-request tokl text 3 5))
        s0   (id (h/create-span admin-request sl [t0] "NOUN"))
        s1   (id (h/create-span admin-request sl [t1] "NOUN"))
        r    (id (h/create-relation admin-request rl s0 s1 "dep"))
        l    (id (h/create-vocab-link admin-request item [t0]))]
    {:pid pid :txtl txtl :tokl tokl :sl sl :rl rl :doc doc :text text
     :tokens #{t0 t1} :spans #{s0 s1} :relation r :link l}))

(defn- ids [r] (set (map (comp str first) (:results r))))
(defn- strs [xs] (set (map str xs)))

(defn- q [user find where]
  (ids (qe/run db user {"find" [find] "where" where})))

(defn- agg-count [user where]
  (-> (qe/run db user {"where" where "return" {"group" [] "aggregates" [["count"]]}})
      :results first first))

(deftest a-variable-without-a-layer-id-sees-only-readable-projects
  (let [shared (id (h/create-vocab-layer admin-request "Shared lexicon"))
        own2   (id (h/create-vocab-layer admin-request "P2 lexicon"))
        orphan (id (h/create-vocab-layer admin-request "Granted to nobody"))
        shared-item (id (h/create-vocab-item admin-request shared "shared"))
        own2-item   (id (h/create-vocab-item admin-request own2 "p2only"))
        _           (id (h/create-vocab-item admin-request orphan "orphan"))
        c1 (build! "Scope C1" [shared] shared-item)
        c2 (build! "Scope C2" [shared own2] own2-item)
        c3 (build! "Scope C3" [shared] shared-item)]
    (h/add-project-reader admin-request (:pid c1) "user1@example.com")
    ;; a deleted project's rows are gone, whatever referenced them
    (assert-no-content (h/delete-test-project admin-request (:pid c3)))

    (testing "a reader of one project"
      (let [u "user1@example.com"]
        (is (= (strs (:spans c1)) (q u "?s" [["span" "?s" {"value" "NOUN"}]])))
        (is (= (strs (:tokens c1)) (q u "?t" [["token" "?t" {}]])))
        (is (= #{(str (:relation c1))} (q u "?r" [["relation" "?r" {}]])))
        (is (= #{(str (:text c1))} (q u "?x" [["text" "?x" {}]])))
        (is (= #{(str (:link c1))} (q u "?l" [["link" "?l" {}]])))
        (is (= #{(str (:doc c1))} (q u "?d" [["document" "?d" {}]])))
        (is (= #{(str (:link c1))} (q u "?l" [["vocab" "?v" {}] ["link-item" "?l" "?v"]])))
        (testing "through a layer variable of every kind"
          (is (= #{(str (:txtl c1))} (q u "?x" [["text-layer" "?x" {}]])))
          (is (= #{(str (:tokl c1))} (q u "?x" [["token-layer" "?x" {}]])))
          (is (= #{(str (:sl c1))} (q u "?x" [["span-layer" "?x" {}]])))
          (is (= #{(str (:rl c1))} (q u "?x" [["relation-layer" "?x" {}]])))
          (is (= (strs (:spans c1)) (q u "?s" [["span" "?s" {"layer" "?sl"}] ["span-layer" "?sl" {}]]))))
        (testing "a vocabulary through its grant to a readable project"
          (is (= #{(str shared)} (q u "?x" [["vocab-layer" "?x" {}]])))
          (is (= #{(str shared-item)} (q u "?v" [["vocab" "?v" {}]]))))
        (testing "inside a negation"
          (is (= #{(str (:text c1))}
                 (q u "?x" [["text" "?x" {}] ["not" ["span" "?s" {"value" "VERB"}]]]))))
        (testing "a reach across relations stays in scope"
          (is (= (strs (:spans c1))
                 (into (q u "?a" [["span" "?a" {}] ["related*" "?a" "?b" {"layer" (:rl c1)}]])
                       (q u "?b" [["span" "?a" {}] ["related*" "?a" "?b" {"layer" (:rl c1)}]])))))))

    (testing "the admin sees every live project, and no vocabulary granted to none"
      (let [u "admin@example.com"]
        (is (= (into (strs (:spans c1)) (strs (:spans c2))) (q u "?s" [["span" "?s" {"value" "NOUN"}]])))
        (is (= #{(str shared) (str own2)} (q u "?x" [["vocab-layer" "?x" {}]])))
        (is (= #{(str shared-item) (str own2-item)} (q u "?v" [["vocab" "?v" {}]])))
        (testing "a vocabulary granted to several projects counts once"
          (is (= 2 (agg-count u [["vocab" "?v" {}]])))
          (is (= 2 (agg-count u [["vocab-layer" "?x" {}]]))))))))
