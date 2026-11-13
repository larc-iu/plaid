(ns plaid.history.changes-test
  "What one audit entry changed, row by row (plaid.history.changes,
  GET /audit/entries/:entry-id/changes).

  The central claim, checked on hand-built units and on seeded random ones:
  each row's `before` and `after` are the row as the as-of reads serve it
  just before the unit's first write to it and just after its last, so
  putting every row's `before` back over the state after a unit gives the
  state before it. That is what an undo will do."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    with-test-users user1-request user2-request
                                    assert-created assert-ok with-clean-db]]
            [plaid.history.changes :as changes]
            [plaid.history.read :as hread]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all])
  (:import (java.util Random)))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ============================================================
;; Helpers
;; ============================================================

(defn- assert-done [resp]
  (is (< (:status resp) 300) (pr-str (:body resp)))
  resp)

(defn- in-group
  "`req` with every write joining logical operation `group`."
  [req group]
  (fn [method path]
    (req method (str path (if (str/includes? path "?") "&" "?") "group-id=" group))))

(defn- changes-page [req entry-id & {:keys [document-id vocab-layer-id limit cursor]}]
  (api-call req {:method :get
                 :path (str "/api/v1/audit/entries/" entry-id "/changes?"
                            (str/join "&" (cond-> []
                                            document-id (conj (str "document-id=" document-id))
                                            vocab-layer-id (conj (str "vocab-layer-id=" vocab-layer-id))
                                            limit (conj (str "limit=" limit))
                                            cursor (conj (str "cursor=" cursor)))))}))

(defn- all-changes
  "Every row, following the cursor, `limit` per page."
  [req entry-id & {:as opts}]
  (loop [cursor nil out []]
    (let [resp (apply changes-page req entry-id (mapcat identity (assoc opts :cursor cursor)))]
      (assert-ok resp)
      (let [out (into out (-> resp :body :entries))]
        (if-let [c (-> resp :body :next-cursor)]
          (recur c out)
          out)))))

(defn- by-id [rows] (into {} (map (juxt :id identity)) rows))

(defn- last-op-id [op-type]
  (:id (psc/q1 db {:select [:id] :from [:operations] :where [:= :op_type op-type]
                   :order-by [[:ts :desc]] :limit 1})))

(defn- setup!
  "A project with one document: a text, a word layer (any overlap), a span
  layer on it, a relation layer, a vocabulary with entries, and a few rows
  of each made outside any unit under test."
  []
  (let [proj (create-test-project admin-request "Changes")
        doc-id (create-test-document admin-request proj "Doc")
        tl (id (create-text-layer admin-request proj "Text"))
        text (id (create-text admin-request tl doc-id "the quick brown fox jumps" {"lang" "en"}))
        word (id (create-token-layer admin-request tl "Words"))
        pos (id (create-span-layer admin-request word "POS"))
        dep (id (create-relation-layer admin-request pos "Dependencies"))
        toks (-> (bulk-create-tokens admin-request
                                     (mapv (fn [[b e]] {:token-layer-id word :text text :begin b :end e})
                                           [[0 3] [4 9] [10 15] [16 19] [20 25]]))
                 :body :ids)
        spans (-> (bulk-create-spans admin-request
                                     (mapv (fn [t v] {:span-layer-id pos :tokens [t] :value v})
                                           toks ["DET" "ADJ" "ADJ" "NOUN" "VERB"]))
                  :body :ids)
        rel (id (create-relation admin-request dep (nth spans 3) (nth spans 4) "nsubj"))
        vocab (id (create-vocab-layer admin-request proj "Lexicon"))
        fox (id (create-vocab-item admin-request vocab "fox"))
        jump (id (create-vocab-item admin-request vocab "jump"))
        link (id (create-vocab-link admin-request fox [(nth toks 3)]))]
    {:proj proj :doc doc-id :tl tl :text text :word word :pos pos :dep dep :toks toks
     :spans spans :rel rel :vocab vocab :fox fox :jump jump :link link}))

;; ============================================================
;; Every kind of row
;; ============================================================

