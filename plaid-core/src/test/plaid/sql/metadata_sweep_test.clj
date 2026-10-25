(ns plaid.sql.metadata-sweep-test
  "`entity_metadata` has no FK, so every delete path sweeps the metadata of
  the rows it removes by hand. Each case here builds a document whose every
  row carries metadata, runs one delete path, and asserts that no metadata
  row is left without its parent row. No route writes a layer's metadata,
  so the layers get theirs by hand."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler admin-request
                                    api-call assert-success with-admin with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private parent-table
  {"document" "documents" "text" "texts" "token" "tokens" "span" "spans" "relation" "relations"
   "vocab-item" "vocab_items" "vocab-link" "vocab_links" "text-layer" "text_layers"
   "token-layer" "token_layers" "span-layer" "span_layers" "relation-layer" "relation_layers"})

(defn- orphans
  "The `[entity_type entity_id]` of every metadata row whose parent row is gone."
  []
  (into []
        (mapcat (fn [[etype table]]
                  (map (juxt (constantly etype) :entity_id)
                       (psc/q db [(str "SELECT em.entity_id FROM entity_metadata em WHERE em.entity_type = ?"
                                       " AND NOT EXISTS (SELECT 1 FROM " table " t WHERE t.id = em.entity_id)")
                                  etype]))))
        parent-table))

(defn- drop-orphans!
  "Delete every metadata row whose parent row is gone, so that an orphan one
  case leaves fails that case only."
  []
  (doseq [[etype table] parent-table]
    (psc/execute! db [(str "DELETE FROM entity_metadata WHERE entity_type = ?"
                           " AND NOT EXISTS (SELECT 1 FROM " table " t WHERE t.id = entity_metadata.entity_id)")
                      etype])))

(defn- metadata-types
  "The entity types that hold any metadata now."
  []
  (set (map :entity_type (psc/q db {:select-distinct [:entity_type] :from [:entity_metadata]}))))

(defn- entities-with-metadata
  "How many rows carry metadata now."
  []
  (count (psc/q db {:select-distinct [:entity_type :entity_id] :from [:entity_metadata]})))

(defn- call [method path & [body]]
  (api-call admin-request (cond-> {:method method :path (str "/api/v1" path)} body (assoc :body body))))

