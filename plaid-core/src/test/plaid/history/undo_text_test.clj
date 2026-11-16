(ns plaid.history.undo-text-test
  "Undo of a unit that wrote one text several times (REV-RPF-P-2): a unit's
  own later writes are never \"changed since\", and a text and the tokens on
  it are undone together or not at all.

  The worlds are igt's shape: a partitioning sentence layer, a word layer
  under it, a value layer on the words, and text edits sent as the job's
  worker sends them (edit ops naming the word layer, so core makes the words
  of the text typed)."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    with-test-users user1-request
                                    assert-created assert-ok with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.history.undo :as undo]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ============================================================
;; Helpers
;; ============================================================

(def ^:private nul
  "The zero morpheme the job types, U+2205."
  (str (char 0x2205)))

(defn- assert-done [resp]
  (is (< (:status resp) 300) (pr-str (:body resp)))
  resp)

(defn- in-group [req group]
  (fn [method path]
    (req method (str path (if (str/includes? path "?") "&" "?") "group-id=" group))))

(defn- undo-entry [req entry-id & {:keys [dry-run]}]
  (api-call req {:method :post
                 :path (str "/api/v1/audit/entries/" entry-id "/undo" (when dry-run "?dry-run=true"))}))

(defn- undo-job [req job & {:keys [dry-run]}]
  (api-call req {:method :post :path (str "/api/v1/jobs/" job "/undo" (when dry-run "?dry-run=true"))}))

(defn- body-of [resp]
  (is (= 200 (:status resp)) (pr-str (:body resp)))
  (:body resp))

(defn- reasons [summary] (into {} (map (juxt :id :reason)) (:skipped summary)))

