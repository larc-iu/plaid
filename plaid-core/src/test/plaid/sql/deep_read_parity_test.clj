(ns plaid.sql.deep-read-parity-test
  "One assembler, two sources.

  The live deep read (`plaid.sql.document/get-with-layer-data`, over the
  OLTP tables) and the as-of read
  (`plaid.history.read/get-with-layer-data-at`, over the audit log) both
  hand their rows to `plaid.sql.document-rows/assemble`. So the same
  state must read back the same way through either, down to key order.

  `plaid.history.read-test` asserts equality for one scenario. This
  namespace pins what the two reads used to decide for themselves, each
  in its own reduce over its own row shape: which order a token layer's
  vocabulary links arrive in, which order a vocabulary's maintainers
  arrive in, and which order tokens, spans and relations arrive in. It
  also pins that the assembler, not its caller, decides all of that —
  hand it the same rows shuffled and it must build the same document."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-test-users
                                    assert-created assert-ok assert-no-content
                                    assert-status with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.sql.document-rows :as drows]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- latest-op-ts []
  (:ts (psc/q1 db {:select [:ts] :from [:operations]
                   :order-by [[:ts :desc]] :limit 1})))

;; ============================================================
;; A scenario aimed at the orders
;; ============================================================

(defn- build-scenario!
  "Two text layers, two token layers over the first text, tokens that
  only the canonical token order sorts (same extent with and without a
  precedence, a zero-width one), spans, relations, two vocabularies
  whose links interleave on one token layer, maintainers added in
  reverse order, and metadata on every kind."
  []
  (let [proj (create-test-project admin-request "Parity")
        doc-id (create-test-document admin-request proj "Doc")
        ;; "the quick brown fox" — the 0-3, quick 4-9, brown 10-15, fox 16-19.
        tl1 (-> (create-text-layer admin-request proj "First") :body :id)
        tl2 (-> (create-text-layer admin-request proj "Second") :body :id)
        text1 (-> (create-text admin-request tl1 doc-id "the quick brown fox" {"lang" "en"})
                  :body :id)
        text2 (-> (create-text admin-request tl2 doc-id "aside") :body :id)
        words (-> (create-token-layer-opts admin-request tl1 "Words" {:overlap-mode "any"})
                  :body :id)
        morphs (-> (create-token-layer-opts admin-request tl1 "Morphemes" {:overlap-mode "any"})
                   :body :id)
        aside (-> (create-token-layer admin-request tl2 "Aside") :body :id)
        pos (-> (create-span-layer admin-request words "POS") :body :id)
        dep (-> (create-relation-layer admin-request pos "Dependencies") :body :id)
        ;; Same extent, one with a precedence and one without: only the
        ;; canonical order (precedence outranks extent, NULLS LAST) separates
        ;; them, and it must separate them the same way in both reads.
        t-the (-> (create-token admin-request words text1 0 3 nil {"n" 1}) :body :id)
        t-quick (-> (create-token admin-request words text1 4 9) :body :id)
        t-quick-alt (-> (create-token admin-request words text1 4 9 1) :body :id)
        t-empty (-> (create-token admin-request words text1 10 10) :body :id)
        t-fox (-> (create-token admin-request words text1 16 19) :body :id)
        m-the (-> (create-token admin-request morphs text1 0 3) :body :id)
        m-fox (-> (create-token admin-request morphs text1 16 19) :body :id)
        a-tok (-> (create-token admin-request aside text2 0 5) :body :id)
        s-det (-> (create-span admin-request pos [t-the] "DET" {"conf" 0.5}) :body :id)
        s-adj (-> (create-span admin-request pos [t-quick t-quick-alt] "ADJ") :body :id)
        s-noun (-> (create-span admin-request pos [t-fox] "NOUN") :body :id)
        _ (assert-created (create-relation admin-request dep s-adj s-noun "amod" {"by" "hand"}))
        _ (assert-created (create-relation admin-request dep s-det s-noun "det"))
        lex (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        gloss (-> (create-vocab-layer admin-request "Glosses") :body :id)
        _ (assert-status 204 (link-vocab-to-project admin-request proj lex))
        _ (assert-status 204 (link-vocab-to-project admin-request proj gloss))
        ;; Added highest-id-first, so the sorted list is not the insertion list.
        _ (assert-status 204 (add-vocab-maintainer admin-request lex "user2@example.com"))
        _ (assert-status 204 (add-vocab-maintainer admin-request lex "user1@example.com"))
        i-the (-> (create-vocab-item admin-request lex "the") :body :id)
        i-fox (-> (create-vocab-item admin-request lex "fox") :body :id)
        g-def (-> (create-vocab-item admin-request gloss "DEF") :body :id)
        ;; Links from two vocabularies interleaved on one token layer, so a
        ;; read that walks a hash map instead of the links serves them in an
        ;; order of its own.
        links (mapv (fn [[item tok meta]]
                      (-> (if meta
                            (create-vocab-link admin-request item [tok] meta)
                            (create-vocab-link admin-request item [tok]))
                          :body :id))
                    [[i-the t-the {"src" "manual"}]
                     [g-def t-the nil]
                     [i-fox t-fox nil]
                     [g-def t-quick nil]
                     [i-the m-the nil]
                     [g-def m-fox nil]])]
    (assert-ok (update-text-metadata admin-request text1 {"note" "primary"}))
    (assert-ok (update-span-metadata admin-request s-noun {"dc/source" "test"}))
    (assert-ok (update-document-metadata admin-request doc-id {"lang" "en" "dc/title" "T"}))
    {:project proj :document doc-id
     :text-layers [tl1 tl2] :texts [text1 text2]
     :token-layers [words morphs aside]
     :tokens [t-the t-quick t-quick-alt t-empty t-fox m-the m-fox a-tok]
     :spans [s-det s-adj s-noun]
     :vocabs [lex gloss] :items [i-the i-fox g-def] :links links}))

(defn- token-layers-of
  "Every token layer in a deep read, flattened out of the text layers."
  [deep]
  (mapcat :text-layer/token-layers (:document/text-layers deep)))

;; ============================================================
;; Parity
;; ============================================================

(deftest live-and-as-of-reads-are-identical
  (let [{:keys [document]} (build-scenario!)
        live (doc/get-with-layer-data db document)
        at-now (hread/get-with-layer-data-at db document (latest-op-ts))]
    (testing "the two reads are equal"
      (is (= live at-now)))
    (testing "and print identically, so even key order matches"
      (is (= (pr-str live) (pr-str at-now))))
    (testing "the scenario reached every kind, so the equality means something"
      (let [tls (token-layers-of live)]
        (is (= 3 (count tls)))
        (is (= 8 (reduce + (map (comp count :token-layer/tokens) tls))))
        (is (= 3 (count (mapcat :span-layer/spans (mapcat :token-layer/span-layers tls)))))
        (is (= 2 (count (mapcat :relation-layer/relations
                                (mapcat :span-layer/relation-layers
                                        (mapcat :token-layer/span-layers tls))))))
        (is (= 6 (count (for [tl tls, v (:token-layer/vocabs tl)
                              l (:vocab-layer/vocab-links v)]
                          l))))))))

(deftest live-and-as-of-reads-stay-identical-after-edits
  (let [{:keys [document tokens spans]} (build-scenario!)
        ;; Deleting a token trims the spans over it and drops its links, which
        ;; is where the two reads have to agree about rows that are gone.
        _ (assert-no-content (delete-token admin-request (first tokens)))
        _ (assert-ok (update-span admin-request (second spans) :value "ADV"))]
    (is (= (doc/get-with-layer-data db document)
           (hread/get-with-layer-data-at db document (latest-op-ts))))
    (is (= (pr-str (doc/get-with-layer-data db document))
           (pr-str (hread/get-with-layer-data-at db document (latest-op-ts)))))))

;; ============================================================
;; The orders themselves
;; ============================================================

(deftest every-order-in-the-read-is-decided-by-id-or-by-rank
  (let [{:keys [document]} (build-scenario!)
        live (doc/get-with-layer-data db document)
        tls (token-layers-of live)]
    (testing "a token layer's links arrive in id order, whichever vocabulary they are from"
      (doseq [tl tls, v (:token-layer/vocabs tl)]
        (let [own (mapv (comp str :vocab-link/id) (:vocab-layer/vocab-links v))]
          (is (= (sort own) own)))))
    (testing "a vocabulary's maintainers arrive sorted"
      (doseq [tl tls, v (:token-layer/vocabs tl)]
        (is (= (sort (:vocab/maintainers v)) (:vocab/maintainers v)))))
    (testing "the maintainers are sorted, not in the order they were added in"
      ;; The vocabulary's creator is a maintainer, then user2, then user1.
      (is (some #{["admin@example.com" "user1@example.com" "user2@example.com"]}
                (for [tl tls, v (:token-layer/vocabs tl)]
                  (:vocab/maintainers v)))))
    (testing "tokens arrive in the canonical order: begin, then precedence NULLS LAST, then end"
      (let [words (first tls)
            ts (:token-layer/tokens words)]
        (is (= [[0 nil] [4 1] [4 nil] [10 nil] [16 nil]]
               (mapv (juxt :token/begin :token/precedence) ts)))))
    (testing "spans and relations arrive in id order"
      (doseq [tl tls, sl (:token-layer/span-layers tl)]
        (let [ids (mapv (comp str :span/id) (:span-layer/spans sl))]
          (is (= (sort ids) ids)))
        (doseq [rl (:span-layer/relation-layers sl)]
          (let [ids (mapv (comp str :relation/id) (:relation-layer/relations rl))]
            (is (= (sort ids) ids))))))))

;; ============================================================
;; The assembler, not its caller, decides the order
;; ============================================================

(defn- assembler-input
  "Everything `assemble` takes for one document, read straight from the
  tables: the `read-rows` shape plus the project's layers and the
  vocabulary its links name."
  [doc-id]
  (let [rows (drows/read-rows db doc-id)
        prj (:project_id (:document rows))
        by (fn [table col ids]
             (if (empty? ids) [] (drows/q-in db table col (vec ids))))
        text-layers (psc/q db {:select [:*] :from [:text_layers] :where [:= :project_id prj]})
        token-layers (by :token_layers :text_layer_id (map :id text-layers))
        span-layers (by :span_layers :token_layer_id (map :id token-layers))
        relation-layers (by :relation_layers :span_layer_id (map :id span-layers))
        items (by :vocab_items :id (distinct (map :vocab_item_id (:vocab-links rows))))
        vocabs (by :vocab_layers :id (distinct (map :vocab_layer_id items)))
        maintainers (group-by :vocab_layer_id
                              (by :vocab_maintainers :vocab_layer_id (map :id vocabs)))]
    {:text-layers text-layers
     :token-layers token-layers
     :span-layers span-layers
     :relation-layers relation-layers
     :texts (:texts rows)
     :tokens (:tokens rows)
     :spans (:spans rows)
     :relations (:relations rows)
     :vocab-links (:vocab-links rows)
     :vocab-items items
     :vocab-layers (mapv (fn [v] (assoc v :maintainers
                                        (mapv :user_id (get maintainers (:id v) []))))
                         vocabs)}))

(deftest shuffling-the-rows-does-not-change-the-document
  (let [{:keys [document]} (build-scenario!)
        doc (doc/get db document)
        input (assembler-input document)
        reversed (update-vals input (fn [v] (if (sequential? v) (vec (reverse v)) v)))]
    (testing "the rows as read assemble into the live read"
      (is (= (doc/get-with-layer-data db document) (drows/assemble doc input))))
    (testing "the same rows reversed assemble into exactly the same document"
      (is (= (pr-str (drows/assemble doc input))
             (pr-str (drows/assemble doc reversed)))))))
