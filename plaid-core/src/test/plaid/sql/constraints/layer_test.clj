(ns plaid.sql.constraints.layer-test
  "Layer constraints enforced inside the write transaction, per type: a write
  that breaks a rule on the row it writes is refused with 422 and writes
  nothing, in a single operation and in a batch; a batch may pass through a
  broken state and fix it before its end; a write elsewhere that breaks a
  rule (a split, a merge, a text save) gets the type's remedy in the same
  transaction as its own `layer/apply-constraints` operation."
  (:require [clojure.data.json :as json]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-test-users
                                    api-call assert-status with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        create-text-layer create-token-layer create-token-layer-opts
                                        create-span-layer create-relation-layer
                                        create-text create-token create-span create-relation
                                        create-vocab-layer create-vocab-item create-vocab-link
                                        link-vocab-to-project]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ============================================================
;; A ud-shaped and igt-shaped stack on one text
;; ============================================================

(def text "The cat sat. Dogs ran.")

(def words [["The" 0 3] ["cat" 4 7] ["sat" 8 11] ["Dogs" 13 17] ["ran" 18 21]])

(def all-words (mapv first words))

(defn- id [resp] (-> resp :body :id str))

(defn- call [method path & [body]]
  (api-call admin-request (cond-> {:method method :path path} body (assoc :body body))))

(defn- batch [ops & [query]]
  (call :post (str "/api/v1/batch" (or query "")) ops))

(defn- declare! [kind layer ns constraints]
  (call :put (str "/api/v1/" kind "-layers/" layer "/constraints/" ns) {:constraints constraints}))

(defn setup!
  "One document: a sentence layer (non-overlapping, one sentence over the
  whole text), a word layer under it, a syntactic-word layer under the words
  with one full-width token per word, a Lemma span per word, a Deps
  relation layer on Lemma, and a vocabulary linked to the project."
  []
  (let [proj (create-test-project admin-request "C")
        doc (create-test-document admin-request proj "D")
        tl (id (create-text-layer admin-request proj "T"))
        sl (id (create-token-layer-opts admin-request tl "Sentence" {:overlap-mode "non-overlapping"}))
        wl (id (create-token-layer-opts admin-request tl "Word" {:overlap-mode "non-overlapping"
                                                                 :parent-token-layer-id sl}))
        swl (id (create-token-layer-opts admin-request tl "Syntactic word" {:parent-token-layer-id wl}))
        lemma (id (create-span-layer admin-request wl "Lemma"))
        deps (id (create-relation-layer admin-request lemma "Deps"))
        txt (id (create-text admin-request tl doc text))
        sentence (id (create-token admin-request sl txt 0 (count text)))
        tok (into {} (for [[w b e] words] [w (id (create-token admin-request wl txt b e))]))
        sw (into {} (for [[w b e] words] [w (id (create-token admin-request swl txt b e))]))
        span (into {} (for [[w] words] [w (id (create-span admin-request lemma [(tok w)] w))]))
        vocab (id (create-vocab-layer admin-request "Lex"))
        _ (link-vocab-to-project admin-request proj vocab)
        item (id (create-vocab-item admin-request vocab "cat"))]
    {:proj proj :doc doc :tl tl :sl sl :wl wl :swl swl :lemma lemma :deps deps :txt txt
     :sentence sentence :tok tok :sw sw :span span :vocab vocab :item item}))

(defn- rel! [{:keys [deps span]} s t & [value]]
  (create-relation admin-request deps (span s) (span t) (or value "dep")))

(defn- version [doc] (psc/document-version db doc))

(defn- count-rows [table where]
  (:n (psc/q1 db {:select [[[:count :*] :n]] :from table :where where})))

(defn- exists? [table rid] (some? (psc/fetch-by-id db table rid)))

(defn- ops-of [doc type]
  (psc/q db {:select [:id :batch_id :group_id :description :document_id]
             :from :operations
             :where [:and [:= :op_type type] [:= :document_id doc]]}))

(defn- span-value [sid] (some-> (psc/fetch-by-id db :spans sid) :value psc/read-json))

;; ============================================================
;; max-in-degree
;; ============================================================

