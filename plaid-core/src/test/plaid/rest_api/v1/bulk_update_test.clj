(ns plaid.rest-api.v1.bulk-update-test
  "PATCH /spans/bulk, /relations/bulk and /tokens/bulk: many values and
  metadata patches in one operation, across the documents of one project."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler admin-request
                                    assert-status assert-created assert-ok assert-bad-request
                                    assert-forbidden assert-not-found
                                    with-admin with-test-users user1-request with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- setup
  "One project, two documents, each with two tokens, two spans and one
  relation. Returns the ids."
  []
  (let [proj (create-test-project admin-request "BulkUpdate")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tkl (-> (create-token-layer admin-request tl "Tokens") :body :id)
        sl (-> (create-span-layer admin-request tkl "Spans") :body :id)
        rl (-> (create-relation-layer admin-request sl "Rels") :body :id)
        build (fn [name]
                (let [doc (create-test-document admin-request proj name)
                      tid (-> (create-text admin-request tl doc "ab cd") :body :id)
                      t1 (-> (create-token admin-request tkl tid 0 2) :body :id)
                      t2 (-> (create-token admin-request tkl tid 3 5) :body :id)
                      s1 (-> (create-span admin-request sl [t1] "A") :body :id)
                      s2 (-> (create-span admin-request sl [t2] "B") :body :id)
                      r (-> (create-relation admin-request rl s1 s2 "dep") :body :id)]
                  {:doc doc :t1 t1 :t2 t2 :s1 s1 :s2 s2 :r r}))]
    {:proj proj :d1 (build "Doc 1") :d2 (build "Doc 2")}))

(defn- version [doc-id]
  (-> (get-document admin-request doc-id) :body :document/version))

(deftest spans-value-and-metadata-in-one-request
  (let [{:keys [d1]} (setup)
        v0 (version (:doc d1))
        res (bulk-update-spans admin-request [{:id (:s1 d1) :value "NOUN" :metadata {"prov" "inferred"}}
                                              {:id (:s2 d1) :metadata {"provConfirmed" true}}])]
    (assert-ok res)
    (is (= 2 (-> res :body :count)))
    (is (= "NOUN" (-> (get-span admin-request (:s1 d1)) :body :span/value)))
    (is (= "inferred" (-> (get-span admin-request (:s1 d1)) :body :metadata (get "prov"))))
    (is (= "B" (-> (get-span admin-request (:s2 d1)) :body :span/value)) "a value not given is untouched")
    (is (= true (-> (get-span admin-request (:s2 d1)) :body :metadata (get "provConfirmed"))))
    (is (= (inc v0) (version (:doc d1))) "one operation bumps the document once")))

(deftest spans-across-documents-bump-every-document
  (let [{:keys [d1 d2]} (setup)
        v1 (version (:doc d1))
        v2 (version (:doc d2))
        res (bulk-update-spans admin-request [{:id (:s1 d1) :value "X"} {:id (:s1 d2) :value "Y"}])]
    (assert-ok res)
    (is (= "X" (-> (get-span admin-request (:s1 d1)) :body :span/value)))
    (is (= "Y" (-> (get-span admin-request (:s1 d2)) :body :span/value)))
    (is (= (inc v1) (version (:doc d1))))
    (is (= (inc v2) (version (:doc d2))))))

(deftest a-null-value-and-a-null-metadata-key
  (let [{:keys [d1]} (setup)]
    (assert-ok (bulk-update-spans admin-request [{:id (:s1 d1) :metadata {"prov" "inferred" "note" "x"}}]))
    (assert-ok (bulk-update-spans admin-request [{:id (:s1 d1) :value nil :metadata {"note" nil}}]))
    (let [span (-> (get-span admin-request (:s1 d1)) :body)]
      (is (nil? (:span/value span)) "value present as null sets null")
      (is (= "inferred" (get (:metadata span) "prov")))
      (is (not (contains? (:metadata span) "note")) "a null metadata value deletes the key"))))

(deftest an-unknown-id-refuses-the-whole-update
  (let [{:keys [d1]} (setup)
        res (bulk-update-spans admin-request [{:id (:s1 d1) :value "X"} {:id (random-uuid) :value "Y"}])]
    (assert-not-found res)
    (is (= "A" (-> (get-span admin-request (:s1 d1)) :body :span/value)) "nothing was written")))

(deftest an-empty-list-and-a-duplicate-are-refused
  (let [{:keys [d1]} (setup)]
    (assert-bad-request (bulk-update-spans admin-request []))
    (assert-bad-request (bulk-update-spans admin-request [{:id (:s1 d1) :value "X"} {:id (:s1 d1) :value "Y"}]))))

(deftest a-reader-may-not-bulk-update
  (let [{:keys [proj d1]} (setup)]
    (assert-forbidden (bulk-update-spans user1-request [{:id (:s1 d1) :value "X"}]))))

(deftest relations-value-and-metadata
  (let [{:keys [d1 d2]} (setup)
        res (bulk-update-relations admin-request [{:id (:r d1) :value "nsubj" :metadata {"prov" "inferred"}}
                                                  {:id (:r d2) :metadata {"provConfirmed" true}}])]
    (assert-ok res)
    (is (= 2 (-> res :body :count)))
    (is (= "nsubj" (-> (get-relation admin-request (:r d1)) :body :relation/value)))
    (is (= "inferred" (-> (get-relation admin-request (:r d1)) :body :metadata (get "prov"))))
    (is (= "dep" (-> (get-relation admin-request (:r d2)) :body :relation/value)))
    (is (= true (-> (get-relation admin-request (:r d2)) :body :metadata (get "provConfirmed"))))
    (assert-not-found (bulk-update-relations admin-request [{:id (random-uuid) :value "x"}]))))

(deftest tokens-metadata
  (let [{:keys [d1 d2]} (setup)
        v1 (version (:doc d1))
        res (bulk-update-tokens admin-request [{:id (:t1 d1) :metadata {"orthog:ipa" "ab"}}
                                               {:id (:t1 d2) :metadata {"form" "cd"}}])]
    (assert-ok res)
    (is (= 2 (-> res :body :count)))
    (is (= "ab" (-> (get-token admin-request (:t1 d1)) :body :metadata (get "orthog:ipa"))))
    (is (= "cd" (-> (get-token admin-request (:t1 d2)) :body :metadata (get "form"))))
    (is (= (inc v1) (version (:doc d1))))
    (assert-not-found (bulk-update-tokens admin-request [{:id (random-uuid) :metadata {"a" "b"}}]))))
