(ns plaid.history.restore-order-test
  "A restore that crosses rows made, moved and deleted after its time:
  every case is restored, then undone by a restore to the moment before,
  and after each the live read equals the state it names, the as-of read
  at the latest operation equals the live read, and a restore to that
  latest time would change nothing (no row went without its audit row)."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-created assert-ok assert-no-content
                                    assert-status with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.history.restore :as restore]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- latest-op-ts []
  (:ts (psc/q1 db {:select [:ts] :from [:operations] :order-by [[:ts :desc]] :limit 1})))

(defn- restore! [doc-id ts]
  (api-call admin-request {:method :post
                           :path (str "/api/v1/documents/" doc-id "/restore?as-of="
                                      (java.net.URLEncoder/encode (str ts) "UTF-8"))}))

(defn- comparable [deep]
  (dissoc deep :document/version :document/time-modified :document/media-url))

(defn- live [doc-id] (comparable (doc/get-with-layer-data db doc-id)))

(defn- check-coherent [doc-id what]
  (is (= (live doc-id) (comparable (hread/get-with-layer-data-at db doc-id (latest-op-ts))))
      (str what ": the as-of read at the latest operation equals the live read"))
  (is (zero? (:total (restore/preview db doc-id (java.time.Instant/parse (latest-op-ts)))))
      (str what ": the audit log folds to the live rows")))

(defn- id-of [resp] (-> resp :body :id))

(defn- restore-and-undo!
  "Restore `doc-id` to `t`, whose live read was `at-t`, then undo it."
  [doc-id t at-t]
  (let [before (live doc-id)
        t0 (latest-op-ts)]
    (assert-ok (restore! doc-id t))
    (is (= at-t (live doc-id)) "restored exactly")
    (check-coherent doc-id "after the restore")
    (assert-ok (restore! doc-id t0))
    (is (= before (live doc-id)) "undone exactly")
    (check-coherent doc-id "after the undo")))

(defn- stack!
  "A text \"aa bb cc dd\" with a word layer, a morpheme layer under it, a
  span layer on each, a relation layer on the word spans and a vocabulary."
  []
  (let [proj (create-test-project admin-request "Order")
        tl (id-of (create-text-layer admin-request proj "Text"))
        word (id-of (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}))
        morph (id-of (create-token-layer-opts admin-request tl "Morphemes" {:parent-token-layer-id word}))
        sl (id-of (create-span-layer admin-request word "Lemma"))
        ml (id-of (create-span-layer admin-request morph "Gloss"))
        rl (id-of (create-relation-layer admin-request sl "Deps"))
        vocab (id-of (create-vocab-layer admin-request "Lex"))
        _ (link-vocab-to-project admin-request proj vocab)
        item (id-of (create-vocab-item admin-request vocab "aa"))
        doc-id (create-test-document admin-request proj "Doc")
        text-id (id-of (create-text admin-request tl doc-id "aa bb cc dd"))]
    {:proj proj :tl tl :word word :morph morph :sl sl :ml ml :rl rl :item item
     :doc-id doc-id :text-id text-id}))

(defn- words! [{:keys [word sl text-id]}]
  (vec (for [b [0 3 6 9]]
         (let [t (id-of (create-token admin-request word text-id b (+ b 2)))]
           [t (id-of (create-span admin-request sl [t] (str "w" b)))]))))

(deftest a-text-replaced-with-annotations-on-both-sides
  (let [{:keys [doc-id tl word sl rl item text-id] :as s} (stack!)
        ws (words! s)
        _ (create-relation admin-request rl (second (ws 0)) (second (ws 1)) "nsubj")
        _ (create-vocab-link admin-request item [(first (ws 0))])
        _ (update-text-metadata admin-request text-id {"lang" "x"})
        t (latest-op-ts)
        at-t (live doc-id)]
    (assert-no-content (delete-text admin-request text-id))
    (let [newer (id-of (create-text admin-request tl doc-id "zz yy"))
          a (id-of (create-token admin-request word newer 0 2))
          b (id-of (create-token admin-request word newer 3 5))
          sa (id-of (create-span admin-request sl [a] "z"))
          sb (id-of (create-span admin-request sl [b] "y"))]
      (create-relation admin-request rl sa sb "obj")
      (create-vocab-link admin-request item [a])
      (restore-and-undo! doc-id t at-t))))

