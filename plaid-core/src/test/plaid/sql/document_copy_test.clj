(ns plaid.sql.document-copy-test
  "Copying a document (plaid.sql.document/copy, POST /documents/:id/copy).

  The central claim: the copy holds the same content as the source under
  fresh ids, sharing the source's layers and vocabulary entries, and its
  history reads back like any other document's (reconstruction at the
  latest op equals the live read). Checked against a scenario touching
  every entity kind, plus what a copy must not do to the source."
  (:require [clojure.java.io :as io]
            [clojure.set :as set]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    with-test-users user1-request
                                    assert-created assert-ok assert-no-content
                                    assert-status with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.media.storage :as media]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.sql.document-rows :as drows]
            [plaid.test-helpers :refer :all])
  (:import [java.nio.file Files]
           [java.nio.file.attribute FileAttribute]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- latest-op-ts []
  (:ts (psc/q1 db {:select [:ts] :from [:operations]
                   :order-by [[:ts :desc]] :limit 1})))

(defn- copy! [req doc-id body]
  (api-call req {:method :post :path (str "/api/v1/documents/" doc-id "/copy") :body body}))

(defn- comparable [deep]
  (dissoc deep :document/version :document/time-modified :document/media-url))

(defn- live [doc-id] (comparable (doc/get-with-layer-data db doc-id)))

;; ============================================================
;; Content signatures
;;
;; A copy has every id different, so equality has to be stated in terms
;; of what a row IS rather than what it is called: its own columns, its
;; metadata, and the SIGNATURE of whatever it points at, recursively
;; down to the text. Comparing the two documents' signature multisets
;; per kind is then independent of both ids and read order, and a
;; mis-mapped text, token list or span reference shows up as a
;; mismatch rather than as an equal count.
;; ============================================================

(defn- signatures
  "`{:texts #{...} :tokens #{...} ...}` for one document, as frequencies
  so a duplicated row cannot pass as its twin."
  [doc-id]
  (let [{:keys [texts tokens spans relations vocab-links]} (drows/read-rows db doc-id)
        meta-of (fn [r] (or (:metadata r) {}))
        text-sig (into {} (map (fn [t] [(:id t) [(:text_layer_id t) (:body t) (meta-of t)]])) texts)
        token-sig (into {} (map (fn [t] [(:id t) [(:token_layer_id t)
                                                  (text-sig (:text_id t))
                                                  (:begin t) (:end_ t) (:precedence t)
                                                  (meta-of t)]]))
                        tokens)
        span-sig (into {} (map (fn [s] [(:id s) [(:span_layer_id s) (:value s)
                                                 (mapv token-sig (drows/tokens-of s))
                                                 (meta-of s)]]))
                       spans)]
    {:texts (frequencies (vals text-sig))
     :tokens (frequencies (vals token-sig))
     :spans (frequencies (vals span-sig))
     :relations (frequencies (map (fn [r] [(:relation_layer_id r)
                                           (span-sig (:source_span_id r))
                                           (span-sig (:target_span_id r))
                                           (:value r) (meta-of r)])
                                  relations))
     :vocab-links (frequencies (map (fn [l] [(:vocab_item_id l)
                                             (mapv token-sig (drows/tokens-of l))
                                             (meta-of l)])
                                    vocab-links))}))

(defn- row-ids
  "Every entity id the document owns, as a set."
  [doc-id]
  (let [rows (drows/read-rows db doc-id)]
    (into #{} (comp (mapcat rows) (map :id))
          [:texts :tokens :spans :relations :vocab-links])))

;; ============================================================
;; The scenario: every entity kind
;; ============================================================

