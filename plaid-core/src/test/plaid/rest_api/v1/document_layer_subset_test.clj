(ns plaid.rest-api.v1.document-layer-subset-test
  "`?layers=` on the deep document read (issue #57): return only the named
  layers' contents, so an app that touches two layers doesn't pay for every
  layer in the project.

  The retention rule, defined by `doc/prune-to-layers`:
    * a layer node survives when it is named, or is an ANCESTOR of a named
      layer (scaffolding, so the response keeps its usual nesting);
    * a layer's own content survives only when that layer is itself named.

  `get-with-layer-data` also narrows its row queries to the named layers.
  That is a pure optimization, and `pushdown-matches-a-full-read` is what
  holds it to that: narrowing then pruning must equal reading everything then
  pruning."
  (:require [clojure.test :refer :all]
            [clojure.string :as str]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler db
                                    admin-request with-admin api-call
                                    assert-ok assert-created assert-status with-clean-db]]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

;; --- fixture: one text layer, two token layers, two span layers on the first
;; token layer, a relation layer under one of them, and rows in all of it. ---

(defn- build-doc! []
  (let [proj (create-test-project admin-request "LayerSubsetProj")
        tl (-> (create-text-layer admin-request proj "Text") :body :id)
        words (-> (create-token-layer admin-request tl "Words") :body :id)
        other (-> (create-token-layer admin-request tl "Other") :body :id)
        pos (-> (create-span-layer admin-request words "POS") :body :id)
        lemma (-> (create-span-layer admin-request words "Lemma") :body :id)
        dep (-> (create-relation-layer admin-request lemma "Dep") :body :id)
        document (create-test-document admin-request proj "D")
        text (-> (create-text admin-request tl document "the dog barks") :body :id)
        t1 (-> (create-token admin-request words text 0 3) :body :id)
        t2 (-> (create-token admin-request words text 4 7) :body :id)
        _ (assert-created (create-token admin-request other text 0 13))
        _ (assert-created (create-span admin-request pos [t1] "DET"))
        s2 (-> (create-span admin-request lemma [t1] "the") :body :id)
        s3 (-> (create-span admin-request lemma [t2] "dog") :body :id)
        _ (assert-created (create-relation admin-request dep s2 s3 "det"))
        ;; A vocab link on the Words layer. Vocab links attach to token layers
        ;; via the tokens they cover, so they exercise a path the row-narrowing
        ;; special-cases: with no fetched tokens there is nothing to attach to.
        vocab (-> (create-vocab-layer admin-request "LSVocab") :body :id)
        _ (assert-status 204 (link-vocab-to-project admin-request proj vocab))
        item (-> (create-vocab-item admin-request vocab "dog") :body :id)
        _ (assert-created (create-vocab-link admin-request item [t2]))]
    {:project proj :document document
     :text-layer tl :words words :other other
     :pos pos :lemma lemma :dep dep :vocab vocab}))

(defn- vocab-counts
  "[[token-layer-name vocab-link-count] ...] across the surviving tree."
  [body]
  (vec (for [txl (:document/text-layers body)
             tokl (:text-layer/token-layers txl)]
         [(:token-layer/name tokl)
          (reduce + 0 (map (comp count :vocab-layer/vocab-links)
                           (:token-layer/vocabs tokl)))])))

(defn- read-doc
  ([document] (read-doc document nil))
  ([document layer-ids]
   (api-call admin-request
             {:method :get
              :path (str "/api/v1/documents/" document "?include-body=true"
                         (when layer-ids
                           (str "&layers=" (str/join "," (map str layer-ids)))))})))

(defn- outline
  "A compact [[kind name content-count] ...] view of a deep read, in tree
  order, so a test can assert on the whole surviving tree at once."
  [body]
  (letfn [(relation-layer [rl]
            [["relation-layer" (:relation-layer/name rl)
              (count (:relation-layer/relations rl))]])
          (span-layer [sl]
            (into [["span-layer" (:span-layer/name sl)
                    (count (:span-layer/spans sl))]]
                  (mapcat relation-layer (:span-layer/relation-layers sl))))
          (token-layer [tokl]
            (into [["token-layer" (:token-layer/name tokl)
                    (count (:token-layer/tokens tokl))]]
                  (mapcat span-layer (:token-layer/span-layers tokl))))
          (text-layer [txl]
            (into [["text-layer" (:text-layer/name txl)
                    (if (:text-layer/text txl) 1 0)]]
                  (mapcat token-layer (:text-layer/token-layers txl))))]
    (into [] (mapcat text-layer) (:document/text-layers body))))

(deftest unfiltered-read-is-unchanged
  (let [{:keys [document]} (build-doc!)
        r (read-doc document)]
    (assert-ok r)
    (is (= [["text-layer" "Text" 1]
            ["token-layer" "Words" 2]
            ["span-layer" "POS" 1]
            ["span-layer" "Lemma" 2]
            ["relation-layer" "Dep" 1]
            ["token-layer" "Other" 1]]
           (outline (:body r))))))

(deftest names-a-span-layer-and-gets-scaffolding-above-it
  (let [{:keys [document pos]} (build-doc!)
        r (read-doc document [pos])]
    (assert-ok r)
    (is (= [["text-layer" "Text" 0]
            ["token-layer" "Words" 0]
            ["span-layer" "POS" 1]]
           (outline (:body r)))
        (str "the containing text + token layers survive as empty scaffolding; "
             "the sibling span layer, the relation layer, and the other token layer are gone"))))