(deftest a-token-split-and-merged-after-t
  (let [{:keys [doc-id word morph ml rl item text-id] :as s} (stack!)
        ws (words! s)
        [t1 s1] (ws 1)
        m (id-of (create-token admin-request morph text-id 3 5))
        _ (create-span admin-request ml [m] "g")
        _ (create-relation admin-request rl (second (ws 0)) s1 "nsubj")
        _ (create-vocab-link admin-request item [t1])
        _ (create-vocab-link admin-request item [(first (ws 2)) (first (ws 3))])
        t (latest-op-ts)
        at-t (live doc-id)]
    (assert-created (split-token admin-request t1 4))
    (assert-ok (merge-tokens admin-request (first (ws 2)) (first (ws 3))))
    (restore-and-undo! doc-id t at-t)
    ;; and the other way: split after a merge
    (let [t2 (latest-op-ts)
          at-t2 (live doc-id)]
      (assert-ok (merge-tokens admin-request (first (ws 0)) t1))
      (let [toks (->> (psc/q db {:select [:id :begin] :from :tokens
                                 :where [:and [:= :token_layer_id word] [:= :document_id doc-id]]})
                      (sort-by :begin))]
        (assert-created (split-token admin-request (str (:id (last toks))) 10)))
      (restore-and-undo! doc-id t2 at-t2))))

(deftest a-span-moved-between-tokens-and-back
  (let [{:keys [doc-id word text-id rl] :as s} (stack!)
        ws (words! s)
        [t0 s0] (ws 0)
        _ (create-relation admin-request rl s0 (second (ws 1)) "nsubj")
        t (latest-op-ts)
        at-t (live doc-id)
        n1 (id-of (create-token admin-request word text-id 2 3))]
    (assert-ok (update-span-tokens admin-request s0 [n1]))
    (let [mid (latest-op-ts)
          at-mid (live doc-id)
          n2 (id-of (create-token admin-request word text-id 5 6))]
      (assert-ok (update-span-tokens admin-request s0 [n2 t0]))
      (assert-ok (update-span-tokens admin-request s0 [t0]))
      (assert-no-content (delete-token admin-request n1))
      ;; back to where the span sat on a token now gone
      (restore-and-undo! doc-id mid at-mid)
      (restore-and-undo! doc-id t at-t))))

(deftest a-relation-whose-both-spans-changed
  (let [{:keys [doc-id word sl rl text-id] :as s} (stack!)
        ws (words! s)
        rel (id-of (create-relation admin-request rl (second (ws 0)) (second (ws 1)) "nsubj"))
        t (latest-op-ts)
        at-t (live doc-id)
        n (id-of (create-token admin-request word text-id 2 3))
        na (id-of (create-span admin-request sl [n] "new"))
        nb (id-of (create-span admin-request sl [(first (ws 2))] "new2"))]
    (assert-ok (update-relation-source admin-request rel na))
    (assert-ok (update-relation-target admin-request rel nb))
    (assert-ok (update-relation admin-request rel "obj"))
    (assert-no-content (delete-span admin-request (second (ws 1))))
    (restore-and-undo! doc-id t at-t)
    ;; a relation swapped end for end, and one moved onto spans made later still
    (let [t2 (latest-op-ts)
          at-t2 (live doc-id)
          [_ x] (ws 3)]
      (assert-ok (update-relation-source admin-request rel x))
      (assert-ok (update-relation-target admin-request rel (second (ws 0))))
      (restore-and-undo! doc-id t2 at-t2))))

(deftest a-span-deleted-and-made-again-on-the-same-tokens
  (let [{:keys [doc-id sl rl] :as s} (stack!)
        ws (words! s)
        [t0 s0] (ws 0)
        _ (update-span-metadata admin-request s0 {"k" "v"})
        _ (create-relation admin-request rl s0 (second (ws 1)) "nsubj")
        t (latest-op-ts)
        at-t (live doc-id)]
    (assert-no-content (delete-span admin-request s0))
    (let [again (id-of (create-span admin-request sl [t0] "w0"))]
      (create-relation admin-request rl again (second (ws 1)) "nsubj")
      (create-relation admin-request rl (second (ws 2)) again "obj"))
    (restore-and-undo! doc-id t at-t)))

