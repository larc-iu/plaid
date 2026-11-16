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

(def ^:private astral-zero
  "MATHEMATICAL DOUBLE-STRUCK DIGIT ZERO, U+1D7D8, outside the BMP."
  (String. (Character/toChars 0x1D7D8)))

(defn- cps
  "The length of `s` in code points."
  [^String s]
  (.codePointCount s 0 (.length s)))

(defn- code-points [^String s] (vec (.toArray (.codePoints s))))

(defn- runs
  "The [begin end] in code points of each run of non-space characters of `s`."
  [^String s]
  (let [cs (code-points s)]
    (loop [i 0 start nil out []]
      (if (= i (count cs))
        (cond-> out start (conj [start i]))
        (let [sp (Character/isWhitespace (int (cs i)))]
          (cond (and sp start) (recur (inc i) nil (conj out [start i]))
                (and (not sp) (nil? start)) (recur (inc i) i out)
                :else (recur (inc i) start out)))))))

(defn- indexes-of
  "The code point indexes of the code point `c` (a one-character string) in `s`."
  [^String s ^String c]
  (let [k (.codePointAt c 0)]
    (keep-indexed (fn [i x] (when (= x k) i)) (code-points s))))

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
                   (let [end (if (seq more) (+ at (cps s) 1) (cps body))]
                     (recur end more (conj out [at end])))
                   out))]
    (assert-created (bulk-create-tokens admin-request (mapv (fn [[b e]] {:token-layer-id sentences :text text :begin b :end e})
                                                            bounds)))
    (assert-created (bulk-create-tokens admin-request (mapv (fn [[b e]] {:token-layer-id words :text text :begin b :end e})
                                                            (runs body))))
    {:doc d :text text}))

(def ^:private story ["kai pele" "\" tuna lo" "mo sa"])