(defn- world
  "A project with one document: a text, three word tokens, a span on each
  and a second one on the first (`s4`), two relations, three entries and
  four links (`l4` puts a second entry on the first word), every one of
  them and each of the four layers with metadata."
  []
  (let [md {"note" "x"}
        proj (create-test-project admin-request (str "Sweep " (random-uuid)))
        doc (create-test-document admin-request proj "Doc")
        tl (id (create-text-layer admin-request proj "TL"))
        text (id (create-text admin-request tl doc "dogs run cat"))
        wl (id (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}))
        [t1 t2 t3] (-> (bulk-create-tokens admin-request
                                           (mapv (fn [[b e]] {:token-layer-id wl :text text :begin b :end e})
                                                 [[0 4] [5 8] [9 12]]))
                       :body :ids)
        sl (id (create-span-layer admin-request wl "Spans"))
        [s1 s2 s3 s4] (mapv #(id (create-span admin-request sl [%1] %2)) [t1 t2 t3 t1] ["A" "B" "C" "D"])
        rl (id (create-relation-layer admin-request sl "Rels"))
        r1 (id (create-relation admin-request rl s1 s2 "dep"))
        r2 (id (create-relation admin-request rl s2 s3 "dep"))
        vocab (id (create-vocab-layer admin-request (str "V " (random-uuid))))
        _ (link-vocab-to-project admin-request proj vocab)
        [i1 i2 i3] (mapv #(id (create-vocab-item admin-request vocab %)) ["dogs" "run" "cat"])
        l1 (id (create-vocab-link admin-request i1 [t1]))
        l2 (id (create-vocab-link admin-request i2 [t2]))
        l3 (id (create-vocab-link admin-request i1 [t3]))
        l4 (id (create-vocab-link admin-request i2 [t1]))]
    (assert-success (update-document-metadata admin-request doc md))
    (assert-success (update-text-metadata admin-request text md))
    (doseq [t [t1 t2 t3]] (assert-success (update-token-metadata admin-request t md)))
    (doseq [s [s1 s2 s3 s4]] (assert-success (update-span-metadata admin-request s md)))
    (doseq [r [r1 r2]] (assert-success (update-relation-metadata admin-request r md)))
    (doseq [i [i1 i2 i3]] (assert-success (update-vocab-item-metadata admin-request i md)))
    (doseq [l [l1 l2 l3 l4]] (assert-success (update-vocab-link-metadata admin-request l md)))
    (doseq [[etype eid] [["text-layer" tl] ["token-layer" wl] ["span-layer" sl] ["relation-layer" rl]]]
      (psc/execute! db ["INSERT INTO entity_metadata (entity_type, entity_id, key, value) VALUES (?, ?, ?, ?)"
                        etype (str eid) "note" "\"x\""]))
    {:proj proj :doc doc :tl tl :wl wl :sl sl :rl rl :vocab vocab
     :t1 t1 :s1 s1 :s2 s2 :r1 r1 :r2 r2 :i1 i1 :i2 i2 :l1 l1 :l2 l2}))

(def ^:private cases
  [["a span delete" (fn [{:keys [s1]}] (call :delete (str "/spans/" s1)))]
   ["a span bulk delete" (fn [{:keys [s1 s2]}] (bulk-delete-spans admin-request [s1 s2]))]
   ["a relation delete" (fn [{:keys [r1]}] (call :delete (str "/relations/" r1)))]
   ["a relation bulk delete" (fn [{:keys [r1 r2]}] (bulk-delete-relations admin-request [r1 r2]))]
   ["a vocab link delete" (fn [{:keys [l1]}] (call :delete (str "/vocab-links/" l1)))]
   ["a vocab link bulk delete" (fn [{:keys [l1 l2]}] (bulk-delete-vocab-links admin-request [l1 l2]))]
   ["an entry delete" (fn [{:keys [i1]}] (call :delete (str "/vocab-items/" i1)))]
   ["an entry bulk delete" (fn [{:keys [i1 i2]}] (bulk-delete-vocab-items admin-request [i1 i2]))]
   ["an entry merge" (fn [{:keys [i1 i2]}] (call :post (str "/vocab-items/" i1 "/merge") {:losers [i2]}))]
   ["a vocabulary delete" (fn [{:keys [vocab]}] (call :delete (str "/vocab-layers/" vocab)))]
   ["a vocabulary removed from the project"
    (fn [{:keys [proj vocab]}] (unlink-vocab-from-project admin-request proj vocab))]
   ["a token delete" (fn [{:keys [t1]}] (call :delete (str "/tokens/" t1)))]
   ["a relation layer delete" (fn [{:keys [rl]}] (call :delete (str "/relation-layers/" rl)))]
   ["a span layer delete" (fn [{:keys [sl]}] (call :delete (str "/span-layers/" sl)))]
   ["a token layer delete" (fn [{:keys [wl]}] (call :delete (str "/token-layers/" wl)))]
   ["a text layer delete" (fn [{:keys [tl]}] (call :delete (str "/text-layers/" tl)))]
   ["a document delete" (fn [{:keys [doc]}] (call :delete (str "/documents/" doc)))]
   ["a single-span repair"
    (fn [{:keys [sl]}]
      (call :post (str "/span-layers/" sl "/constraints/repair") {:constraints [{:type "single-span"}]}))]
   ["a single-link repair"
    (fn [{:keys [wl]}]
      (call :post (str "/token-layers/" wl "/constraints/repair") {:constraints [{:type "single-link"}]}))]])

(deftest every-delete-path-sweeps-the-metadata-of-what-it-removes
  (doseq [[label f] cases]
    (testing label
      (let [w (world)
            before (entities-with-metadata)]
        (is (= (set (keys parent-table)) (metadata-types)) "every kind of row carries metadata")
        (assert-success (f w))
        (is (< (entities-with-metadata) before) "the delete removed a row that carried metadata")
        (is (= [] (orphans)))
        ;; The next case starts from nothing.
        (drop-orphans!)
        (assert-success (delete-test-project admin-request (:proj w)))))))