(defn- build-scenario!
  "A project with a partitioning sentence layer, a nested non-overlapping
  word layer, a nested morpheme layer, span layers on each, a relation
  layer, a linked vocabulary, and metadata everywhere."
  []
  (let [proj (create-test-project admin-request "Copy")
        doc-id (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "Text") :body :id)
        ;; "the quick brown fox jumps": the 0-3, quick 4-9, brown 10-15,
        ;; fox 16-19, jumps 20-25.
        text-id (-> (create-text admin-request tl doc-id "the quick brown fox jumps" {"lang" "en"})
                    :body :id)
        sent (-> (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"})
                 :body :id)
        word (-> (create-token-layer-opts admin-request tl "Words"
                                          {:overlap-mode "non-overlapping" :parent-token-layer-id sent})
                 :body :id)
        morph (-> (create-token-layer-opts admin-request tl "Morphemes"
                                           {:overlap-mode "any" :parent-token-layer-id word})
                  :body :id)
        pos (-> (create-span-layer admin-request word "POS") :body :id)
        gloss (-> (create-span-layer admin-request morph "Gloss") :body :id)
        trans (-> (create-span-layer admin-request sent "Translation") :body :id)
        dep (-> (create-relation-layer admin-request pos "Dependencies") :body :id)
        [s1] (-> (bulk-create-tokens admin-request
                                     [{:token-layer-id sent :text text-id :begin 0 :end 25}])
                 :body :ids)
        words (-> (bulk-create-tokens admin-request
                                      (mapv (fn [[b e]] {:token-layer-id word :text text-id :begin b :end e})
                                            [[0 3] [4 9] [10 15] [16 19] [20 25]]))
                  :body :ids)
        ;; Two morphemes over one extent, told apart by precedence.
        [m1 m2] (-> (bulk-create-tokens admin-request
                                        [{:token-layer-id morph :text text-id :begin 20 :end 25
                                          :precedence 1 :metadata {"form" "jump"}}
                                         {:token-layer-id morph :text text-id :begin 20 :end 25
                                          :precedence 2 :metadata {"form" "s"}}])
                    :body :ids)
        pos-spans (-> (bulk-create-spans admin-request
                                         (mapv (fn [t v] {:span-layer-id pos :tokens [t] :value v})
                                               words ["DET" "ADJ" "ADJ" "NOUN" "VERB"]))
                      :body :ids)
        [g1 g2] (-> (bulk-create-spans admin-request
                                       [{:span-layer-id gloss :tokens [m1] :value "jump"}
                                        {:span-layer-id gloss :tokens [m2] :value "3SG"}])
                    :body :ids)
        tr (-> (create-span admin-request trans [s1] "Le renard brun rapide saute" {"src" "human"})
               :body :id)
        rel (-> (create-relation admin-request dep (nth pos-spans 3) (nth pos-spans 4) "nsubj" {"conf" 0.9})
                :body :id)
        vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        _ (assert-status 204 (link-vocab-to-project admin-request proj vocab))
        fox-item (-> (create-vocab-item admin-request vocab "fox") :body :id)
        ;; One single-token link and one over two tokens, so the ordered
        ;; token list has something to get wrong.
        link (-> (create-vocab-link admin-request fox-item [(nth words 3)] {"prov" "human"}) :body :id)
        mwe (-> (create-vocab-link admin-request fox-item [(nth words 2) (nth words 3)]) :body :id)
        _ (assert-ok (update-document-metadata admin-request doc-id {"genre" "fable"}))
        _ (assert-ok (update-token-metadata admin-request (nth words 1) {"orthog:IPA" "kwɪk"}))]
    {:proj proj :doc-id doc-id :text-id text-id
     :sent sent :word word :morph morph :pos pos :gloss gloss :trans trans :dep dep
     :s1 s1 :words words :m1 m1 :m2 m2 :pos-spans pos-spans :g1 g1 :g2 g2 :tr tr
     :rel rel :vocab vocab :fox-item fox-item :link link :mwe mwe}))