(deftest vocab-links-on-tokens-deleted-after-t
  (let [{:keys [doc-id item] :as s} (stack!)
        ws (words! s)
        _ (create-vocab-link admin-request item [(first (ws 0))] {"prov" "human"})
        _ (create-vocab-link admin-request item [(first (ws 1)) (first (ws 2))])
        t (latest-op-ts)
        at-t (live doc-id)]
    (assert-no-content (delete-token admin-request (first (ws 0))))
    (assert-no-content (delete-token admin-request (first (ws 2))))
    (restore-and-undo! doc-id t at-t)))

(deftest metadata-on-every-kind
  (let [{:keys [doc-id rl item text-id] :as s} (stack!)
        ws (words! s)
        [t0 s0] (ws 0)
        rel (id-of (create-relation admin-request rl s0 (second (ws 1)) "nsubj" {"r" 1}))
        link (id-of (create-vocab-link admin-request item [t0] {"l" 1}))
        _ (update-token-metadata admin-request t0 {"t" 1})
        _ (update-span-metadata admin-request s0 {"s" 1})
        _ (update-text-metadata admin-request text-id {"x" 1})
        _ (update-document-metadata admin-request doc-id {"d" 1})
        t (latest-op-ts)
        at-t (live doc-id)]
    (update-token-metadata admin-request t0 {"t" 2 "u" 3})
    (delete-span-metadata admin-request s0)
    (update-relation-metadata admin-request rel {"r" [1 2]})
    (update-vocab-link-metadata admin-request link {})
    (update-text-metadata admin-request text-id {"y" 1})
    (update-document-metadata admin-request doc-id {"d" 2})
    (update-span-metadata admin-request (second (ws 2)) {"new" true})
    (restore-and-undo! doc-id t at-t)))

(deftest a-restore-to-before-there-were-tokens
  (let [{:keys [doc-id rl item] :as s} (stack!)
        t (latest-op-ts)
        at-t (live doc-id)
        ws (words! s)]
    (create-relation admin-request rl (second (ws 0)) (second (ws 1)) "nsubj")
    (create-vocab-link admin-request item [(first (ws 0))])
    (restore-and-undo! doc-id t at-t)))

(deftest a-restore-to-before-there-was-a-text
  (let [proj (create-test-project admin-request "Empty")
        tl (id-of (create-text-layer admin-request proj "Text"))
        word (id-of (create-token-layer admin-request tl "Words"))
        sl (id-of (create-span-layer admin-request word "L"))
        doc-id (create-test-document admin-request proj "Doc")
        t (latest-op-ts)
        at-t (live doc-id)
        text-id (id-of (create-text admin-request tl doc-id "aa bb"))
        tok (id-of (create-token admin-request word text-id 0 2))]
    (create-span admin-request sl [tok] "x")
    (restore-and-undo! doc-id t at-t)))