(deftest naming-an-ancestor-too-brings-its-content
  (let [{:keys [document text-layer words pos]} (build-doc!)
        r (read-doc document [text-layer words pos])]
    (assert-ok r)
    (is (= [["text-layer" "Text" 1]
            ["token-layer" "Words" 2]
            ["span-layer" "POS" 1]]
           (outline (:body r))))))

(deftest vocab-links-follow-their-token-layer
  (let [{:keys [document words pos other]} (build-doc!)]
    (testing "naming the token layer brings its vocab links"
      (let [r (read-doc document [words])]
        (assert-ok r)
        (is (= [["Words" 1]] (vocab-counts (:body r))))))

    (testing "an unnamed token layer that is only scaffolding carries none"
      (let [r (read-doc document [pos])]
        (assert-ok r)
        (is (= [["Words" 0]] (vocab-counts (:body r))))))

    (testing "a different token layer's read does not pick them up"
      (let [r (read-doc document [other])]
        (assert-ok r)
        (is (= [["Other" 0]] (vocab-counts (:body r))))))))

(deftest a-token-layer-alone-brings-no-span-layers
  (let [{:keys [document words]} (build-doc!)
        r (read-doc document [words])]
    (assert-ok r)
    (is (= [["text-layer" "Text" 0]
            ["token-layer" "Words" 2]]
           (outline (:body r)))
        "descendants are not implied — 'only those layers' means only those")))

(deftest a-relation-layer-pulls-its-whole-ancestor-chain
  (let [{:keys [document dep]} (build-doc!)
        r (read-doc document [dep])]
    (assert-ok r)
    (is (= [["text-layer" "Text" 0]
            ["token-layer" "Words" 0]
            ["span-layer" "Lemma" 0]
            ["relation-layer" "Dep" 1]]
           (outline (:body r))))))

(deftest bad-layer-ids-are-rejected-not-silently-empty
  (let [{:keys [document]} (build-doc!)]
    (testing "a value that isn't a UUID"
      (let [r (api-call admin-request
                        {:method :get
                         :path (str "/api/v1/documents/" document
                                    "?include-body=true&layers=not-a-uuid")})]
        (assert-status 400 r)
        (is (str/includes? (-> r :body :error) "not-a-uuid"))))

    (testing "a well-formed id that is not a layer of this project"
      (let [ghost "11111111-2222-3333-4444-555555555555"
            r (api-call admin-request
                        {:method :get
                         :path (str "/api/v1/documents/" document
                                    "?include-body=true&layers=" ghost)})]
        (assert-status 400 r)
        (is (str/includes? (-> r :body :error) ghost)
            "a stale layer id must not look like 'that layer is empty'")))

    (testing "a vocab layer is not one of the document's layers"
      ;; Vocabs hang off token layers rather than sitting in the text-layer
      ;; tree, so there is no way to honour naming one — say so instead of
      ;; returning a tree that quietly ignores it.
      (let [{:keys [vocab]} (build-doc!)
            r (api-call admin-request
                        {:method :get
                         :path (str "/api/v1/documents/" document
                                    "?include-body=true&layers=" vocab)})]
        (assert-status 400 r)
        (is (str/includes? (-> r :body :error) (str vocab)))))

    (testing "layers without include-body"
      (let [{:keys [pos]} (build-doc!)
            r (api-call admin-request
                        {:method :get
                         :path (str "/api/v1/documents/" document "?layers=" pos)})]
        (assert-status 400 r)
        (is (str/includes? (-> r :body :error) "include-body"))))))

(deftest pushdown-matches-a-full-read
  ;; The narrowed row queries in get-with-layer-data must not be able to change
  ;; the response — pruning a narrowed read has to equal pruning a full read,
  ;; for every subset of the layers.
  (let [{:keys [document text-layer words other pos lemma dep]} (build-doc!)
        full (doc/get-with-layer-data db document)
        subsets [[pos] [words] [dep] [text-layer] [other]
                 [text-layer words] [words pos lemma] [text-layer words lemma dep]
                 [words other] [text-layer words other pos lemma dep]]]
    (doseq [subset subsets]
      (is (= (doc/prune-to-layers full (set subset))
             (doc/prune-to-layers (doc/get-with-layer-data db document (set subset))
                                  (set subset)))
          (str "pushdown diverged for subset " (pr-str subset))))
    (testing "and naming every layer reproduces the unfiltered read exactly"
      (is (= full (doc/prune-to-layers
                   (doc/get-with-layer-data db document
                                            #{text-layer words other pos lemma dep})
                   #{text-layer words other pos lemma dep}))))))

(deftest an-empty-or-absent-filter-reads-everything
  (let [{:keys [document]} (build-doc!)
        full (:body (read-doc document))]
    (is (= full (:body (api-call admin-request
                                 {:method :get
                                  :path (str "/api/v1/documents/" document
                                             "?include-body=true&layers=")}))))
    (is (= full (doc/prune-to-layers (doc/get-with-layer-data db document) nil)))
    (is (= full (doc/prune-to-layers (doc/get-with-layer-data db document) #{})))))