(deftest copy-holds-the-same-content-under-fresh-ids
  (let [{:keys [doc-id]} (build-scenario!)
        before (live doc-id)
        resp (copy! admin-request doc-id {:name "Doc, copy"})
        new-id (-> resp :body :id)]
    (assert-created resp)
    (is (some? new-id))
    (is (not= doc-id new-id))

    (testing "every row is the same content"
      (is (= (signatures doc-id) (signatures new-id))))

    (testing "and none of it is the same row"
      (let [src (row-ids doc-id)
            cpy (row-ids new-id)]
        (is (= (count src) (count cpy)))
        (is (empty? (set/intersection src cpy)))))

    (testing "the copy is a document of its own: name, metadata, version"
      (let [deep (doc/get-with-layer-data db new-id)]
        (is (= "Doc, copy" (:document/name deep)))
        (is (= {"genre" "fable"} (:metadata deep)))
        (is (= 1 (:document/version deep)))
        (is (= (:document/project before) (:document/project deep)))))

    (testing "the source is untouched"
      (is (= before (live doc-id))))

    (testing "the vocabulary entry is shared, not copied"
      (let [item-ids (fn [doc] (set (map :vocab_item_id (:vocab-links (drows/read-rows db doc)))))]
        (is (= (item-ids doc-id) (item-ids new-id)))
        (is (= 1 (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:vocab_items]}))))))

    (testing "history reads back: reconstruction at the latest op equals the live read"
      (is (= (live new-id)
             (comparable (hread/get-with-layer-data-at db new-id (latest-op-ts))))))

    (testing "the copy is one operation of its own type, named by the documents' names"
      (let [op (psc/q1 db {:select [:op_type :description] :from [:operations]
                           :order-by [[:ts :desc]] :limit 1})]
        (is (= "document/copy" (:op_type op)))
        (is (= "Copy \"Doc\" as \"Doc, copy\"" (:description op)))))))