(deftest a-document-three-apps-share
  ;; An igt stack, a ud stack and a umr stack, each on its own text layer
  ;; of one document, changed together after T.
  (let [proj (create-test-project admin-request "Shared")
        stack (fn [nm body]
                (let [tl (id-of (create-text-layer admin-request proj (str nm " text")))
                      word (id-of (create-token-layer-opts admin-request tl (str nm " words")
                                                           {:overlap-mode "non-overlapping"}))
                      sub (id-of (create-token-layer-opts admin-request tl (str nm " sub")
                                                          {:parent-token-layer-id word}))
                      sl (id-of (create-span-layer admin-request word (str nm " spans")))
                      subl (id-of (create-span-layer admin-request sub (str nm " sub spans")))
                      rl (id-of (create-relation-layer admin-request sl (str nm " relations")))]
                  {:tl tl :word word :sub sub :sl sl :subl subl :rl rl :body body}))
        stacks [(stack "igt" "aa bb cc") (stack "ud" "dd ee ff") (stack "umr" "gg hh ii")]
        vocab (id-of (create-vocab-layer admin-request "Lex"))
        _ (link-vocab-to-project admin-request proj vocab)
        item (id-of (create-vocab-item admin-request vocab "aa"))
        doc-id (create-test-document admin-request proj "Doc")
        built (vec (for [{:keys [tl word sub sl subl rl body] :as st} stacks]
                     (let [text-id (id-of (create-text admin-request tl doc-id body))
                           toks (vec (for [b [0 3 6]] (id-of (create-token admin-request word text-id b (+ b 2)))))
                           subs (vec (for [b [0 3 6]] (id-of (create-token admin-request sub text-id b (+ b 1)))))
                           spans (mapv #(id-of (create-span admin-request sl [%] "s")) toks)]
                       (doseq [x subs] (create-span admin-request subl [x] "m"))
                       (create-relation admin-request rl (spans 0) (spans 1) "r")
                       (create-relation admin-request rl (spans 1) (spans 2) "r")
                       (create-vocab-link admin-request item [(toks 0)])
                       (assoc st :text-id text-id :toks toks :spans spans))))
        t (latest-op-ts)
        at-t (live doc-id)]
    (doseq [{:keys [word sl rl text-id toks spans]} built]
      (let [n (id-of (create-token admin-request word text-id 2 3))
            ns (id-of (create-span admin-request sl [n] "n"))
            r (-> (psc/q db {:select [:id] :from :relations :where [:= :source_span_id (spans 0)]})
                  first :id str)]
        (assert-ok (update-relation-source admin-request r ns))
        (assert-created (split-token admin-request (toks 2) 7))
        (assert-ok (update-span-tokens admin-request (spans 1) [n]))
        (assert-no-content (delete-token admin-request (toks 1)))))
    (restore-and-undo! doc-id t at-t)))

(deftest a-large-document-in-time
  (let [proj (create-test-project admin-request "Large")
        tl (id-of (create-text-layer admin-request proj "Text"))
        word (id-of (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}))
        sl (id-of (create-span-layer admin-request word "Lemma"))
        rl (id-of (create-relation-layer admin-request sl "Deps"))
        doc-id (create-test-document admin-request proj "Doc")
        n 3000
        body (clojure.string/join " " (repeat n "ab"))
        text-id (id-of (create-text admin-request tl doc-id body))
        toks (-> (bulk-create-tokens admin-request
                                     (vec (for [i (range n)] {:token-layer-id word :text text-id
                                                              :begin (* 3 i) :end (+ (* 3 i) 2)})))
                 :body :ids)
        spans (-> (bulk-create-spans admin-request
                                     (vec (for [t toks] {:span-layer-id sl :tokens [t] :value "x"})))
                  :body :ids)
        rels (-> (bulk-create-relations admin-request
                                        (vec (for [[a b] (partition 2 spans)]
                                               {:relation-layer-id rl :source a :target b :value "r"})))
                 :body :ids)
        t (latest-op-ts)
        at-t (live doc-id)
        ;; every relation's source moves to a span on a new token
        new-toks (-> (bulk-create-tokens admin-request
                                         (vec (for [i (range 0 n 2)] {:token-layer-id word :text text-id
                                                                      :begin (+ (* 3 i) 2) :end (+ (* 3 i) 3)})))
                     :body :ids)
        new-spans (-> (bulk-create-spans admin-request
                                         (vec (for [t new-toks] {:span-layer-id sl :tokens [t] :value "y"})))
                      :body :ids)]
    (doseq [chunk (partition-all 500 (map vector rels new-spans))]
      (assert-ok (api-call admin-request
                           {:method :post :path "/api/v1/batch"
                            :body (vec (for [[r s] chunk]
                                         {:path (str "/api/v1/relations/" r "/source") :method "PUT"
                                          :body {:span-id s}}))})))
    (let [before (live doc-id)
          t0 (latest-op-ts)
          timed (fn [ts]
                  (let [start (System/nanoTime)]
                    (assert-ok (restore! doc-id ts))
                    (/ (- (System/nanoTime) start) 1e6)))
          ms (timed t)
          _ (is (= at-t (live doc-id)))
          _ (check-coherent doc-id "large")
          undo-ms (timed t0)]
      (when-let [f (System/getenv "PLAID_RESTORE_TIMING")]
        (spit f (str "restore of " n " tokens, " (count rels) " relations moved back: " (long ms)
                     " ms, undone in " (long undo-ms) " ms\n")
              :append true))
      (is (< ms 30000))
      (is (< undo-ms 30000))
      (is (= before (live doc-id)))
      (check-coherent doc-id "large, undone"))))
