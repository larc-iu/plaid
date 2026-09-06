(ns plaid.sql.query.exec-link-test
  "The :link entity kind: a vocab link as a queryable entity of its own, with
  its metadata (provenance), its document, its item, and its tokens. Before it,
  a link was reachable only through the token-to-item :vocab-link relationship,
  so nothing about the link row itself could be asked."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))
(defn- ids [r] (set (map (comp str first) (:results r))))
(defn- code-of [f]
  (try (f) ::no-throw
       (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))

(defn- build!
  "Project `pname`: words layer over 'aa bb cc dd', a vocab layer granted to it
  with items Kemal / other / 'cc dd', and four links:
    l1  Kemal -> [t0]     machine-made, unconfirmed
    l2  other -> [t1]     machine-made, confirmed
    l3  'cc dd' -> [t2 t3] a contributor's (a multi-word expression)
    l4  Kemal -> [t2]     no metadata (a verifier's own)"
  [pname]
  (let [pid  (h/create-test-project admin-request pname)
        txtl (id (h/create-text-layer admin-request pid "text"))
        word (id (h/create-token-layer admin-request txtl "words"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc dd"))
        t0 (id (h/create-token admin-request word text 0 2))
        t1 (id (h/create-token admin-request word text 3 5))
        t2 (id (h/create-token admin-request word text 6 8))
        t3 (id (h/create-token admin-request word text 9 11))
        vl (id (h/create-vocab-layer admin-request (str pname "-lex")))
        _  (h/link-vocab-to-project admin-request pid vl)
        kemal (id (h/create-vocab-item admin-request vl "Kemal"))
        other (id (h/create-vocab-item admin-request vl "other"))
        phrase (id (h/create-vocab-item admin-request vl "cc dd"))
        l1 (id (h/create-vocab-link admin-request kemal [t0] {"prov" "inferred" "provSource" "service:x"}))
        l2 (id (h/create-vocab-link admin-request other [t1] {"prov" "inferred" "provSource" "service:x" "provConfirmed" true}))
        l3 (id (h/create-vocab-link admin-request phrase [t2 t3] {"prov" "contributed" "provSource" "user:ann@x.com"}))
        l4 (id (h/create-vocab-link admin-request kemal [t2]))]
    {:pid pid :doc doc :t0 t0 :t1 t1 :t2 t2 :t3 t3 :vl vl :kemal kemal :other other :phrase phrase
     :l1 l1 :l2 l2 :l3 l3 :l4 l4}))

(deftest links-by-provenance
  (let [{:keys [l1 l2 l3]} (build! "LinkProv")]
    (testing "machine-made links nobody confirmed: metadata on the link itself"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?l"]
                       "where" [["link" "?l" {"metadata" {"prov" "inferred"}}]
                                ["not" ["link" "?l" {"metadata" {"provConfirmed" true}}]]]})]
        (is (= #{(str l1)} (ids r)))))
    (testing "every link with any provenance stamp"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?l"]
                       "where" [["link" "?l" {"metadata" {"prov" ["inferred" "contributed"]}}]]})]
        (is (= #{(str l1) (str l2) (str l3)} (ids r)))))
    (testing "a metadata dot path works on a link too"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?l"]
                       "where" [["link" "?l" {}] ["=" "?l.metadata.provSource" "user:ann@x.com"]]})]
        (is (= #{(str l3)} (ids r)))))))

(deftest link-token-and-link-item
  (let [{:keys [t2 t3 l1 l2 l4 kemal other]} (build! "LinkRel")]
    (testing "link-token: the tokens a link covers (two for a multi-word expression)"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?t"]
                       "where" [["link" "?l" {"metadata" {"prov" "contributed"}}]
                                ["link-token" "?l" "?t"]]})]
        (is (= #{(str t2) (str t3)} (ids r)))))
    (testing "link-item: the links of an item found by form"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?l"]
                       "where" [["vocab" "?v" {"form" "Kemal"}] ["link-item" "?l" "?v"]]})]
        (is (= #{(str l1) (str l4)} (ids r)))))
    (testing "an inline item variable is the same join"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?l"]
                       "where" [["link" "?l" {"item" "?v"}] ["vocab" "?v" {"form" "other"}]]})]
        (is (= #{(str l2)} (ids r)))))
    (testing "item by id, and by a list of ids"
      (is (= #{(str l1) (str l4)}
             (ids (qe/run db "admin@example.com" {"find" ["?l"] "where" [["link" "?l" {"item" kemal}]]}))))
      (is (= #{(str l1) (str l2) (str l4)}
             (ids (qe/run db "admin@example.com" {"find" ["?l"] "where" [["link" "?l" {"item" [kemal other]}]]})))))
    (testing "?l.item is a reference field: equal to a vocab variable"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?l"]
                       "where" [["link" "?l" {}] ["vocab" "?v" {"form" "other"}] ["=" "?l.item" "?v"]]})]
        (is (= #{(str l2)} (ids r)))))))

(deftest link-document-count-entities-and-aggregates
  (let [{:keys [doc t2 t3 l3]} (build! "LinkShape")]
    (testing "doc constraint and count"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?l"] "where" [["link" "?l" {"doc" doc}]] "return" "count"})]
        (is (= 4 (:count r)))))
    (testing "entities hydrate to the vocab-link wire shape, tokens in order"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?l"]
                       "where" [["link" "?l" {"metadata" {"prov" "contributed"}}]]
                       "return" "entities"})
            e (ffirst (:results r))]
        (is (= (str l3) (str (:vocab-link/id e))))
        (is (= [(str t2) (str t3)] (mapv str (:vocab-link/tokens e))))
        (is (= (str doc) (str (:vocab-link/document e))))))
    (testing "tokens per link, as an aggregate: the expression has two"
      (let [r (qe/run db "admin@example.com"
                      {"where" [["link" "?l" {}] ["link-token" "?l" "?t"]]
                       "return" {"group" ["?l"] "aggregates" [["count"]]}})
            by-link (into {} (map (fn [[l n]] [(str l) n]) (:results r)))]
        (is (= 2 (get by-link (str l3))))
        (is (= 4 (count by-link)))))
    (testing "order-by on the link's document is accepted"
      (let [r (qe/run db "admin@example.com"
                      {"find" ["?l"] "where" [["link" "?l" {}]] "order-by" [["?l.doc"]]})]
        (is (= 4 (:count r)))))))

(deftest links-are-scoped-by-project
  (let [c1 (build! "LinkAcl1")
        _  (build! "LinkAcl2")]
    (h/add-project-reader admin-request (:pid c1) "user1@example.com")
    (testing "a reader of one project sees only its links, however they are reached"
      (let [r (qe/run db "user1@example.com" {"find" ["?l"] "where" [["link" "?l" {}]]})]
        (is (= #{(str (:l1 c1)) (str (:l2 c1)) (str (:l3 c1)) (str (:l4 c1))} (ids r))))
      (let [r (qe/run db "user1@example.com"
                      {"find" ["?l"] "where" [["vocab" "?v" {"form" "Kemal"}] ["link-item" "?l" "?v"]]})]
        (is (= #{(str (:l1 c1)) (str (:l4 c1))} (ids r)))))
    (testing "the admin sees both projects' links"
      (is (= 8 (:count (qe/run db "admin@example.com" {"find" ["?l"] "where" [["link" "?l" {}]] "return" "count"})))))))

(deftest link-clause-validation
  (build! "LinkVal")
  (testing "a link has no layer"
    (is (= 400 (code-of #(qe/run db "admin@example.com" {"find" ["?l"] "where" [["link" "?l" {"layer" "x"}]]})))))
  (testing "item takes an id or a vocab variable, never a name"
    (is (= 400 (code-of #(qe/run db "admin@example.com" {"find" ["?l"] "where" [["link" "?l" {"item" "Kemal"}]]})))))
  (testing "link-token needs a link and a token"
    (is (= 400 (code-of #(qe/run db "admin@example.com"
                                 {"find" ["?l"] "where" [["link" "?l" {}] ["span" "?s" {}] ["link-token" "?l" "?s"]]}))))))