(deftest the-copy-is-editable-without-touching-the-source
  (let [{:keys [doc-id words]} (build-scenario!)
        new-id (-> (copy! admin-request doc-id {:name "Copy"}) :body :id)
        before (live doc-id)
        ;; The word the copy's own token stands for, found by extent.
        copied-word (->> (:tokens (drows/read-rows db new-id))
                         (filter #(and (= 16 (:begin %)) (= 19 (:end_ %))))
                         (map :id))]
    (is (= 1 (count copied-word)))
    (assert-no-content (bulk-delete-tokens admin-request (vec copied-word)))
    (is (= before (live doc-id)) "deleting in the copy left the source alone")
    (is (not= (signatures doc-id) (signatures new-id)))
    ;; The source's own token is still there.
    (assert-ok (get-token admin-request (nth words 3)))))

(deftest copy-refusals
  (let [{:keys [doc-id proj]} (build-scenario!)]
    (testing "an unknown document is a 404"
      (assert-status 404 (copy! admin-request (psc/new-uuid) {:name "No"})))
    (testing "an empty name is a 400"
      (assert-status 400 (copy! admin-request doc-id {:name ""})))
    (testing "a reader cannot copy"
      (assert-status 204 (add-project-reader admin-request proj "user1@example.com"))
      (assert-status 403 (copy! user1-request doc-id {:name "Mine"})))))

(deftest an-empty-document-copies
  (let [proj (create-test-project admin-request "Empty")
        doc-id (create-test-document admin-request proj "Nothing in it")
        resp (copy! admin-request doc-id {:name "Still nothing"})
        new-id (-> resp :body :id)]
    (assert-created resp)
    (is (= "Still nothing" (:document/name (doc/get-with-layer-data db new-id))))
    (is (empty? (row-ids new-id)))))

;; ============================================================
;; Metadata that names the document's own rows
;;
;; Apps keep ids of a document's own rows inside metadata (UMR records,
;; on an unaligned node's span, the id of its sentence token). In the
;; copy such a value must name the copy's row, or the copy points back
;; into the source and an app reads the reference as dangling.
;; ============================================================

(deftest metadata-naming-the-documents-own-rows-names-the-copys-rows
  (let [proj (create-test-project admin-request "CopyRefs")
        doc-id (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "Text") :body :id)
        text-id (-> (create-text admin-request tl doc-id "one two") :body :id)
        tkl (-> (create-token-layer admin-request tl "Words") :body :id)
        sl (-> (create-span-layer admin-request tkl "Nodes") :body :id)
        rl (-> (create-relation-layer admin-request sl "Edges") :body :id)
        one (-> (create-token admin-request tkl text-id 0 3) :body :id)
        two (-> (create-token admin-request tkl text-id 4 7) :body :id)
        a (-> (create-span admin-request sl [one] "a") :body :id)
        b (-> (create-span admin-request sl [two] "b") :body :id)
        rel (-> (create-relation admin-request rl a b "arg" {"from" (str a)}) :body :id)
        vocab (-> (create-vocab-layer admin-request "Lexicon") :body :id)
        _ (assert-status 204 (link-vocab-to-project admin-request proj vocab))
        item (-> (create-vocab-item admin-request vocab "one") :body :id)
        link (-> (create-vocab-link admin-request item [one] {"doc" (str doc-id)}) :body :id)
        b-meta {"umr" {"sentence" (str one)
                       "path" [(str one) [(str two)] {"at" (str text-id)}]}
                "edge" (str rel)
                "note" (str "see " one)
                "by-token" {(str one) "first"}
                "layer" (str tkl)
                "count" 2}]
    ;; A token naming a span is a forward reference: tokens are written
    ;; before spans. The text names a vocab link, written last of all.
    (assert-ok (update-token-metadata admin-request one {"node" (str b)}))
    (assert-ok (update-span-metadata admin-request b b-meta))
    (assert-ok (update-text-metadata admin-request text-id {"first-link" (str link)}))
    (assert-ok (update-document-metadata admin-request doc-id {"self" (str doc-id) "genre" "fable"}))
    (let [before (live doc-id)
          resp (copy! admin-request doc-id {:name "Copy"})
          new-id (-> resp :body :id)
          rows (drows/read-rows db new-id)
          only (fn [k] (let [rs (get rows k)] (is (= 1 (count rs))) (first rs)))
          token-at (into {} (map (juxt :begin identity)) (:tokens rows))
          span-over (into {} (map (juxt (comp first drows/tokens-of) identity)) (:spans rows))
          id-of (comp str :id)
          c-text (only :texts)
          c-rel (only :relations)
          c-link (only :vocab-links)
          c-one (token-at 0)
          c-two (token-at 4)
          c-a (span-over (:id c-one))
          c-b (span-over (:id c-two))]
      (assert-created resp)

      (testing "a span naming a token, nested in a map and in a vector, names the copy's token"
        (is (= {"umr" {"sentence" (id-of c-one)
                       "path" [(id-of c-one) [(id-of c-two)] {"at" (id-of c-text)}]}
                "edge" (id-of c-rel)}
               (select-keys (:metadata c-b) ["umr" "edge"]))))

      (testing "a token naming a span, a forward reference, names the copy's span"
        (is (= {"node" (id-of c-b)} (:metadata c-one))))

      (testing "relations, links and texts are rewritten and referred to alike"
        (is (= {"from" (id-of c-a)} (:metadata c-rel)))
        (is (= {"doc" (str new-id)} (:metadata c-link)))
        (is (= {"first-link" (id-of c-link)} (:metadata c-text))))

      (testing "the document's metadata naming itself names the copy"
        (is (= {"self" (str new-id) "genre" "fable"}
               (:metadata (doc/get-with-layer-data db new-id)))))

      (testing "a string that contains an id, a key that is an id, an outside id and a number are kept"
        (is (= {"note" (str "see " one)
                "by-token" {(str one) "first"}
                "layer" (str tkl)
                "count" 2}
               (select-keys (:metadata c-b) ["note" "by-token" "layer" "count"]))))

      (testing "the source's metadata still names the source's rows"
        (is (= before (live doc-id)))
        (is (= b-meta (:metadata (first (filter #(= (str b) (str (:id %)))
                                                (:spans (drows/read-rows db doc-id))))))))

      (testing "history reads the rewritten metadata back"
        (is (= (live new-id)
               (comparable (hread/get-with-layer-data-at db new-id (latest-op-ts)))))))))

;; ============================================================
;; The kinds of row the rewrite covers
;; ============================================================