(deftest every-kind-of-row
  (let [{:keys [doc text word pos dep toks spans rel vocab fox jump link]} (setup!)
        g (str (random-uuid))
        r (in-group admin-request g)
        ;; creates
        new-tok (id (create-token r word text 0 9))
        new-span (id (create-span r pos [new-tok] "NP"))
        new-rel (id (create-relation r dep (nth spans 0) (nth spans 1) "det"))
        kai (id (create-vocab-item r vocab "kai" {"gloss" "and"}))
        new-link (id (create-vocab-link r kai [(nth toks 0)]))
        ;; updates, one of them written twice
        _ (assert-ok (update-token r (nth toks 4) :precedence 2))
        _ (assert-ok (update-span r (nth spans 1) :value "ADJ2"))
        _ (assert-ok (update-span r (nth spans 1) :value "ADJ3"))
        _ (assert-ok (update-relation r rel "obj"))
        _ (assert-ok (update-vocab-item r jump "jumps"))
        _ (assert-ok (update-vocab-link-metadata r link {"prov" "machine"}))
        _ (assert-ok (update-text-metadata r text {"lang" "fr"}))
        _ (assert-ok (update-document-metadata r doc {"genre" "fable"}))
        ;; written and written back: not listed
        _ (assert-ok (update-span r (nth spans 2) :value "X"))
        _ (assert-ok (update-span r (nth spans 2) :value "ADJ"))
        ;; made and removed again: not listed
        tmp (id (create-token r word text 20 22))
        _ (assert-done (delete-token r tmp))
        ;; deletes
        _ (assert-done (delete-relation r new-rel))
        _ (assert-done (delete-span r (nth spans 0)))
        _ (assert-done (delete-vocab-link r link))
        _ (assert-done (delete-vocab-item r fox))
        rows (all-changes admin-request g)
        row (by-id rows)]
    (is (= (count rows) (count row)) "each row once")
    (testing "a made row has no before"
      (is (= {:kind "token" :document doc :layer word :text text
              :after {:token/id new-tok :token/begin 0 :token/end 9 :token/precedence nil}
              :changed-since false :changed-between false}
             (dissoc (row new-tok) :id)))
      (is (= {:span/id new-span :span/value "NP" :span/tokens [new-tok]} (:after (row new-span))))
      (is (= pos (:layer (row new-span))))
      (is (= {:vocab-item/id kai :vocab-item/layer vocab :vocab-item/form "kai" :metadata {"gloss" "and"}}
             (:after (row kai))))
      (is (= vocab (:vocab-layer (row kai))))
      (is (nil? (:before (row kai))))
      (is (= {:vocab-link/id new-link
              :vocab-link/vocab-item {:vocab-item/id kai :vocab-item/layer vocab :vocab-item/form "kai"}
              :vocab-link/tokens [(nth toks 0)]}
             (:after (row new-link)))))
    (testing "an update has both, from before the first write to after the last"
      (is (= [nil 2] [(:token/precedence (:before (row (nth toks 4))))
                      (:token/precedence (:after (row (nth toks 4))))]))
      (is (= ["ADJ" "ADJ3"] [(:span/value (:before (row (nth spans 1))))
                             (:span/value (:after (row (nth spans 1))))]))
      (is (= ["nsubj" "obj"] [(:relation/value (:before (row rel))) (:relation/value (:after (row rel)))]))
      (is (= dep (:layer (row rel))))
      (is (= ["jump" "jumps"] [(:vocab-item/form (:before (row jump))) (:vocab-item/form (:after (row jump)))]))
      (is (= [{"lang" "en"} {"lang" "fr"}] [(:metadata (:before (row text))) (:metadata (:after (row text)))]))
      (is (= "text" (:kind (row text))))
      (is (= [nil {"genre" "fable"}] [(:metadata (:before (row doc))) (:metadata (:after (row doc)))]))
      (is (= "Doc" (:document/name (:after (row doc))))))
    (testing "a deleted row has no after"
      (is (= {:span/id (nth spans 0) :span/value "DET" :span/tokens [(nth toks 0)]}
             (:before (row (nth spans 0)))))
      (is (not (contains? (row (nth spans 0)) :after)))
      (is (= "fox" (:vocab-item/form (:before (row fox)))))
      (is (not (contains? (row fox) :after)))
      (testing "a link names its entry as it was then"
        (is (= "fox" (-> (row link) :before :vocab-link/vocab-item :vocab-item/form)))))
    (testing "what ended as it began is left out"
      (is (nil? (row (nth spans 2))))
      (is (nil? (row tmp)))
      (is (nil? (row new-rel))))
    (testing "the rows of one document or one vocabulary"
      (is (= (set (keep #(when (= doc (:document %)) (:id %)) rows))
             (set (map :id (all-changes admin-request g :document-id doc)))))
      (is (= #{kai jump fox}
             (set (map :id (all-changes admin-request g :vocab-layer-id vocab))))))
    (testing "every row unchanged since"
      (is (not-any? :changed-since rows)))))

;; ============================================================
;; A person writing between a group's batches
;; ============================================================

(deftest a-person-between-two-batches
  (let [{:keys [proj doc spans]} (setup!)
        _ (assert-done (add-project-writer admin-request proj "user1@example.com"))
        [s0 s1 s2 s3] spans
        g (str (random-uuid))
        batch! (fn [ops]
                 (let [resp (api-call admin-request {:method :post :path (str "/api/v1/batch?group-id=" g)
                                                     :body ops})]
                   (assert-ok resp)
                   (is (every? #(< (:status %) 300) (:body resp)))))
        patch (fn [s v] {:path (str "/api/v1/spans/" s) :method "patch" :body {:value v}})]
    (batch! [(patch s0 "g1") (patch s1 "g1")])
    ;; the person, in no group
    (assert-ok (update-span user1-request s2 :value "person"))
    (assert-ok (update-span user1-request s1 :value "person"))
    (batch! [(patch s1 "g2") (patch s3 "g2")])
    ;; and after the group
    (assert-ok (update-span user1-request s3 :value "later"))
    (let [row (by-id (all-changes admin-request g))]
      (is (= #{s0 s1 s3} (set (keys row))) "the person's own row is not the group's")
      (is (= ["DET" "g1" false false]
             ((juxt (comp :span/value :before) (comp :span/value :after) :changed-since :changed-between)
              (row s0))))
      (testing "a row the person wrote between the group's writes"
        (is (= ["ADJ" "g2" false true]
               ((juxt (comp :span/value :before) (comp :span/value :after) :changed-since :changed-between)
                (row s1)))))
      (testing "a row the person wrote after"
        (is (= ["NOUN" "g2" true false]
               ((juxt (comp :span/value :before) (comp :span/value :after) :changed-since :changed-between)
                (row s3))))))
    (testing "a document's version bumps and a vocabulary's time are not changes"
      (assert-ok (update-span user1-request s0 :value "g1"))
      (is (false? (:changed-since ((by-id (all-changes admin-request g)) s0)))
          "written again with the value it had")
      (is (nil? ((by-id (all-changes admin-request g)) doc))))))

;; ============================================================
;; A merge, and an entry deleted with links in two documents
;; ============================================================

(defn- two-documents! []
  (let [{:keys [proj tl word vocab fox jump] :as s} (setup!)
        doc2 (create-test-document admin-request proj "Doc2")
        text2 (id (create-text admin-request tl doc2 "fox fox"))
        [a b] (-> (bulk-create-tokens admin-request [{:token-layer-id word :text text2 :begin 0 :end 3}
                                                     {:token-layer-id word :text text2 :begin 4 :end 7}])
                  :body :ids)
        foxes (id (create-vocab-item admin-request vocab "foxes"))
        l2 (id (create-vocab-link admin-request foxes [a]))
        l3 (id (create-vocab-link admin-request foxes [b] {"note" "x"}))]
    (assoc s :doc2 doc2 :doc2-tokens [a b] :l2 l2 :l3 l3 :foxes foxes)))

(deftest a-merge
  (let [{:keys [doc doc2 vocab fox foxes link l2 l3]} (two-documents!)
        _ (assert-ok (api-call admin-request {:method :post :path (str "/api/v1/vocab-items/" fox "/merge")
                                              :body {:losers [foxes]}}))
        entry (last-op-id "vocab-item/merge-into")
        row (by-id (all-changes admin-request entry))]
    (is (= #{l2 l3 foxes} (set (keys row))) "the survivor's own link did not change")
    (is (= [doc2 doc2] [(:document (row l2)) (:document (row l3))]))
    (is (= ["foxes" "fox"] [(-> (row l2) :before :vocab-link/vocab-item :vocab-item/form)
                            (-> (row l2) :after :vocab-link/vocab-item :vocab-item/form)]))
    (is (= {"note" "x"} (:metadata (:after (row l3)))))
    (is (= "foxes" (:vocab-item/form (:before (row foxes)))))
    (is (not (contains? (row foxes) :after)))
    (is (nil? (row link)))
    (is (nil? (row doc)))))

(deftest an-entry-deleted-with-links-in-two-documents
  (let [{:keys [doc doc2 doc2-tokens fox link toks]} (two-documents!)
        l4 (id (create-vocab-link admin-request fox [(nth toks 0)]))
        doc2-link (id (create-vocab-link admin-request fox [(first doc2-tokens)]))
        _ (assert-done (delete-vocab-item admin-request fox))
        entry (last-op-id "vocab-item/delete")
        row (by-id (all-changes admin-request entry))]
    (is (= #{fox link l4 doc2-link} (set (keys row))))
    (is (= #{doc doc2} (set (keep :document (vals row)))))
    (is (every? #(not (contains? % :after)) (vals row)))
    (is (= "fox" (-> (row doc2-link) :before :vocab-link/vocab-item :vocab-item/form)))))

;; ============================================================
;; Imports: rows the audit log names late or not at all
;; ============================================================

(deftest an-import-lists-the-rows-it-made-unrecorded
  (let [proj (create-test-project admin-request "Import")
        tl (id (create-text-layer admin-request proj "Text"))
        word (id (create-token-layer admin-request tl "Words"))
        pos (id (create-span-layer admin-request word "POS"))
        g (str (random-uuid))
        r (in-group admin-request g)
        d (create-test-document r proj "Imported")
        text (id (create-text r tl d "a b c d e f g h"))
        toks (-> (bulk-create-tokens r (mapv (fn [i] {:token-layer-id word :text text :begin (* 2 i) :end (inc (* 2 i))})
                                             (range 8)))
                 :body :ids)
        spans (-> (bulk-create-spans r (mapv (fn [t] {:span-layer-id pos :tokens [t] :value "X"}) toks)) :body :ids)
        unrecorded (fn [] (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:audit_writes]
                                          :where [:= :target_table "tokens"]})))]
    (is (zero? (unrecorded)) "the import's tokens have no audit row")
    (let [rows (all-changes admin-request g :limit 3)
          row (by-id rows)]
      (is (= (count rows) (count row)))
      (is (= (set (concat [d text] toks spans)) (set (keys row))))
      (is (every? #(not (contains? % :before)) rows))
      (is (= {:token/id (nth toks 2) :token/begin 4 :token/end 5 :token/precedence nil} (:after (row (nth toks 2)))))
      (is (= text (:text (row (nth toks 2))))))
    (testing "paging stays whole while a person's writes record rows whole"
      (let [p1 (changes-page admin-request g :limit 5)
            _ (assert-ok (update-token admin-request (nth toks 6) :precedence 3))
            _ (assert-ok (update-span admin-request (nth spans 0) :value "Y"))
            rest-rows (all-changes admin-request g :limit 5)
            ;; read the rest from the first page's cursor
            p2 (loop [cursor (-> p1 :body :next-cursor) out []]
                 (if cursor
                   (let [resp (changes-page admin-request g :limit 5 :cursor cursor)]
                     (recur (-> resp :body :next-cursor) (into out (-> resp :body :entries))))
                   out))
            ids (concat (map :id (-> p1 :body :entries)) (map :id p2))]
        (is (= (count ids) (count (set ids))) "no row twice")
        (is (= (set (map :id rest-rows)) (set ids)) "no row missed")
        (let [row (by-id rest-rows)]
          (is (true? (:changed-since (row (nth toks 6)))))
          (is (= "X" (:span/value (:after (row (nth spans 0))))))
          (is (true? (:changed-since (row (nth spans 0)))))
          (is (false? (:changed-since (row (nth toks 1))))))))))

;; ============================================================
;; A restore, a batch, and the batch clamp
;; ============================================================

(deftest a-restore-is-a-unit
  (let [{:keys [doc spans toks word text rel]} (setup!)
        t0 (latest-op-ts)
        _ (assert-ok (update-span admin-request (nth spans 1) :value "changed"))
        made (id (create-token admin-request word text 0 1))
        _ (assert-done (delete-span admin-request (nth spans 4)))
        resp (api-call admin-request {:method :post
                                      :path (str "/api/v1/documents/" doc "/restore?as-of="
                                                 (java.net.URLEncoder/encode (str t0) "UTF-8"))})
        _ (assert-ok resp)
        row (by-id (all-changes admin-request (last-op-id "document/restore")))]
    (is (= #{(nth spans 1) made (nth spans 4) rel} (set (keys row)))
        "the span's delete took its relation with it")
    (is (= ["changed" "ADJ"] [(:span/value (:before (row (nth spans 1)))) (:span/value (:after (row (nth spans 1))))]))
    (is (not (contains? (row made) :after)))
    (is (= {:span/id (nth spans 4) :span/value "VERB" :span/tokens [(nth toks 4)]} (:after (row (nth spans 4)))))
    (is (not (contains? (row (nth spans 4)) :before)))))

(deftest a-batch-and-the-clamp
  (let [{:keys [doc spans]} (setup!)
        resp (api-call admin-request {:method :post :path "/api/v1/batch"
                                      :body [{:path (str "/api/v1/spans/" (nth spans 0)) :method "patch" :body {:value "a"}}
                                             {:path (str "/api/v1/spans/" (nth spans 0)) :method "patch" :body {:value "b"}}
                                             {:path (str "/api/v1/spans/" (nth spans 1)) :method "patch" :body {:value "c"}}]})
        _ (assert-ok resp)
        entry (last (-> (get-document-audit admin-request doc) :body :entries))
        batch-id (:audit/batch-id entry)
        rows (all-changes admin-request batch-id)
        row (by-id rows)]
    (is (some? batch-id))
    (is (= 2 (count rows)))
    (is (= ["DET" "b"] [(:span/value (:before (row (nth spans 0)))) (:span/value (:after (row (nth spans 0))))]))
    (testing "the befores are the document at a time inside the batch, which reads as before it"
      (let [inside (-> entry :audit/ops second :op/time)
            at (hread/get-with-layer-data-at db doc inside)
            values (into {} (for [tl (:document/text-layers at) tkl (:text-layer/token-layers tl)
                                  sl (:token-layer/span-layers tkl) s (:span-layer/spans sl)]
                              [(:span/id s) s]))]
        (is (= (:before (row (nth spans 0))) (values (nth spans 0))))
        (is (= (:before (row (nth spans 1))) (values (nth spans 1))))))
    (testing "one operation of a batch, by its id, is what that operation changed"
      (let [[op1 op2] (map :op/id (:audit/ops entry))
            one (all-changes admin-request op1)
            two (all-changes admin-request op2)]
        (is (= [[(nth spans 0) "DET" "a" true]]
               (map (juxt :id (comp :span/value :before) (comp :span/value :after) :changed-since) one)))
        (is (= [[(nth spans 0) "a" "b" false]]
               (map (juxt :id (comp :span/value :before) (comp :span/value :after) :changed-since) two)))))
    (testing "and the document's log reads it as an entry of its own, done at the batch's end"
      (let [op (-> entry :audit/ops second)
            r (api-call admin-request {:method :get
                                       :path (str "/api/v1/documents/" doc "/audit?entry-id=" (:op/id op))})
            [e :as es] (-> r :body :entries)]
        (assert-ok r)
        (is (= 1 (count es)))
        (is (= (:op/id op) (:audit/id e)))
        (is (= [(:op/id op)] (map :op/id (:audit/ops e))))
        (is (= (:op/end-time op) (:audit/end-time e)) "a time inside a batch reads as before it")
        (is (not (contains? e :audit/batch-id)) "the entry is the operation, not its batch")))))

;; An action inside a group (an operation of it, by its own id) is read as an
;; entry of its own: what it changed, and its entry in a document's log.
(deftest an-action-inside-a-group
  (let [{:keys [doc spans]} (setup!)
        g (str (random-uuid))
        r (in-group admin-request g)
        _ (assert-ok (update-span r (nth spans 0) :value "one"))
        _ (assert-ok (update-span r (nth spans 1) :value "two"))
        group (last (-> (get-document-audit admin-request doc) :body :entries))
        [op1 op2] (:audit/ops group)]
    (is (= g (str (:audit/group-id group))))
    (is (= [(nth spans 1)] (map :id (all-changes admin-request (:op/id op2)))))
    (is (= [(nth spans 0) (nth spans 1)] (map :id (all-changes admin-request g))) "the group is unchanged")
    (let [r (api-call admin-request {:method :get
                                     :path (str "/api/v1/documents/" doc "/audit?entry-id=" (:op/id op1))})
          e (-> r :body :entries first)]
      (assert-ok r)
      (is (= [(:op/id op1) [(:op/id op1)] (:op/end-time op1)]
             [(:audit/id e) (map :op/id (:audit/ops e)) (:audit/end-time e)]))
      (is (not (contains? e :audit/group-id)) "the entry is the operation, not its group"))))

;; ============================================================
;; Paging while the unit and others go on writing
;; ============================================================

(deftest pages-hold-under-concurrent-writes
  (let [{:keys [proj pos toks spans]} (setup!)
        _ (assert-done (add-project-writer admin-request proj "user1@example.com"))
        g (str (random-uuid))
        r (in-group admin-request g)
        made (vec (for [i (range 12)] (id (create-span r pos [(nth toks (mod i 5))] (str "v" i)))))
        _ (assert-ok (update-span r (nth spans 2) :value "g"))
        p1 (changes-page admin-request g :limit 4)
        ;; the group goes on, someone else writes, one of the group's rows is
        ;; deleted by someone else
        more (vec (for [i (range 3)] (id (create-span r pos [(nth toks i)] (str "w" i)))))
        _ (assert-ok (update-span user1-request (nth spans 3) :value "other"))
        _ (assert-done (delete-span admin-request (nth made 5)))
        _ (assert-ok (update-span r (nth made 0) :value "again"))
        seen (loop [cursor (-> p1 :body :next-cursor) out (vec (-> p1 :body :entries))]
               (if cursor
                 (let [resp (changes-page admin-request g :limit 4 :cursor cursor)]
                   (assert-ok resp)
                   (recur (-> resp :body :next-cursor) (into out (-> resp :body :entries))))
                 out))
        ids (map :id seen)]
    (is (= (count ids) (count (set ids))) "no row twice")
    (is (= (set (concat made more [(nth spans 2)])) (set ids)) "no row missed, the new ones at the end")
    (is (= (concat made [(nth spans 2)] more) ids) "in the order of the group's first write to each")
    (is (true? (:changed-since ((by-id seen) (nth made 5)))))
    (testing "a bad cursor"
      (is (= 400 (:status (changes-page admin-request g :cursor "bm90IGpzb24")))))))

;; ============================================================
;; Access
;; ============================================================

(deftest access
  (let [{:keys [proj doc spans vocab fox toks link]} (setup!)
        ;; user1 reads the project
        _ (assert-done (add-project-reader admin-request proj "user1@example.com"))
        g (str (random-uuid))
        r (in-group admin-request g)
        _ (assert-ok (update-span r (nth spans 0) :value "g"))
        _ (assert-ok (update-vocab-item r fox "foks"))]
    (testing "a reader of the project reads every row"
      (is (= #{(nth spans 0) fox} (set (map :id (all-changes user1-request g))))))
    (testing "a non-member is refused, as for an id that is no entry"
      (let [resp (changes-page user2-request g)]
        (is (= 403 (:status resp)))
        (is (not (:unresolved (:body resp)))))
      (let [resp (changes-page user2-request (random-uuid))]
        (is (= 403 (:status resp)))
        (is (true? (:unresolved (:body resp))))))
    (testing "an admin is told an unknown entry is not found"
      (is (= 404 (:status (changes-page admin-request (random-uuid))))))
    (testing "a borrowing project: its reader reads its own documents and the vocabulary, not the home's"
      (let [borrower (create-test-project admin-request "Borrower")
            _ (assert-done (link-vocab-to-project admin-request borrower vocab))
            _ (assert-done (add-project-reader admin-request borrower "user2@example.com"))
            tl (id (create-text-layer admin-request borrower "Text"))
            word (id (create-token-layer admin-request tl "Words"))
            bdoc (create-test-document admin-request borrower "B")
            btext (id (create-text admin-request tl bdoc "foks"))
            btok (id (create-token admin-request word btext 0 4))
            blink (id (create-vocab-link admin-request fox [btok]))
            hlink (id (create-vocab-link admin-request fox [(nth toks 1)]))
            other (id (create-vocab-item admin-request vocab "fox2"))
            _ (assert-ok (api-call admin-request {:method :post :path (str "/api/v1/vocab-items/" other "/merge")
                                                  :body {:losers [fox]}}))
            entry (last-op-id "vocab-item/merge-into")]
        (is (= #{blink hlink link fox} (set (map :id (all-changes admin-request entry)))))
        (is (= #{blink fox} (set (map :id (all-changes user2-request entry)))))
        (is (= #{hlink link fox} (set (map :id (all-changes user1-request entry)))))
        (testing "a filter on a document the caller cannot read gives nothing"
          (is (empty? (all-changes user2-request entry :document-id doc))))))))

(deftest a-unit-in-a-deleted-project
  (let [{:keys [proj spans]} (setup!)
        _ (assert-done (add-project-reader admin-request proj "user1@example.com"))
        g (str (random-uuid))
        _ (assert-ok (update-span (in-group admin-request g) (nth spans 0) :value "g"))
        _ (is (= 1 (count (all-changes user1-request g))))
        _ (assert-done (delete-test-project admin-request proj))]
    (is (= 404 (:status (changes-page admin-request g))))
    (is (= 403 (:status (changes-page user1-request g))))))

;; ============================================================
;; The property: every before, put back, gives the state before
;; ============================================================

(defn- flat-document
  "The deep read as `{[kind id] entity}`, a link's entry named by id alone
  (its form is the entry's row, not the link's)."
  [deep]
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
           (for [s sls rl (:span-layer/relation-layers s) x (:relation-layer/relations rl)]
             [["relation" (:relation/id x)] x])
           (for [k tkls v (:token-layer/vocabs k) x (:vocab-layer/vocab-links v)]
             [["vocab-link" (:vocab-link/id x)]
              (update x :vocab-link/vocab-item select-keys [:vocab-item/id])])))))

(defn- flat-vocab [v]
  (into {["vocab-layer" (:vocab/id v)] (select-keys v [:vocab/id :vocab/name :vocab/project :config])}
        (for [i (:vocab/items v)] [["vocab-item" (:vocab-item/id i)] i])))

(defn- put-back
  "`state` with every row's before put back over it."
  [state rows]
  (reduce (fn [m {:keys [kind id before]}]
            (let [k [kind id]]
              (if before
                (assoc m k (cond-> before
                             (= kind "vocab-link") (update :vocab-link/vocab-item select-keys [:vocab-item/id])))
                (dissoc m k))))
          state rows))

(defn- random-unit!
  "`n` random writes of every kind under group `g`, chosen by `rng`."
  [^Random rng {:keys [doc text word pos dep vocab toks spans rel fox jump link]} g n]
  (let [r (in-group admin-request g)
        pick (fn [xs] (when (seq xs) (nth (vec xs) (.nextInt rng (count xs)))))
        ;; token -> the spans and links on it, so a token goes only once bare
        tokens (atom (set toks))
        span-of (atom (into {} (map vector spans toks)))
        rels (atom {rel [(nth spans 3) (nth spans 4)]})
        items (atom #{fox jump})
        links (atom {link [fox (nth toks 3)]})
        busy-tokens (fn [] (into (set (vals @span-of)) (map second (vals @links))))
        busy-spans (fn [] (set (mapcat identity (vals @rels))))
        busy-items (fn [] (set (map first (vals @links))))]
    (dotimes [_ n]
      (case (.nextInt rng 14)
        0 (let [b (.nextInt rng 20)]
            (swap! tokens conj (id (create-token r word text b (+ b 1 (.nextInt rng 5))))))
        1 (when-let [t (pick @tokens)]
            (assert-ok (update-token r t :precedence (.nextInt rng 4))))
        2 (when-let [t (pick (remove (busy-tokens) @tokens))]
            (assert-done (delete-token r t))
            (swap! tokens disj t))
        3 (when-let [t (pick @tokens)]
            (swap! span-of assoc (id (create-span r pos [t] (str "v" (.nextInt rng 3)))) t))
        4 (when-let [s (pick (keys @span-of))]
            (assert-ok (update-span r s :value (str "v" (.nextInt rng 3)))))
        5 (when-let [s (pick (remove (busy-spans) (keys @span-of)))]
            (assert-done (delete-span r s))
            (swap! span-of dissoc s))
        6 (when-let [[a b] (seq (take 2 (shuffle (keys @span-of))))]
            (when b (swap! rels assoc (id (create-relation r dep a b "r")) [a b])))
        7 (when-let [x (pick (keys @rels))]
            (if (.nextBoolean rng)
              (assert-ok (update-relation r x (str "r" (.nextInt rng 3))))
              (do (assert-done (delete-relation r x)) (swap! rels dissoc x))))
        8 (swap! items conj (id (create-vocab-item r vocab (str "e" (.nextInt rng 100)))))
        9 (when-let [i (pick @items)]
            (if (and (.nextBoolean rng) (not ((busy-items) i)))
              (do (assert-done (delete-vocab-item r i)) (swap! items disj i))
              (assert-ok (update-vocab-item r i (str "f" (.nextInt rng 100))))))
        10 (when-let [i (pick @items)]
             (when-let [t (pick @tokens)]
               (swap! links assoc (id (create-vocab-link r i [t])) [i t])))
        11 (when-let [l (pick (keys @links))]
             (if (.nextBoolean rng)
               (assert-ok (update-vocab-link-metadata r l {"k" (.nextInt rng 3)}))
               (do (assert-done (delete-vocab-link r l)) (swap! links dissoc l))))
        12 (assert-ok (patch-document-metadata r doc [{:op "set" :path ["k"] :value (.nextInt rng 3)}]))
        13 (when-let [t (pick @tokens)]
             (assert-ok (update-token-metadata r t {"m" (.nextInt rng 3)})))))))

(deftest putting-every-before-back-gives-the-state-before
  (doseq [seed [1 2 3 4 5]]
    (testing (str "seed " seed)
      (with-clean-db
        (fn []
          (let [{:keys [doc vocab] :as s} (setup!)
                t0 (latest-op-ts)
                before (merge (flat-document (hread/get-with-layer-data-at db doc t0))
                              (flat-vocab (hread/get-vocab-at db vocab t0 true)))
                g (str (random-uuid))
                _ (random-unit! (Random. seed) s g 40)
                now (merge (flat-document (doc/get-with-layer-data db doc))
                           (flat-vocab (hread/get-vocab-at db vocab (latest-op-ts) true)))
                rows (all-changes admin-request g :limit 7)]
            (is (= (count rows) (count (set (map :id rows)))))
            (is (not-any? :changed-since rows))
            (testing "every after is the row as it is now"
              (doseq [{:keys [kind id after]} rows]
                (is (= (some-> after (cond-> (= kind "vocab-link")
                                       (update :vocab-link/vocab-item select-keys [:vocab-item/id])))
                       (now [kind id]))
                    (pr-str kind id))))
            (is (= before (put-back now rows)))))))))

(deftest the-core-read-answers-nil-for-no-unit
  (is (nil? (changes/changes-page db (random-uuid) {}))))