(deftest max-in-degree-refuses-a-second-head
  (let [{:keys [deps doc] :as s} (setup!)]
    (assert-status 200 (declare! "relation" deps "ud" [{:type "max-in-degree" :max 1}]))
    (assert-status 201 (rel! s "The" "cat"))
    (let [v (version doc)
          n (count-rows :relations [:= :relation_layer_id deps])
          r (rel! s "sat" "cat")]
      (testing "a single create is refused with 422 and the violation"
        (assert-status 422 r)
        (is (= 1 (-> r :body :violation-count)))
        (is (= "max-in-degree" (-> r :body :violations first :constraint)))
        (is (= "ud" (-> r :body :violations first :namespace)))
        (is (= "Deps" (-> r :body :violations first :layer-name)))
        (is (= ((:span s) "cat") (-> r :body :violations first :at)))
        (is (= 2 (count (-> r :body :violations first :ids))))
        (is (re-find #"target of 2 relations of layer \"Deps\"" (-> r :body :error))))
      (is (= n (count-rows :relations [:= :relation_layer_id deps])) "nothing was written")
      (is (= v (version doc)) "the document version did not move"))
    (testing "a batch is refused at its end, at the top level, and rolls back"
      (let [n (count-rows :relations [:= :relation_layer_id deps])
            r (batch [{:path "/api/v1/relations" :method "POST"
                       :body {:layer-id deps :source-id ((:span s) "sat") :target-id ((:span s) "Dogs") :value "x"}}
                      {:path "/api/v1/relations" :method "POST"
                       :body {:layer-id deps :source-id ((:span s) "ran") :target-id ((:span s) "cat") :value "x"}}])]
        (assert-status 422 r)
        (is (= "max-in-degree" (-> r :body :violations first :constraint)))
        (is (= n (count-rows :relations [:= :relation_layer_id deps])))))
    (testing "a batch that moves a head deletes the old one first and passes"
      (let [old (-> (psc/q1 db {:select [:id] :from :relations
                                :where [:= :target_span_id ((:span s) "cat")]}) :id str)]
        (assert-status 200 (batch [{:path "/api/v1/relations" :method "POST"
                                    :body {:layer-id deps :source-id ((:span s) "sat")
                                           :target-id ((:span s) "cat") :value "x"}}
                                   {:path (str "/api/v1/relations/" old) :method "DELETE"}]))
        (is (= 1 (count-rows :relations [:= :target_span_id ((:span s) "cat")])))))))

(deftest a-self-loop-counts-toward-in-degree
  (let [{:keys [deps] :as s} (setup!)]
    (assert-status 200 (declare! "relation" deps "ud" [{:type "max-in-degree" :max 1}]))
    (assert-status 201 (rel! s "sat" "sat" "root"))
    (assert-status 422 (rel! s "cat" "sat"))))

;; ============================================================
;; acyclic
;; ============================================================

(deftest acyclic-refuses-a-cycle
  (let [{:keys [deps] :as s} (setup!)]
    (assert-status 200 (declare! "relation" deps "ud" [{:type "acyclic" :self-loops true}]))
    (assert-status 201 (rel! s "The" "cat"))
    (assert-status 201 (rel! s "cat" "sat"))
    (let [r (rel! s "sat" "The")]
      (assert-status 422 r)
      (is (= "acyclic" (-> r :body :violations first :constraint)))
      (is (= 3 (count (-> r :body :violations first :ids))) "the cycle's three relations are named"))
    (testing "a self-loop is allowed when declared so"
      (assert-status 201 (rel! s "ran" "ran" "root")))))

(deftest acyclic-self-loops-and-excepted-values
  (let [{:keys [deps] :as s} (setup!)]
    (assert-status 200 (declare! "relation" deps "ud" [{:type "acyclic" :except-values ["ref"]}]))
    (assert-status 422 (rel! s "ran" "ran" "root"))
    (assert-status 201 (rel! s "ran" "ran" "ref"))
    (assert-status 201 (rel! s "The" "cat"))
    (assert-status 201 (rel! s "cat" "The" "ref"))
    (assert-status 422 (rel! s "cat" "The" "dep"))))

(deftest acyclic-finds-a-cycle-closed-inside-a-large-batch
  (let [{:keys [deps span] :as s} (setup!)]
    (assert-status 200 (declare! "relation" deps "ud" [{:type "acyclic"}]))
    ;; 60 relations in one batch take the whole-document search.
    (let [pairs (concat (repeat 58 ["The" "cat"]) [["cat" "sat"] ["sat" "The"]])
          r (batch (for [[a b] pairs]
                     {:path "/api/v1/relations" :method "POST"
                      :body {:layer-id deps :source-id (span a) :target-id (span b) :value "x"}}))]
      (assert-status 422 r)
      (is (= "acyclic" (-> r :body :violations first :constraint))))))

;; ============================================================
;; value-set
;; ============================================================

(deftest value-set-refuses-an-unlisted-value
  (let [{:keys [lemma tok doc] :as s} (setup!)]
    (assert-status 200 (declare! "span" lemma "igt" [{:type "value-set" :values ["The" "cat" "sat" "Dogs" "ran" "N" "V" "1SG" "NOM"]
                                                      :delimiters "."}]))
    (let [sid ((:span s) "cat")
          v (version doc)
          r (call :patch (str "/api/v1/spans/" sid) {:value "XYZ"})]
      (assert-status 422 r)
      (is (= "XYZ" (-> r :body :violations first :value)))
      (is (= ["XYZ"] (-> r :body :violations first :parts)))
      (is (= "cat" (span-value sid)))
      (is (= v (version doc))))
    (testing "empty and null values pass"
      (assert-status 200 (call :patch (str "/api/v1/spans/" ((:span s) "cat")) {:value ""}))
      (assert-status 200 (call :patch (str "/api/v1/spans/" ((:span s) "cat")) {:value nil})))
    (testing "every part must be listed, and an empty part is refused"
      (assert-status 200 (call :patch (str "/api/v1/spans/" ((:span s) "sat")) {:value "1SG.NOM"}))
      (assert-status 422 (call :patch (str "/api/v1/spans/" ((:span s) "sat")) {:value "1SG..NOM"}))
      (assert-status 422 (call :patch (str "/api/v1/spans/" ((:span s) "sat")) {:value "1SG.ACC"})))
    (testing "a number is not a listed value"
      (assert-status 422 (call :patch (str "/api/v1/spans/" ((:span s) "sat")) {:value 3})))
    (testing "a create is checked too"
      (let [t (id (create-token admin-request (:wl s) (:txt s) 12 12))]
        (is (some? t))))
    (is (map? tok))))

(deftest value-set-exempts-unverified-machine-output
  (let [{:keys [lemma] :as s} (setup!)
        sid ((:span s) "cat")]
    (assert-status 200 (declare! "span" lemma "igt" [{:type "value-set" :values all-words}]))
    (testing "a value stamped as unverified machine output is stored"
      (assert-status 200 (call :put (str "/api/v1/spans/" sid "/metadata") {"prov" "inferred" "provSource" "m"}))
      (assert-status 200 (call :patch (str "/api/v1/spans/" sid) {:value "XYZ"}))
      (is (= "XYZ" (span-value sid))))
    (testing "confirming it is refused"
      (assert-status 422 (call :put (str "/api/v1/spans/" sid "/metadata")
                               {"prov" "inferred" "provSource" "m" "provConfirmed" true})))
    (testing "a contributed value is not exempt"
      (let [other ((:span s) "sat")]
        (assert-status 200 (call :put (str "/api/v1/spans/" other "/metadata") {"prov" "contributed"}))
        (assert-status 422 (call :patch (str "/api/v1/spans/" other) {:value "XYZ"}))))))

(deftest value-set-parts-first
  (let [{:keys [deps] :as s} (setup!)]
    (assert-status 200 (declare! "relation" deps "ud" [{:type "value-set" :values ["nsubj" "obj"]
                                                        :delimiters ":" :parts "first"}]))
    (assert-status 201 (rel! s "cat" "sat" "nsubj:pass"))
    (assert-status 201 (rel! s "Dogs" "ran" "nsubj"))
    (let [r (rel! s "The" "cat" "det")]
      (assert-status 422 r)
      (is (= ["det"] (-> r :body :violations first :parts))))))

(deftest an-import-keeps-unlisted-values
  (let [{:keys [lemma] :as s} (setup!)
        sid ((:span s) "cat")
        group (str (random-uuid))
        import-q (str "?group-id=" group "&group-message=Import&group-kind=import")]
    (assert-status 200 (declare! "span" lemma "igt" [{:type "value-set" :values all-words}]))
    (testing "a write in an import operation stores an unlisted value"
      (assert-status 200 (api-call admin-request {:method :patch
                                                  :path (str "/api/v1/spans/" sid import-q)
                                                  :body {:value "XYZ"}}))
      (is (= "XYZ" (span-value sid))))
    (testing "so does a batch of an import"
      (assert-status 200 (batch [{:path (str "/api/v1/spans/" ((:span s) "sat")) :method "PATCH"
                                  :body {:value "ABC"}}]
                                import-q)))
    (testing "the same write outside an import is refused"
      (assert-status 422 (call :patch (str "/api/v1/spans/" ((:span s) "ran")) {:value "XYZ"})))
    (testing "declaring a changed list is not refused for the imported values"
      (assert-status 200 (declare! "span" lemma "igt" [{:type "value-set" :values (conj all-words "dog")}])))
    (testing "a later edit of an imported value is checked"
      (assert-status 422 (call :patch (str "/api/v1/spans/" sid) {:value "QQQ"})))))

;; ============================================================
;; single-span
;; ============================================================

(deftest single-span-refuses-a-second-span
  (let [{:keys [lemma tok] :as s} (setup!)]
    (assert-status 200 (declare! "span" lemma "igt" [{:type "single-span"}]))
    (let [r (create-span admin-request lemma [(tok "cat")] "again")]
      (assert-status 422 r)
      (is (= "single-span" (-> r :body :violations first :constraint)))
      (is (= (tok "cat") (-> r :body :violations first :at))))
    (testing "set-tokens onto a token with a span is refused"
      (assert-status 422 (call :put (str "/api/v1/spans/" ((:span s) "cat") "/tokens") {:tokens [(tok "cat") (tok "sat")]})))))

(deftest a-word-merge-joins-the-spans-it-doubles
  (let [{:keys [lemma tok doc] :as s} (setup!)
        group (str (random-uuid))]
    (assert-status 200 (declare! "span" lemma "igt" [{:type "single-span"}]))
    (let [v (version doc)
          r (api-call admin-request {:method :post
                                     :path (str "/api/v1/tokens/" (tok "cat") "/merge?group-id=" group
                                                "&group-message=Merge")
                                     :body {:other-token-id (tok "sat")}})]
      (is (< (:status r) 300) (pr-str r))
      (is (= "cat | sat" (span-value ((:span s) "cat"))) "the survivor's span holds both values in text order")
      (is (not (exists? :spans ((:span s) "sat"))) "the other span is gone")
      (let [ops (ops-of doc "layer/apply-constraints")]
        (is (= 1 (count ops)))
        (is (= group (str (:group_id (first ops)))) "History folds it under the merge")
        (is (re-find #"Applied layer rules: 1 span of \"Lemma\" deleted, 1 span of \"Lemma\" joined"
                     (:description (first ops)))))
      (is (= (+ v 2) (version doc)) "the merge and the rules each bump the document"))))

(deftest single-span-join-respects-a-value-set
  (let [{:keys [lemma tok] :as s} (setup!)]
    (assert-status 200 (declare! "span" lemma "igt" [{:type "single-span" :join-with "+"}
                                                     {:type "value-set" :values ["The" "cat" "sat" "Dogs" "ran"]}]))
    (assert-status 200 (call :post (str "/api/v1/tokens/" (tok "cat") "/merge") {:other-token-id (tok "sat")}))
    (is (= "cat" (span-value ((:span s) "cat"))) "a joined value outside the list leaves the kept value")
    (is (not (exists? :spans ((:span s) "sat"))))))

;; ============================================================
;; same-ancestor
;; ============================================================

(deftest same-ancestor-deletes-relations-a-split-leaves-crossing
  (let [{:keys [deps sl sentence doc] :as s} (setup!)
        cat-the (id (rel! s "cat" "The"))
        sat-dogs (id (rel! s "sat" "Dogs"))
        ran-dogs (id (rel! s "ran" "Dogs"))]
    (assert-status 200 (declare! "relation" deps "ud" [{:type "same-ancestor" :token-layer sl}]))
    (assert-status 201 (call :post (str "/api/v1/tokens/" sentence "/split") {:position 13}))
    (is (not (exists? :relations sat-dogs)) "the relation now crossing the boundary is gone")
    (is (exists? :relations cat-the))
    (is (exists? :relations ran-dogs))
    (let [ops (ops-of doc "layer/apply-constraints")]
      (is (= 1 (count ops)))
      (is (re-find #"1 relation of \"Deps\" deleted" (:description (first ops)))))
    (testing "a relation created across the sentences is refused"
      (let [r (rel! s "sat" "Dogs")]
        (assert-status 422 r)
        (is (re-find #"not in one token of layer \"Sentence\"" (-> r :body :error)))))))

(deftest a-relation-crossing-sentences-refuses-the-declaration
  (let [{:keys [deps sl sentence] :as s} (setup!)]
    (assert-status 201 (call :post (str "/api/v1/tokens/" sentence "/split") {:position 13}))
    (rel! s "sat" "Dogs")
    (let [r (declare! "relation" deps "ud" [{:type "same-ancestor" :token-layer sl}])]
      (assert-status 422 r)
      (is (= (str (:doc s)) (-> r :body :violations first :document))))
    (is (= "{}" (:constraints (psc/fetch-by-id db :relation_layers deps)))
        "nothing is stored")))

(deftest a-text-save-that-splits-a-sentence-is-remedied
  (let [{:keys [deps sl txt sentence] :as s} (setup!)
        sat-dogs (id (rel! s "sat" "Dogs"))]
    (assert-status 200 (declare! "relation" deps "ud" [{:type "same-ancestor" :token-layer sl}]))
    ;; Shrinking the sentence token puts Dogs outside every sentence.
    (assert-status 200 (call :patch (str "/api/v1/tokens/" sentence) {:end 12}))
    (is (not (exists? :relations sat-dogs)))
    (is (some? txt))))

(deftest deleting-the-ancestor-layer-drops-the-constraint
  (let [{:keys [deps sl] :as s} (setup!)]
    (assert-status 200 (declare! "relation" deps "ud" [{:type "same-ancestor" :token-layer sl}
                                                       {:type "max-in-degree" :max 1}]))
    (is (some? s))
    ;; Deleting the sentence layer deletes the words under it too, and the
    ;; relation layer with them, so drop the relation layer's own parent
    ;; last: here a second relation layer on another word layer names it.
    (let [wl2 (id (create-token-layer-opts admin-request (:tl s) "W2" {:overlap-mode "non-overlapping"}))
          sl2 (id (create-span-layer admin-request wl2 "S2"))
          rl2 (id (create-relation-layer admin-request sl2 "R2"))]
      (assert-status 200 (declare! "relation" rl2 "ud" [{:type "same-ancestor" :token-layer sl}
                                                        {:type "max-in-degree" :max 1}]))
      (assert-status 204 (call :delete (str "/api/v1/token-layers/" sl)))
      (is (= {"ud" [{"type" "max-in-degree" "max" 1}]}
             (psc/parse-config (:constraints (psc/fetch-by-id db :relation_layers rl2))))))))

;; ============================================================
;; coextensive
;; ============================================================

(deftest coextensive-refuses-a-child-at-stale-offsets
  (let [{:keys [swl txt] :as s} (setup!)]
    (assert-status 200 (declare! "token" swl "ud" [{:type "coextensive"}]))
    (let [r (create-token admin-request swl txt 4 6)]
      (assert-status 422 r)
      (is (= "coextensive" (-> r :body :violations first :constraint)))
      (is (re-find #"extent of any token of layer \"Word\"" (-> r :body :error))))
    (testing "several children may share one word's extent"
      (assert-status 201 (create-token admin-request swl txt 4 7)))
    (is (some? s))))

(deftest a-word-merge-deletes-the-children-it-orphans
  (let [{:keys [swl tok sw doc] :as s} (setup!)]
    (assert-status 200 (declare! "token" swl "ud" [{:type "coextensive"}]))
    (assert-status 200 (call :post (str "/api/v1/tokens/" (tok "cat") "/merge") {:other-token-id (tok "sat")}))
    (is (not (exists? :tokens (sw "cat"))))
    (is (not (exists? :tokens (sw "sat"))))
    (is (exists? :tokens (sw "The")))
    (is (= 1 (count (ops-of doc "layer/apply-constraints"))))
    (is (some? s))))

(deftest a-text-save-that-breaks-a-word-deletes-its-children
  (let [{:keys [swl txt sw] :as s} (setup!)]
    (assert-status 200 (declare! "token" swl "ud" [{:type "coextensive"}]))
    ;; "cat" respelled "cart" keeps its word and its full-width child.
    (assert-status 200 (call :patch (str "/api/v1/texts/" txt) {:body "The cart sat. Dogs ran."}))
    (is (exists? :tokens (sw "cat")))
    (is (some? s))))

;; ============================================================
;; single-link
;; ============================================================

(deftest single-link-refuses-a-second-link
  (let [{:keys [wl tok item vocab] :as s} (setup!)]
    (assert-status 200 (declare! "token" wl "igt" [{:type "single-link"}]))
    (assert-status 201 (create-vocab-link admin-request item [(tok "cat")]))
    (let [other (id (create-vocab-item admin-request vocab "kat"))
          r (create-vocab-link admin-request other [(tok "cat")])]
      (assert-status 422 r)
      (is (= "single-link" (-> r :body :violations first :constraint))))
    (testing "a link over two tokens does not count"
      (assert-status 201 (create-vocab-link admin-request item [(tok "cat") (tok "sat")])))
    (is (some? s))))

(deftest a-word-merge-keeps-the-survivors-link
  (let [{:keys [wl tok item vocab] :as s} (setup!)
        mine (id (create-vocab-link admin-request item [(tok "cat")]))
        other (id (create-vocab-link admin-request (id (create-vocab-item admin-request vocab "sat")) [(tok "sat")]))]
    (assert-status 200 (declare! "token" wl "igt" [{:type "single-link"}]))
    (assert-status 200 (call :post (str "/api/v1/tokens/" (tok "cat") "/merge") {:other-token-id (tok "sat")}))
    (is (exists? :vocab_links mine))
    (is (not (exists? :vocab_links other)))
    (is (some? s))))

;; ============================================================
;; Batches, versions, and the cost when nothing is declared
;; ============================================================

(deftest a-batch-answers-the-versions-its-remedies-reached
  (let [{:keys [deps sl sentence doc] :as s} (setup!)]
    (rel! s "sat" "Dogs")
    (assert-status 200 (declare! "relation" deps "ud" [{:type "same-ancestor" :token-layer sl}]))
    (let [r (batch [{:path (str "/api/v1/tokens/" sentence "/split") :method "POST" :body {:position 13}}])
          header (get-in r [:headers "X-Document-Versions"])]
      (assert-status 200 r)
      (is (string? header) (pr-str r))
      (is (= (version doc) (get (json/read-str header) (str doc)))))))

(deftest nothing-declared-costs-three-reads
  (let [{:keys [lemma tok]} (setup!)
        lc-finish (requiring-resolve 'plaid.sql.constraints.layer/finish!)
        n (atom 0)
        seen (atom [])
        q psc/q]
    (with-redefs [psc/q (let [me (Thread/currentThread)]
                          (fn [& args]
                            ;; The two-argument call goes on to the
                            ;; three-argument one, so count that one.
                            (when (and (= me (Thread/currentThread)) (= 3 (count args)))
                              (swap! n inc)
                              (swap! seen conj (second args)))
                            (apply q args)))]
      (let [before @n]
        (binding [plaid.sql.audit-write/*pending* (atom {["spans" (random-uuid)] {:table "spans" :doc (random-uuid)}})]
          (lc-finish db nil))
        (is (= 3 (- @n before)) (pr-str @seen))))
    (is (some? lemma))
    (is (some? tok))))