(deftest the-rewrite-covers-every-kind-of-row-a-document-owns
  (let [proj (create-test-project admin-request "CopyKinds")
        doc-id (create-test-document admin-request proj "Doc")]
    (testing "the kinds are listed once, in the var the copy reads"
      (is (= [:document :texts :tokens :spans :relations :vocab-links]
             doc/metadata-reference-kinds)
          (str "plaid-igt rewrites the same list when it imports a native archive "
               "(src/import/native/references.js) and pins it against this one, so "
               "a change here is a change there.")))
    (testing "and they are every kind a document read returns"
      (is (= (set doc/metadata-reference-kinds)
             (set (keys (drows/read-rows db doc-id))))
          (str "a new document-scoped table has to join the rewrite too, or ids of "
               "its rows stay pointed at the source document after a copy.")))))

;; ============================================================
;; The media file and the commit
;; ============================================================

(defn- media-files
  "The names of the files sitting in the media directory."
  []
  (->> (.listFiles (io/file (media/ensure-media-dir!)))
       (filter #(.isFile ^java.io.File %))
       (map #(.getName ^java.io.File %))
       set))

(defn- with-temp-media-dir
  "Point the media directory at a fresh temp dir for the body. Every
  reader of the directory in `plaid.media.storage` goes through
  `get-media-dir`, which derives it from the database path — in tests
  that is the in-memory database, so the real one would be `data/media`
  in the working tree."
  [f]
  (let [tmp (Files/createTempDirectory "plaid-copy-media-" (make-array FileAttribute 0))]
    (try
      (with-redefs [media/get-media-dir (constantly (.toString tmp))]
        (f))
      (finally
        (when (Files/exists tmp (make-array java.nio.file.LinkOption 0))
          (with-open [paths (Files/walk tmp (make-array java.nio.file.FileVisitOption 0))]
            (doseq [path (reverse (vec (.toList paths)))]
              (Files/deleteIfExists path))))))))

(deftest a-failed-batch-leaves-no-media-file-behind
  ;; The copy's media file used to be written as soon as the operation
  ;; returned, which inside an atomic batch is BEFORE the commit. A batch
  ;; that copied a document with media and then failed rolled the copy
  ;; back and left the file under an id no document has.
  (with-temp-media-dir
    (fn []
      (let [proj (create-test-project admin-request "CopyMedia")
            doc-id (create-test-document admin-request proj "Recorded")
            _ (spit (io/file (media/ensure-media-dir!) (str doc-id ".mp3")) "audio bytes")
            before (media-files)
            docs-before (count (:body (api-call admin-request
                                                {:method :get
                                                 :path (str "/api/v1/projects/" proj "/documents")})))
            res (api-call admin-request
                          {:method :post
                           :path "/api/v1/batch"
                           :body [{:path (str "/api/v1/documents/" doc-id "/copy")
                                   :method "post"
                                   :body {:name "Copy"}}
                                  ;; Anything that fails: the batch is atomic,
                                  ;; so the copy above rolls back with it.
                                  {:path (str "/api/v1/documents/" (random-uuid))
                                   :method "get"
                                   :body nil}]})]
        (is (>= (:status res) 400) "the batch failed")
        (is (= before (media-files))
            "a rolled-back copy must not leave a media file under its id")
        (is (= docs-before
               (count (:body (api-call admin-request
                                       {:method :get
                                        :path (str "/api/v1/projects/" proj "/documents")}))))
            "and no document either")))))

(deftest a-copy-outside-a-batch-takes-the-media-file-with-it
  (with-temp-media-dir
    (fn []
      (let [proj (create-test-project admin-request "CopyMedia")
            doc-id (create-test-document admin-request proj "Recorded")
            _ (spit (io/file (media/ensure-media-dir!) (str doc-id ".mp3")) "audio bytes")
            res (copy! admin-request doc-id {:name "Copy"})
            new-id (-> res :body :id)]
        (assert-created res)
        (is (nil? (-> res :body :media-error)))
        (is (= #{(str doc-id ".mp3") (str new-id ".mp3")} (media-files))
            "the copy has its own file")))))