(defn- world!
  "A project with igt's layers and one document of `sents`, user1 a writer.
  With `:morphs`, a morpheme layer under the words with a gloss layer."
  ([] (world! story {}))
  ([sents] (world! sents {}))
  ([sents {:keys [morphs]}]
   (let [proj (create-test-project admin-request "Retypes")
         tl (id (create-text-layer admin-request proj "Baseline"))
         sentences (id (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"}))
         words (id (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"
                                                                      :parent-token-layer-id sentences}))
         morphs (when morphs
                  (id (create-token-layer-opts admin-request tl "Morphemes" {:overlap-mode "non-overlapping"
                                                                             :parent-token-layer-id words})))
         pos (id (create-span-layer admin-request words "Part of Speech"))
         gloss (when morphs (id (create-span-layer admin-request morphs "Gloss")))
         _ (assert-done (add-project-writer admin-request proj "user1@example.com"))
         w {:proj proj :tl tl :sentences sentences :words words :morphs morphs :pos pos :gloss gloss}]
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

(defn- replace-op [i old new] {:type "replace" :index i :length (cps old) :value new})
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

(defn- coverage
  "`{[text layer] {:body b :covered #{code point index}}}` for the texts of
  `docs`: which characters the tokens of each layer cover now."
  [docs]
  (into {}
        (for [d docs
              t (psc/q db {:select [:id :body] :from [:texts] :where [:= :document_id (str d)]})
              [layer ks] (group-by :token_layer_id
                                   (psc/q db {:select [:token_layer_id :begin :end_] :from [:tokens]
                                              :where [:= :text_id (str (:id t))]}))]
          [[(:id t) layer] {:body (:body t) :covered (into #{} (mapcat (fn [k] (range (:begin k) (:end_ k)))) ks)}])))

(defn- problems
  "What is wrong with document `d` now, as strings: a token outside its
  text, a partitioning layer that does not tile its text, an overlap on a
  non-overlapping layer, a child token outside every parent, a span, link or
  relation naming a row that is not there."
  [d]
  (let [texts (psc/q db {:select [:id :body] :from [:texts] :where [:= :document_id (str d)]})
        tokens (psc/q db {:select [:id :token_layer_id :text_id :begin :end_] :from [:tokens]
                          :where [:= :document_id (str d)]})
        layers (into {} (map (juxt :id identity))
                     (psc/q db {:select [:id :overlap_mode :parent_token_layer_id] :from [:token_layers]}))
        tok-ids (set (map :id tokens))
        span-ids (set (map :id (psc/q db {:select [:id] :from [:spans] :where [:= :document_id (str d)]})))
        out (atom [])
        p! #(swap! out conj %)]
    (doseq [t texts
            :let [n (cps (:body t))
                  ts (filter #(= (:id t) (:text_id %)) tokens)]]
      (doseq [k ts] (when-not (<= 0 (:begin k) (:end_ k) n) (p! (str "token outside its text " (pr-str k)))))
      (doseq [[lid lts] (group-by :token_layer_id ts)
              :let [mode (:overlap_mode (layers lid))
                    srt (sort-by (juxt :begin :end_) lts)]]
        (when (and (= "partitioning" mode)
                   (not (and (= 0 (:begin (first srt))) (= n (:end_ (last srt)))
                             (every? (fn [[a b]] (= (:end_ a) (:begin b))) (partition 2 1 srt)))))
          (p! (str "partition broken " (pr-str (map (juxt :begin :end_) srt)))))
        (when (#{"non-overlapping" "partitioning"} mode)
          (doseq [[a b] (partition 2 1 srt)] (when (< (:begin b) (:end_ a)) (p! (str "overlap " (pr-str [a b]))))))
        (when-let [par (:parent_token_layer_id (layers lid))]
          (let [ps (filter #(= par (:token_layer_id %)) ts)]
            (doseq [k lts]
              (when-not (some #(<= (:begin %) (:begin k) (:end_ k) (:end_ %)) ps)
                (p! (str "child outside its parents " (pr-str k)))))))))
    (doseq [r (psc/q db ["SELECT st.token_id FROM span_tokens st JOIN spans s ON s.id = st.span_id WHERE s.document_id = ?" (str d)])]
      (when-not (tok-ids (:token_id r)) (p! (str "span on a missing token " (:token_id r)))))
    (doseq [r (psc/q db {:select [:id :source_span_id :target_span_id] :from [:relations] :where [:= :document_id (str d)]})]
      (when-not (and (span-ids (:source_span_id r)) (span-ids (:target_span_id r)))
        (p! (str "relation on a missing span " (:id r)))))
    (doseq [r (psc/q db ["SELECT lt.token_id FROM vocab_link_tokens lt JOIN vocab_links l ON l.id = lt.vocab_link_id WHERE l.document_id = ?" (str d)])]
      (when-not (tok-ids (:token_id r)) (p! (str "link on a missing token " (:token_id r)))))
    @out))

(defn- bodies [docs]
  (into {} (for [d docs t (psc/q db {:select [:id :body] :from [:texts] :where [:= :document_id (str d)]})]
             [(:id t) (:body t)])))

(defn- snapshot
  "The `state` of `docs`, carrying in its metadata which characters each
  layer covers and each text's body, so an undo can be checked against the
  state before the unit (`invariant!`). Equal to `state` under `=`."
  [docs]
  (with-meta (state docs) {:cover (coverage docs) :bodies (bodies docs)}))

(defn- invariant!
  "What every undo must leave, whatever it undid, in the documents `docs`:
  1. every document is valid (`problems`: every token within its text in
     code points, every layer's rules, nothing naming a row not there);
  2. on every text whose body the undo did not change, every character a
     token of a layer covered before the undo is still covered by a token of
     that layer, unless no token of that layer covered it before the unit
     either: an undo takes away only coverage the unit added, and never
     leaves characters bare that were covered before the unit and after it
     (REV-RPF-P-2, REV-UT-2). `cover` is the `coverage` before the undo.
     `then` is a `snapshot` before the unit (or nil, when only the state
     before the undo is known: then nothing covered before the undo may be
     uncovered);
  3. each text and its tokens are as they were before the undo (`was`) or as
     they were before the unit (`then`), never the text of one with the
     tokens of the other: together or not at all."
  [docs cover was then now]
  (doseq [d docs] (is (empty? (problems d)) (pr-str (problems d))))
  (let [now-cover (coverage docs)
        now-bodies (bodies docs)
        {then-cover :cover then-bodies :bodies} (meta then)]
    (doseq [[[text layer :as k] {:keys [body covered]}] cover
            :when (= body (now-bodies text))
            :let [needed (if (and then (= body (get then-bodies text)))
                           (filter (or (:covered (get then-cover k)) #{}) covered)
                           covered)]]
      (is (every? (or (:covered (get now-cover k)) #{}) needed)
          (str "characters left bare on layer " layer " of " (pr-str body)))))
  (let [part (fn [st] (into {} (filter (fn [[[kind] _]] (#{"text" "token"} kind))) st))]
    (is (or (= (part now) (part was)) (and then (= (part now) (part then))))
        "the text and its tokens are as the unit left them or as they were before it")))

(defn- undo-checked!
  "Undo by `call` (a function of dry?), dry run first, over the documents
  `docs`: the dry run writes nothing and says what the real call does, and
  the invariant holds after (`then` the state before the unit, or nil).
  Returns the real call's summary."
  [docs then call]
  (let [was (state docs)
        cover (coverage docs)
        dry (body-of (call true))
        _ (is (= was (state docs)) "the dry run wrote nothing")
        real (body-of (call false))]
    (is (= (dissoc dry :dry-run) (dissoc real :dry-run :operation)) "the dry run said what the call did")
    (invariant! docs cover was then (state docs))
    real))

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
    (let [nuls (indexes-of (body text) nul)]
      (doseq [i nuls] (id (create-span r pos [(word-at words text i (inc i))] "PRON")))
      (id (create-span r pos [(word-at words text (at text "tuna") (+ 4 (at text "tuna")))] "N")))))

(defn- exact-undo!
  "Undo `entry` (a group id, or `[:job id]`) by its route, dry run first:
  the documents `docs` go back to `before` exactly, nothing is skipped, and
  the dry run said what the call did."
  [entry docs before]
  (let [real (undo-checked! docs before #(if (vector? entry)
                                           (undo-job admin-request (second entry) :dry-run %)
                                           (undo-entry admin-request entry :dry-run %)))]
    (is (zero? (:skipped-count real)) (pr-str (:skipped real)))
    (is (= before (state docs)) "every row as before the unit")
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
          before (snapshot [doc])
          g (str (random-uuid))]
      (reviewers-case! w g)
      (is (= (str nul " kai pele " nul " tuna lo mo sa") (body (:text w))))
      (exact-undo! g [doc] before)
      (is (= "kai pele \" tuna lo mo sa" (body (:text w))))))
  (testing "by the job's route"
    (let [{:keys [proj doc] :as w} (world!)
          before (snapshot [doc])
          g (str (random-uuid))
          _ (reviewers-case! w g)
          job (job! proj [doc] [g])]
      (exact-undo! [:job job] [doc] before)))
  (testing "by the engine, the job's groups read as one unit"
    (let [{:keys [doc] :as w} (world!)
          before (snapshot [doc])
          g1 (str (random-uuid))
          g2 (str (random-uuid))
          r1 (in-group admin-request g1)
          r2 (in-group admin-request g2)
          text (:text w)]
      ;; each retype in a group of its own, as a job's two passes
      (edit! r1 w text [(replace-op (at text "\"") "\"" nul)])
      (edit! r2 w text [(insert-op 0 (str nul " "))])
      (let [opts {:user "admin@example.com" :may-document? (constantly true) :may-vocab? (constantly true)}
            after (state [doc])
            dry (:summary (undo/undo db [g1 g2] (assoc opts :dry-run? true)))
            _ (is (= after (state [doc])) "the engine's dry run wrote nothing")
            {:keys [summary]} (undo/undo db [g1 g2] opts)]
        (is (= (dissoc dry :dry-run) (dissoc summary :dry-run :operation)) "the engine's dry run said what it did")
        (is (zero? (:skipped-count summary)) (pr-str (:skipped summary)))
        (is (= before (state [doc])))))))

(deftest the-reviewers-case-on-astral-and-right-to-left-text
  (doseq [[what sents new-word]
          [["an astral word typed into a text with astral letters and a combining mark"
            [(str astral-zero "ai pq" (str (char 0x0301)) "le") "\" tuna lo" "mo sa"] astral-zero]
           ["a pointed Hebrew text"
            ["\u05e9\u05c1\u05b8\u05dc\u05d5\u05b9\u05dd \u05e2\u05d5\u05b9\u05dc\u05b8\u05dd"
             "\" \u05d0\u05b6\u05d7\u05b8\u05d3" "\u05e9\u05c1\u05b0\u05e0\u05b7\u05d9\u05b4\u05dd"] nul]]
          route [:entry :job]]
    (testing (str what ", by the " (name route) " route")
      (let [{:keys [proj doc text pos words] :as w} (world! sents)
            before (snapshot [doc])
            g (str (random-uuid))
            r (in-group admin-request g)]
        (edit! r w text [(replace-op (at text "\"") "\"" new-word)])
        (edit! r w text [(insert-op 0 (str new-word " "))])
        ;; the new words: the typed character alone under a word (the body's own
        ;; astral letter begins a longer word)
        (let [made (filter #(word-at words text % (inc %)) (indexes-of (body text) new-word))]
          (is (= 2 (count made)))
          (doseq [i made] (id (create-span r pos [(word-at words text i (inc i))] "PRON"))))
        (exact-undo! (if (= route :job) [:job (job! proj [doc] [g])] g) [doc] before)))))

(deftest the-reviewers-case-with-morphemes-under-the-words
  (let [{:keys [doc text morphs gloss] :as w} (world! story {:morphs true})
        ;; a person's morphemes and a gloss before the job: pe|le and tu|na
        _ (doseq [s ["pele" "tuna"]
                  :let [b (at text s)]
                  [x y] [[b (+ b 2)] [(+ b 2) (+ b 4)]]]
            (create-token admin-request morphs text x y))
        _ (create-span admin-request gloss [(word-at morphs text (at text "pele") (+ 2 (at text "pele")))] "SG")
        before (snapshot [doc])
        g (str (random-uuid))]
    (reviewers-case! w g)
    (exact-undo! g [doc] before)))

(deftest undo-then-redo-then-undo
  (let [{:keys [doc] :as w} (world!)
        before (snapshot [doc])
        g (str (random-uuid))
        _ (reviewers-case! w g)
        after (snapshot [doc])
        u1 (exact-undo! g [doc] before)
        u2 (exact-undo! (str (:operation u1)) [doc] after)]
    (exact-undo! (str (:operation u2)) [doc] before)))

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
            before (snapshot [doc])
            g (str (random-uuid))
            r (in-group admin-request g)]
        (doseq [e edits] (edit! r w text (e text)))
        (exact-undo! g [doc] before)))))

(deftest the-same-in-two-documents-of-one-job
  (let [{:keys [proj doc] :as w} (world!)
        d2 (add-document! w "Story 2" ["mo sa" "\" tuna kai"])
        before (snapshot [doc (:doc d2)])
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
  which no edit moves, a relation between the two PRON values and a link
  from the second new word to a lexicon entry. `between` runs between the
  two edits, `after` after the unit's last write."
  [{:keys [between after]}]
  (let [{:keys [proj doc text pos words] :as w} (world!)
        g (str (random-uuid))
        r (in-group admin-request g)
        _ (edit! r w text [(replace-op (at text "\"") "\"" nul)])
        _ (when between (between w))
        _ (edit! r w text [(insert-op (at text "mo") (str nul " "))])
        pron (vec (for [i (indexes-of (body text) nul)]
                    (id (create-span r pos [(word-at words text i (inc i))] "PRON"))))
        kai (id (create-span r pos [(word-at words text 0 3)] "N"))
        dep (id (create-relation-layer admin-request pos "Dependencies"))
        rel (id (create-relation r dep (first pron) (second pron) "conj"))
        vocab (id (create-vocab-layer admin-request proj "Lexicon"))
        entry (id (create-vocab-item admin-request vocab "pro"))
        link (id (create-vocab-link r entry [(word-at words text (at text (str nul " mo")) (inc (at text (str nul " mo"))))]))
        _ (when after (after w))]
    (assoc w :g g :pron pron :kai kai :rel rel :link link)))

(defn- person-edit! [{:keys [text] :as w}]
  ;; a person adds a word at the end of s3, as the Baseline sends it
  (assert-ok (api-call user1-request {:method :patch :path (str "/api/v1/texts/" text)
                                      :body {:edits [(insert-op (cps (body text)) " ke")]}})))

(deftest a-persons-edit-between-or-after-the-units-holds-its-text-and-its-tokens
  (doseq [[what opts reason] [["between the unit's edits" {:between person-edit!} "changed-between"]
                              ["after the unit's last" {:after person-edit!} "changed-since"]]]
    (testing what
      (let [{:keys [doc text g pron kai rel link]} (person-world! opts)
            was (state [doc])
            real (undo-checked! [doc] nil #(undo-entry admin-request g :dry-run %))
            why (reasons real)
            now (state [doc])]
        (is (= reason (why text)) "the text is the person's to keep")
        (is (every? #{"text-changed-since" "changed-since"} (vals (dissoc why text)))
            "every other row is left for its text, or for the person's edit of it")
        (is (= (dissoc (text-part was) ["span" kai]) (text-part now))
            "the text, its tokens and the values on the new words are as they were")
        (doseq [s pron] (is (= "text-changed-since" (why s)) "a value on a new word stays with its word"))
        (is (= "text-changed-since" (why rel)) "a relation on those values stays with them")
        (is (= "text-changed-since" (why link)) "a link on a new word stays with it")
        (is (some? (psc/fetch-by-id db :relations rel)))
        (is (some? (psc/fetch-by-id db :vocab_links link)))
        (is (nil? (get now ["span" kai])) "a value on a word no edit moved is undone")))))

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
        real (undo-checked! [doc] nil #(undo-entry admin-request g :dry-run %))
        why (reasons real)
        now (state [doc])]
    (is (= "built-on" (why first-new)))
    (is (= "text-changed-since" (why second-new)) "the second new word stays with its text")
    (is (= (text-part was) (text-part now)) "nothing of the text is undone")
    (is (some? (psc/fetch-by-id db :spans mine)))))

;; ============================================================
;; REV-UT-1: a value the unit wrote on an old word its edit only shifted
;; ============================================================

(defn- word-of
  "The word over the first `s` in `text` now."
  [{:keys [words]} text s]
  (let [b (at text s)] (word-at words text b (+ b (cps s)))))

(defn- shifted-world!
  "The job types `∅ ` at the start (every old word shifts), gives PRON to
  the new word, N to the old word tuna and CONJ to the old word kai."
  [opts]
  (let [{:keys [doc text pos words] :as w} (world! story opts)
        then (snapshot [doc])
        g (str (random-uuid))
        r (in-group admin-request g)
        _ (edit! r w text [(insert-op 0 (str nul " "))])
        pron (id (create-span r pos [(word-at words text 0 1)] "PRON"))
        tuna (id (create-span r pos [(word-of w text "tuna")] "N"))
        kai (id (create-span r pos [(word-of w text "kai")] "CONJ"))]
    (assoc w :g g :then then :pron pron :tuna tuna :kai kai)))

(deftest a-value-on-an-old-word-the-edit-only-shifted-is-undone-when-the-text-stays
  (doseq [[what opts person]
          [["a person's morpheme on an untouched word" {:morphs true}
            (fn [{:keys [morphs text]}] (let [b (at text "sa")] (create-token user1-request morphs text b (+ b 2))))]
           ["a person's split of an untouched word" {}
            (fn [{:keys [text] :as w}] (split-token user1-request (word-of w text "pele") (+ 2 (at text "pele"))))]
           ["a person's note on an old word" {}
            (fn [{:keys [text] :as w}] (update-token-metadata user1-request (word-of w text "lo") {"note" "x"}))]
           ["a person typing at the end of the text" {}
            (fn [{:keys [text]}] (api-call user1-request {:method :patch :path (str "/api/v1/texts/" text)
                                                          :body {:edits [(insert-op (cps (body text)) " ke")]}}))]
           ["a person's value on the new word" {}
            (fn [{:keys [pos words text]}] (create-span user1-request pos [(word-at words text 0 1)] "DET"))]]]
    (testing what
      (let [{:keys [doc text g then pron tuna kai] :as w} (shifted-world! opts)
            _ (assert-done (person w))
            real (undo-checked! [doc] then #(undo-entry admin-request g :dry-run %))
            why (reasons real)]
        (is (str/starts-with? (body text) (str nul " kai pele \" tuna lo mo sa")) "the text stays")
        (is (nil? (psc/fetch-by-id db :spans tuna)) "the job's value on tuna is undone")
        (is (nil? (psc/fetch-by-id db :spans kai)) "the job's value on kai is undone")
        (is (nil? (why tuna)))
        (when (= "text-changed-since" (why (word-at (:words w) text 0 1)))
          (is (= "text-changed-since" (why pron)) "a value on the typed word stays with it")
          (is (some? (psc/fetch-by-id db :spans pron))))))))

(deftest two-jobs-on-one-text-in-either-order
  (let [two-jobs! (fn []
                    (let [{:keys [proj doc text pos words] :as w} (world!)
                          then (snapshot [doc])
                          g1 (str (random-uuid))
                          g2 (str (random-uuid))
                          r1 (in-group admin-request g1)
                          r2 (in-group admin-request g2)]
                      (edit! r1 w text [(replace-op (at text "\"") "\"" nul)])
                      (edit! r1 w text [(insert-op 0 (str nul " "))])
                      (create-span r1 pos [(word-at words text 0 1)] "PRON")
                      (let [n1 (id (create-span r1 pos [(word-of w text "tuna")] "N1"))
                            mid (snapshot [doc])]
                        (edit! r2 w text [(insert-op (at text "mo") (str nul " "))])
                        (create-span r2 pos [(word-of w text "mo")] "N2")
                        (create-span r2 pos [(word-of w text "kai")] "K2")
                        (assoc w :then then :mid mid :n1 n1
                               :j1 (job! proj [doc] [g1]) :j2 (job! proj [doc] [g2])))))]
    (testing "the first job undone while the second stands: its text stays, its value on an old word goes"
      (let [{:keys [doc j1 then n1]} (two-jobs!)]
        (undo-checked! [doc] then #(undo-job admin-request j1 :dry-run %))
        (is (nil? (psc/fetch-by-id db :spans n1)) "the first job's N1 on tuna is undone")))
    (testing "the second job, then the first: each exact"
      (let [{:keys [doc j1 j2 then mid]} (two-jobs!)]
        (undo-checked! [doc] mid #(undo-job admin-request j2 :dry-run %))
        (is (= mid (state [doc])) "the second job undone exactly")
        (let [real (undo-checked! [doc] then #(undo-job admin-request j1 :dry-run %))]
          (is (pos? (:total real))))))))

;; ============================================================
;; REV-UT-2: a split on a text the unit does not edit
;; ============================================================

(deftest a-word-split-whose-left-half-a-person-wrote-since-keeps-its-right-half
  (doseq [[what edits-text?] [["the text unchanged" false] ["the text also edited" true]]]
    (testing what
      (let [{:keys [doc text words] :as w} (world!)
            then (snapshot [doc])
            g (str (random-uuid))
            r (in-group admin-request g)
            pele (word-of w text "pele")
            _ (when edits-text? (edit! r w text [(replace-op (at text "\"") "\"" nul)]))
            _ (assert-done (split-token r pele (+ 2 (at text "pele"))))
            right (word-of w text "le")
            _ (assert-done (update-token-metadata user1-request pele {"seen" true}))
            real (undo-checked! [doc] then #(undo-entry admin-request g :dry-run %))
            why (reasons real)]
        (is (= "changed-since" (why pele)) "the left half is the person's")
        (is (= "text-changed-since" (why right)) "the right half stays with it")
        (is (some? (psc/fetch-by-id db :tokens right)))))))

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
          before (snapshot [doc])
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
          before (snapshot [doc])
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
          before (snapshot [doc])
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