(defn- runs
  "The [begin end] of each run of non-space characters of `s`."
  [s]
  (let [m (re-matcher #"\S+" s)]
    (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out))))

(defn- add-document!
  "A document of `proj` whose text is `sentences` joined by spaces, a
  sentence token over each (its trailing space with it) and a word over each
  run without spaces."
  [{:keys [proj tl sentences words]} name sents]
  (let [d (create-test-document admin-request proj name)
        body (str/join " " sents)
        text (id (create-text admin-request tl d body))
        bounds (loop [at 0 [s & more] sents out []]
                 (if s
                   (let [end (if (seq more) (+ at (count s) 1) (count body))]
                     (recur end more (conj out [at end])))
                   out))]
    (assert-created (bulk-create-tokens admin-request (mapv (fn [[b e]] {:token-layer-id sentences :text text :begin b :end e})
                                                            bounds)))
    (assert-created (bulk-create-tokens admin-request (mapv (fn [[b e]] {:token-layer-id words :text text :begin b :end e})
                                                            (runs body))))
    {:doc d :text text}))

(def ^:private story ["kai pele" "\" tuna lo" "mo sa"])

(defn- world!
  "A project with igt's layers and one document of `sents`."
  ([] (world! story))
  ([sents]
   (let [proj (create-test-project admin-request "Retypes")
         tl (id (create-text-layer admin-request proj "Baseline"))
         sentences (id (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"}))
         words (id (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"
                                                                      :parent-token-layer-id sentences}))
         pos (id (create-span-layer admin-request words "Part of Speech"))
         w {:proj proj :tl tl :sentences sentences :words words :pos pos}]
     (merge w (add-document! w "Story" sents)))))

(defn- body [text] (:body (psc/fetch-by-id db :texts text)))

(defn- at
  "Where `s` first stands in text `text`'s body now, in code points."
  [text s]
  (let [b (body text)
        i (str/index-of b s)]
    (is (some? i) (str s " in " b))
    (.codePointCount ^String b 0 (int i))))

(defn- edit!
  "One text edit as the worker sends it: edit ops naming the word layer."
  [req {:keys [words]} text edits]
  (assert-ok (api-call req {:method :patch :path (str "/api/v1/texts/" text)
                            :body {:edits edits :tokenize-layer words}})))

(defn- replace-op [i old new] {:type "replace" :index i :length (count old) :value new})
(defn- insert-op [i v] {:type "insert" :index i :value v})

(defn- word-at
  "The word of `layer` over [b e) in `text` now."
  [layer text b e]
  (:id (psc/q1 db {:select [:id] :from [:tokens]
                   :where [:and [:= :token_layer_id (str layer)] [:= :text_id (str text)]
                           [:= :begin b] [:= :end_ e]]})))

(defn- flat-document [deep]
  (let [layers (:document/text-layers deep)
        tkls (mapcat :text-layer/token-layers layers)
        sls (mapcat :token-layer/span-layers tkls)]
    (into {["document" (:document/id deep)]
           (cond-> (select-keys deep [:document/id :document/name :document/project])
             (:metadata deep) (assoc :metadata (:metadata deep)))}
          (concat
           (for [l layers :let [t (:text-layer/text l)] :when t] [["text" (:text/id t)] t])
           (for [k tkls t (:token-layer/tokens k)] [["token" (:token/id t)] t])
           (for [s sls x (:span-layer/spans s)] [["span" (:span/id x)] x])
           (for [k tkls v (:token-layer/vocabs k) x (:vocab-layer/vocab-links v)]
             [["vocab-link" (:vocab-link/id x)]
              (update x :vocab-link/vocab-item select-keys [:vocab-item/id])])))))

(defn- state
  "Every row of the documents `doc-ids` and the vocabularies `vocab-ids`, as
  the deep reads serve them."
  ([doc-ids] (state doc-ids []))
  ([doc-ids vocab-ids]
   (apply merge
          (concat (for [d doc-ids :let [deep (doc/get-with-layer-data db d)] :when deep] (flat-document deep))
                  (for [v vocab-ids]
                    (into {} (for [i (:vocab/items (hread/get-vocab-at db v (latest-op-ts) true))]
                               [["vocab-item" (:vocab-item/id i)] i])))))))

(defn- text-part
  "The text rows, the tokens and the spans of a `state`."
  [st]
  (into {} (filter (fn [[[kind] _]] (#{"text" "token" "span"} kind))) st))

(defn- invariant!
  "What every undo must leave, whatever it undid: every token of document
  `d` lies within its text (begin <= end <= the body's length in code
  points), and each text holds tokens over the same characters it held
  either before the undo or after it, never the text of one with the tokens
  of the other: the text and the tokens on it went back together or not at
  all. `was` is the documents' state before the undo, `then` their state
  before the unit, `now` after the undo."
  [docs was then now]
  (doseq [d docs
          t (psc/q db {:select [:id :body] :from [:texts] :where [:= :document_id (str d)]})
          :let [n (.codePointCount ^String (:body t) 0 (count (:body t)))]]
    (doseq [k (psc/q db {:select [:id :begin :end_] :from [:tokens] :where [:= :text_id (str (:id t))]})]
      (is (<= 0 (:begin k) (:end_ k) n) (str "token " (:id k) " lies within its text"))))
  (let [part (fn [st] (into {} (filter (fn [[[kind] _]] (#{"text" "token"} kind))) st))]
    (is (or (= (part now) (part was)) (= (part now) (part then)))
        "the text and its tokens are as the unit left them or as they were before it")))

;; ============================================================
;; The reviewer's case, and its shapes
;; ============================================================

(defn- reviewers-case!
  "The job of REV-RPF-P-2 in group `g`: s2's `\"` retyped as `∅` (its word
  replaced), then `∅ ` inserted before s1 (a new word), each new word given
  PRON, and an old word N. The worker writes the higher region first."
  [{:keys [text pos words] :as w} g]
  (let [r (in-group admin-request g)]
    (edit! r w text [(replace-op (at text "\"") "\"" nul)])
    (edit! r w text [(insert-op 0 (str nul " "))])
    (let [b (body text)
          nuls (keep-indexed (fn [i c] (when (= nul (str c)) i)) b)]
      (doseq [i nuls] (id (create-span r pos [(word-at words text i (inc i))] "PRON")))
      (id (create-span r pos [(word-at words text (at text "tuna") (+ 4 (at text "tuna")))] "N")))))

(defn- exact-undo!
  "Undo `entry` (a group id, or `[:job id]`) by its route, dry run first:
  the documents `docs` go back to `before` exactly, nothing is skipped, and
  the dry run said what the call did."
  [entry docs before]
  (let [call (fn [& dry] (if (vector? entry)
                           (undo-job admin-request (second entry) :dry-run (first dry))
                           (undo-entry admin-request entry :dry-run (first dry))))
        after (state docs)
        dry (body-of (call true))
        _ (is (= after (state docs)) "the dry run wrote nothing")
        real (body-of (call))]
    (is (zero? (:skipped-count real)) (pr-str (:skipped real)))
    (is (= before (state docs)) "every row as before the unit")
    (is (= (dissoc dry :dry-run) (dissoc real :dry-run :operation)) "the dry run said what the call did")
    (invariant! docs after before (state docs))
    real))

(defn- job!
  "An ended job of `proj` whose documents `docs` wrote in `groups` (one each)."
  [proj docs groups]
  (let [job (str (random-uuid))
        now (psc/now-iso)]
    (psc/execute! db {:insert-into :jobs
                      :values [{:id job :project_id (str proj) :app "igt" :started_by "admin@example.com"
                                :state "done" :created_at now :instructions "Insert zero subjects."}]})
    (psc/execute! db {:insert-into :job_documents
                      :values (vec (map-indexed (fn [i [d g]] {:job_id job :document_id (str d) :position i :state "done"
                                                               :gloss_group g :updated_at now})
                                                (map vector docs groups)))})
    job))

(deftest two-retypes-of-one-text-one-dropping-a-mark-undo-exactly
  (testing "by the entry's route"
    (let [{:keys [doc] :as w} (world!)
          before (state [doc])
          g (str (random-uuid))]
      (reviewers-case! w g)
      (is (= (str nul " kai pele " nul " tuna lo mo sa") (body (:text w))))
      (exact-undo! g [doc] before)
      (is (= "kai pele \" tuna lo mo sa" (body (:text w))))))
  (testing "by the job's route"
    (let [{:keys [proj doc] :as w} (world!)
          before (state [doc])
          g (str (random-uuid))
          _ (reviewers-case! w g)
          job (job! proj [doc] [g])]
      (exact-undo! [:job job] [doc] before)))
  (testing "by the engine, the job's groups read as one unit"
    (let [{:keys [doc] :as w} (world!)
          before (state [doc])
          g1 (str (random-uuid))
          g2 (str (random-uuid))
          r1 (in-group admin-request g1)
          r2 (in-group admin-request g2)
          text (:text w)]
      ;; each retype in a group of its own, as a job's two passes
      (edit! r1 w text [(replace-op (at text "\"") "\"" nul)])
      (edit! r2 w text [(insert-op 0 (str nul " "))])
      (let [{:keys [summary]} (undo/undo db [g1 g2] {:user "admin@example.com" :may-document? (constantly true)
                                                     :may-vocab? (constantly true)})]
        (is (zero? (:skipped-count summary)) (pr-str (:skipped summary)))
        (is (= before (state [doc])))))))

(deftest the-shapes-of-several-text-writes-by-one-unit
  ;; each edit is read against the body the edits before it left
  (doseq [[what edits]
          [["the mark dropped after the insert"
            [(fn [t] [(insert-op 0 (str nul " "))])
             (fn [t] [(replace-op (at t "\"") "\"" nul)])]]
           ["three edits, the last inside a word the first two moved"
            [(fn [t] [(replace-op (at t "\"") "\"" nul)])
             (fn [t] [(insert-op 0 (str nul " "))])
             (fn [t] [(replace-op (inc (at t "lo")) "o" "a")])]]
           ["an edit that only inserts between two that change"
            [(fn [t] [(replace-op (at t "\"") "\"" nul)])
             (fn [t] [(insert-op (at t "mo") (str nul " "))])
             (fn [t] [(replace-op (at t "kai") "k" "g")])]]
           ["a character a word held deleted, then text typed before it"
            [(fn [t] [{:type "delete" :index (at t "\"") :value 2}])
             (fn [t] [(insert-op 0 (str nul " "))])]]
           ["the same character written twice"
            [(fn [t] [(replace-op (at t "\"") "\"" nul)])
             (fn [t] [(replace-op (at t nul) nul "'")])]]]]
    (testing what
      (let [{:keys [doc text] :as w} (world!)
            before (state [doc])
            g (str (random-uuid))
            r (in-group admin-request g)]
        (doseq [e edits] (edit! r w text (e text)))
        (exact-undo! g [doc] before)))))

(deftest the-same-in-two-documents-of-one-job
  (let [{:keys [proj doc] :as w} (world!)
        d2 (add-document! w "Story 2" ["mo sa" "\" tuna kai"])
        before (state [doc (:doc d2)])
        g1 (str (random-uuid))
        g2 (str (random-uuid))]
    (reviewers-case! w g1)
    (reviewers-case! (merge w d2) g2)
    (exact-undo! [:job (job! proj [doc (:doc d2)] [g1 g2])] [doc (:doc d2)] before)))

;; ============================================================
;; A person's edit: between the unit's edits, and after them
;; ============================================================

(defn- person-world!
  "The reviewer's text with the unit's work kept off s1: s2's mark retyped,
  `∅ ` typed before s3, PRON on each new word and N on the old word kai,
  which no edit moves. `between` runs between the two edits, `after` after
  the unit's last write."
  [{:keys [between after]}]
  (let [{:keys [proj doc text pos words] :as w} (world!)
        _ (assert-done (add-project-writer admin-request proj "user1@example.com"))
        g (str (random-uuid))
        r (in-group admin-request g)
        _ (edit! r w text [(replace-op (at text "\"") "\"" nul)])
        _ (when between (between w))
        _ (edit! r w text [(insert-op (at text "mo") (str nul " "))])
        b (body text)
        pron (vec (for [i (keep-indexed (fn [i c] (when (= nul (str c)) i)) b)]
                    (id (create-span r pos [(word-at words text i (inc i))] "PRON"))))
        kai (id (create-span r pos [(word-at words text 0 3)] "N"))
        _ (when after (after w))]
    (assoc w :g g :pron pron :kai kai)))

(defn- person-edit! [{:keys [text] :as w}]
  ;; a person adds a word at the end of s3, as the Baseline sends it
  (assert-ok (api-call user1-request {:method :patch :path (str "/api/v1/texts/" text)
                                      :body {:edits [(insert-op (count (body text)) " ke")]}})))

(deftest a-persons-edit-between-or-after-the-units-holds-its-text-and-its-tokens
  (doseq [[what opts reason] [["between the unit's edits" {:between person-edit!} "changed-between"]
                              ["after the unit's last" {:after person-edit!} "changed-since"]]]
    (testing what
      (let [{:keys [doc text g pron kai]} (person-world! opts)
            was (state [doc])
            dry (body-of (undo-entry admin-request g :dry-run true))
            _ (is (= was (state [doc])))
            real (body-of (undo-entry admin-request g))
            why (reasons real)
            now (state [doc])]
        (is (= (dissoc dry :dry-run) (dissoc real :dry-run :operation)))
        (is (= reason (why text)) "the text is the person's to keep")
        (is (every? #{"text-changed-since" "changed-since"} (vals (dissoc why text)))
            "every other row is left for its text, or for the person's edit of it")
        (is (= (dissoc (text-part was) ["span" kai]) (text-part now))
            "the text, its tokens and the values on the new words are as they were")
        (doseq [s pron] (is (= "text-changed-since" (why s)) "a value on a new word stays with its word"))
        (is (nil? (get now ["span" kai])) "a value on a word no edit moved is undone")
        (invariant! [doc] was nil now)))))

(deftest a-text-left-for-any-reason-keeps-the-words-made-on-it
  ;; The unit types two new words. A person gives one of them a value, so
  ;; that word stays (built-on), so the text stays: the other new word must
  ;; stay with it, never be deleted from under its characters.
  (let [{:keys [doc text pos words] :as w} (world!)
        g (str (random-uuid))
        r (in-group admin-request g)
        _ (edit! r w text [(insert-op 0 (str nul " " nul " "))])
        first-new (word-at words text 0 1)
        second-new (word-at words text 2 3)
        mine (id (create-span admin-request pos [first-new] "PRON"))
        was (state [doc])
        real (body-of (undo-entry admin-request g))
        why (reasons real)
        now (state [doc])]
    (is (= "built-on" (why first-new)))
    (is (= "text-changed-since" (why second-new)) "the second new word stays with its text")
    (is (= (text-part was) (text-part now)) "nothing of the text is undone")
    (is (some? (psc/fetch-by-id db :spans mine)))
    (invariant! [doc] was nil now)))

;; ============================================================
;; The neighbours: one row written more than once by the unit
;; ============================================================

(deftest one-row-written-several-times-by-the-unit-goes-back-to-before-its-first-write
  (testing "a vocabulary entry written twice, and one made then written"
    (let [{:keys [proj]} (world!)
          vocab (id (create-vocab-layer admin-request proj "Lexicon"))
          e (id (create-vocab-item admin-request vocab "kai" {"gloss" "and"}))
          before (state [] [vocab])
          g (str (random-uuid))
          r (in-group admin-request g)
          _ (assert-ok (update-vocab-item r e "kae"))
          _ (assert-ok (update-vocab-item-metadata r e {"gloss" "then"}))
          _ (assert-ok (update-vocab-item r e "kaï"))
          made (id (create-vocab-item r vocab "pele"))
          _ (assert-ok (update-vocab-item r made "pelé"))
          real (body-of (undo-entry admin-request g))]
      (is (zero? (:skipped-count real)) (pr-str (:skipped real)))
      (is (= before (state [] [vocab])))))
  (testing "a span set by one pass of a job and again by the next"
    (let [{:keys [proj doc text pos words]} (world!)
          w0 (word-at words text 0 3)
          w1 (word-at words text 4 8)
          s (id (create-span admin-request pos [w0] "N"))
          before (state [doc])
          gloss (str (random-uuid))
          harmonize (str (random-uuid))
          _ (assert-ok (update-span (in-group admin-request gloss) s :value "V"))
          made (id (create-span (in-group admin-request gloss) pos [w1] "ADJ"))
          _ (assert-ok (update-span (in-group admin-request harmonize) s :value "CONJ"))
          _ (assert-ok (update-span (in-group admin-request harmonize) made :value "ADV"))
          job (str (random-uuid))
          now (psc/now-iso)]
      (psc/execute! db {:insert-into :jobs
                        :values [{:id job :project_id (str proj) :app "igt" :started_by "admin@example.com"
                                  :state "done" :created_at now :instructions "Gloss"}]})
      (psc/execute! db {:insert-into :job_documents
                        :values [{:job_id job :document_id (str doc) :position 0 :state "done"
                                  :gloss_group gloss :harmonize_group harmonize :updated_at now}]})
      (exact-undo! [:job job] [doc] before)))
  (testing "a word split, then merged by the same unit with its other neighbour"
    (let [{:keys [doc text words] :as w} (world! ["kai pele tuna"])
          before (state [doc])
          g (str (random-uuid))
          r (in-group admin-request g)
          pele (word-at words text 4 8)
          tuna (word-at words text 9 13)
          _ (assert-done (split-token r pele 6))
          _ (assert-done (merge-tokens r (word-at words text 6 8) tuna))
          _ (is (some? w))]
      (exact-undo! g [doc] before)))
  (testing "a text edited, the document restored, then edited again, by one unit"
    (let [{:keys [doc text] :as w} (world!)
          before (state [doc])
          t0 (latest-op-ts)
          g (str (random-uuid))
          r (in-group admin-request g)
          _ (edit! r w text [(replace-op (at text "\"") "\"" nul)])
          _ (assert-ok (api-call r {:method :post
                                    :path (str "/api/v1/documents/" doc "/restore?as-of="
                                               (java.net.URLEncoder/encode (str t0) "UTF-8"))}))
          _ (edit! r w text [(insert-op 0 (str nul " "))])
          _ (edit! r w text [(replace-op (at text "\"") "\"" nul)])]
      (exact-undo! g [doc] before))))
