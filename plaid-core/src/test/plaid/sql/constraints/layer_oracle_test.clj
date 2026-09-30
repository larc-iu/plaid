(ns plaid.sql.constraints.layer-oracle-test
  "Randomized oracle for layer constraints. Each seed builds a small project
  with a ud-shaped and an igt-shaped stack on one text, declares every
  constraint type, and runs random steps through the REST surface: span,
  relation and link writes, child token creates, sentence and word splits,
  merges and shifts, text saves, restores, and batches of them. After every
  step a checker written apart from `plaid.sql.constraints.layer` reads the
  document's rows and asserts:

    - every declared constraint holds,
    - a refused step (422) left every row as it was,
    - an accepted step's state before its remedies (read as of its last own
      operation) broke only remediable rules, and none of them on a row
      the step itself wrote in that respect (a direct violation must be
      refused, never remedied),
    - what core stored equals this namespace's own model of the remedies
      applied to that state.

  Seeds use `java.util.SplittableRandom`. `PLAID_ORACLE_SEEDS` sets how many
  (default 40); a failing seed is printed for replay."
  (:require [clojure.data]
            [clojure.set :as set]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.history.read :as hread]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer-opts create-span-layer create-relation-layer
                                        create-text create-token create-span create-relation
                                        create-vocab-layer create-vocab-item create-vocab-link
                                        link-vocab-to-project]])
  (:import (java.util SplittableRandom)))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

;; ============================================================
;; Randomness
;; ============================================================

(defn- n-of [^SplittableRandom r n] (.nextInt r (int n)))
(defn- chance [^SplittableRandom r p] (< (.nextDouble r) p))
(defn- pick [r coll] (let [v (vec coll)] (when (seq v) (nth v (n-of r (count v))))))

;; ============================================================
;; Rows as the checker reads them
;; ============================================================

(defn- json-val [s] (when (some? s) (psc/read-json s)))

(defn- snapshot
  "The document's rows: tokens {id {:layer :b :e}}, spans {id {:layer
  :value :tokens}}, relations {id {:layer :s :t :value}}, links {id
  {:tokens}}, and meta {id {\"prov\" ...}} for spans and relations."
  [doc]
  (let [doc (str doc)
        tokens (psc/q db {:select [:id :token_layer_id :begin :end_] :from :tokens
                          :where [:= :document_id doc]})
        spans (psc/q db {:select [:id :span_layer_id :value] :from :spans :where [:= :document_id doc]})
        st (group-by (comp str :span_id)
                     (psc/q db {:select [:st.span_id :st.token_id :st.order_idx] :from [[:span_tokens :st]]
                                :join [[:spans :s] [:= :s.id :st.span_id]]
                                :where [:= :s.document_id doc] :order-by [:st.span_id :st.order_idx]}))
        rels (psc/q db {:select [:id :relation_layer_id :source_span_id :target_span_id :value]
                        :from :relations :where [:= :document_id doc]})
        links (psc/q db {:select [:id] :from :vocab_links :where [:= :document_id doc]})
        lt (group-by (comp str :vocab_link_id)
                     (psc/q db {:select [:vlt.vocab_link_id :vlt.token_id :vlt.order_idx]
                                :from [[:vocab_link_tokens :vlt]]
                                :join [[:vocab_links :vl] [:= :vl.id :vlt.vocab_link_id]]
                                :where [:= :vl.document_id doc] :order-by [:vlt.vocab_link_id :vlt.order_idx]}))
        ids (concat (map (comp str :id) spans) (map (comp str :id) rels))
        meta (group-by (comp str :entity_id)
                       (when (seq ids)
                         (psc/q db {:select [:entity_id :key :value] :from :entity_metadata
                                    :where [:and [:in :entity_id (vec ids)] [:in :key ["prov" "provConfirmed"]]]})))]
    {:tokens (into {} (map (fn [t] [(str (:id t)) {:layer (str (:token_layer_id t)) :b (:begin t) :e (:end_ t)}])) tokens)
     :spans (into {} (map (fn [s] [(str (:id s)) {:layer (str (:span_layer_id s)) :value (json-val (:value s))
                                                  :tokens (mapv (comp str :token_id) (get st (str (:id s))))}]))
                  spans)
     :relations (into {} (map (fn [r] [(str (:id r)) {:layer (str (:relation_layer_id r)) :s (str (:source_span_id r))
                                                      :t (str (:target_span_id r)) :value (json-val (:value r))}]))
                      rels)
     :links (into {} (map (fn [l] [(str (:id l)) {:tokens (mapv (comp str :token_id) (get lt (str (:id l))))}])) links)
     :meta (into {} (map (fn [[id rs]] [id (into {} (map (fn [r] [(:key r) (json-val (:value r))])) rs)])) meta)}))

(defn- snapshot-at
  "The same rows as the audit log folds them at `ts` (an operations.ts
  string), inside a batch too: the public as-of read places a time inside
  an atomic batch before the batch, as History shows it."
  [doc ts]
  (let [folded (#'hread/fold-rows (#'hread/q-doc-rows db (str doc) {:lte ts}))
        of (fn [t] (#'hread/entities-of folded t))
        [tokens spans relations vocab-links] (map of ["tokens" "spans" "relations" "vocab_links"])
        meta-of (fn [r] (select-keys (or (:metadata r) {}) ["prov" "provConfirmed"]))]
    {:tokens (into {} (map (fn [t] [(str (:id t)) {:layer (str (:token_layer_id t)) :b (:begin t) :e (:end_ t)}])) tokens)
     :spans (into {} (map (fn [s] [(str (:id s)) {:layer (str (:span_layer_id s)) :value (json-val (:value s))
                                                  :tokens (mapv str (:tokens s))}]))
                  spans)
     :relations (into {} (map (fn [r] [(str (:id r)) {:layer (str (:relation_layer_id r)) :s (str (:source_span_id r))
                                                      :t (str (:target_span_id r)) :value (json-val (:value r))}]))
                      relations)
     :links (into {} (map (fn [l] [(str (:id l)) {:tokens (mapv str (:tokens l))}])) vocab-links)
     :meta (into {} (keep (fn [r] (let [m (meta-of r)] (when (seq m) [(str (:id r)) m]))) (concat spans relations)))}))

(defn- data-of [snap] (dissoc snap :meta))

;; ============================================================
;; The checker
;; ============================================================

(def ^:private gloss-values ["N" "V" "1SG" "NOM" "PL"])
(def ^:private deprels ["root" "nsubj" "obj" "det"])

(defn- value-bad?
  "Whether `v` breaks a value-set of `values` split on `delims` (all parts)
  or on `delims` with only the first part checked."
  [v values delims first?]
  (cond
    (nil? v) false
    (not (string? v)) true
    (str/blank? v) false
    :else (let [parts (if (str/blank? delims)
                        [v]
                        (str/split v (re-pattern (str "[" (java.util.regex.Pattern/quote delims) "]")) -1))]
            (if first?
              (not (contains? (set values) (str/trim (first parts))))
              (not (every? #(and (seq (str/trim %)) (contains? (set values) (str/trim %))) parts))))))

(defn- machine? [snap id]
  (let [m (get-in snap [:meta id])]
    (and (some? (get m "prov")) (not= "contributed" (get m "prov")) (not (true? (get m "provConfirmed"))))))

(defn- place [snap sid]
  (let [bs (keep #(get-in snap [:tokens % :b]) (get-in snap [:spans sid :tokens]))]
    (when (seq bs) (apply min bs))))

(defn- ancestor-of [snap layer p]
  (when p
    (some (fn [[id t]] (when (and (= layer (:layer t)) (<= (:b t) p) (< p (:e t))) id)) (:tokens snap))))

(defn- has-cycle? [edges]
  (let [adj (group-by first edges)
        state (volatile! {})]
    (letfn [(visit [n]
              (case (get @state n)
                :gray true
                :black false
                (do (vswap! state assoc n :gray)
                    (let [c (some (fn [[_ t]] (visit t)) (get adj n))]
                      (vswap! state assoc n :black)
                      (boolean c)))))]
      (boolean (some visit (distinct (map first edges)))))))

(defn- violations
  "Every broken rule in `snap`, as maps {:type :ids}."
  [{:keys [sl wl swl ml gloss lemma mgloss deps enh]} snap]
  (let [of-layer (fn [k l] (filter #(= l (:layer (val %))) (get snap k)))
        extents (fn [l] (set (map (fn [[_ t]] [(:b t) (:e t)]) (of-layer :tokens l))))
        coext (fn [child parent]
                (let [ok (extents parent)]
                  (for [[id t] (of-layer :tokens child) :when (not (ok [(:b t) (:e t)]))]
                    {:type :coextensive :ids #{id}})))
        single-span (fn [l]
                      (for [[_ ss] (group-by first (for [[sid s] (of-layer :spans l) t (:tokens s)] [t sid]))
                            :when (> (count ss) 1)]
                        {:type :single-span :layer l :ids (set (map second ss))}))
        single-link (fn [l]
                      (for [[_ ls] (group-by first (for [[lid lk] (:links snap)
                                                         :when (= 1 (count (:tokens lk)))
                                                         :let [t (first (:tokens lk))]
                                                         :when (= l (get-in snap [:tokens t :layer]))]
                                                     [t lid]))
                            :when (> (count ls) 1)]
                        {:type :single-link :ids (set (map second ls))}))
        same-ancestor (fn [l]
                        (for [[rid r] (of-layer :relations l)
                              :let [a (ancestor-of snap sl (place snap (:s r)))
                                    b (ancestor-of snap sl (place snap (:t r)))]
                              :when (or (nil? a) (nil? b) (not= a b))]
                          {:type :same-ancestor :ids #{rid}}))
        dep-rels (of-layer :relations deps)]
    (concat
     (coext swl wl) (coext ml wl)
     (single-span gloss) (single-span lemma) (single-span mgloss)
     (for [[id s] (of-layer :spans gloss)
           :when (and (value-bad? (:value s) gloss-values "." false) (not (machine? snap id)))]
       {:type :value-set :ids #{id}})
     (for [[id r] dep-rels
           :when (and (value-bad? (:value r) deprels ":" true) (not (machine? snap id)))]
       {:type :value-set :ids #{id}})
     (for [[_ rs] (group-by (comp :t val) dep-rels) :when (> (count rs) 1)]
       {:type :max-in-degree :ids (set (map key rs))})
     (when (has-cycle? (for [[_ r] dep-rels :when (not= (:s r) (:t r))] [(:s r) (:t r)]))
       [{:type :acyclic :ids #{}}])
     (same-ancestor deps) (same-ancestor enh)
     (single-link wl) (single-link ml))))

;; ============================================================
;; The model of the remedies
;; ============================================================

(defn- drop-relations [snap ids]
  (update snap :relations #(apply dissoc % ids)))

(defn- drop-spans [snap ids]
  (let [ids (set ids)
        rels (keep (fn [[rid r]] (when (or (ids (:s r)) (ids (:t r))) rid)) (:relations snap))]
    (-> snap (update :spans #(apply dissoc % ids)) (drop-relations rels))))

(defn- drop-tokens
  "A token delete's cascade: spans and links lose the tokens, and those left
  with none go (a span with its relations)."
  [snap ids]
  (let [ids (set ids)
        trim (fn [m] (into {} (map (fn [[k v]] [k (update v :tokens #(vec (remove ids %)))])) m))
        snap (-> snap (update :tokens #(apply dissoc % ids)) (update :spans trim) (update :links trim))
        empty-spans (keep (fn [[k v]] (when (empty? (:tokens v)) k)) (:spans snap))
        empty-links (keep (fn [[k v]] (when (empty? (:tokens v)) k)) (:links snap))]
    (-> snap (drop-spans empty-spans) (update :links #(apply dissoc % empty-links)))))

(defn- remedy
  "Apply the remedies, in core's order, to the state before them."
  [{:keys [gloss lemma mgloss deps enh wl ml] :as cfg} before-step snap]
  (let [touched-span? (fn [s id] (not= (get-in before-step [:spans id :tokens]) (get-in s [:spans id :tokens])))
        touched-link? (fn [s id] (not= (get-in before-step [:links id :tokens]) (get-in s [:links id :tokens])))
        pre-begin (fn [s id]
                    (let [toks (or (get-in before-step [:spans id :tokens]) (get-in s [:spans id :tokens]))
                          bs (keep #(or (get-in before-step [:tokens % :b]) (get-in s [:tokens % :b])) toks)]
                      (if (seq bs) (apply min bs) Long/MAX_VALUE)))
        by-type (fn [s t] (filter #(= t (:type %)) (violations cfg s)))
        ;; coextensive
        snap (drop-tokens snap (mapcat :ids (by-type snap :coextensive)))
        ;; single-span, one layer at a time
        snap (reduce
              (fn [s l]
                (reduce
                 (fn [s {:keys [ids]}]
                   (let [ids (filter #(contains? (:spans s) %) ids)]
                     (if (< (count ids) 2)
                       s
                       (let [untouched (sort (remove #(touched-span? s %) ids))
                             keep (or (first untouched) (first (sort ids)))
                             others (sort-by (juxt #(pre-begin s %) identity) (remove #{keep} ids))
                             kv (get-in s [:spans keep :value])
                             joined (if (and (some? kv) (not (string? kv)))
                                      kv
                                      (let [strs (distinct (filter #(and (string? %) (not (str/blank? %)))
                                                                   (cons kv (map #(get-in s [:spans % :value]) others))))]
                                        (if (seq strs) (str/join " | " strs) kv)))
                             joined (if (and (= l gloss) (value-bad? joined gloss-values "." false)) kv joined)]
                         (-> s (assoc-in [:spans keep :value] joined) (drop-spans others))))))
                 s
                 (filter #(= l (:layer %)) (by-type s :single-span))))
              snap [gloss lemma mgloss])
        ;; single-link
        snap (reduce (fn [s {:keys [ids]}]
                       (let [ids (filter #(contains? (:links s) %) ids)]
                         (if (< (count ids) 2)
                           s
                           (let [untouched (sort (remove #(touched-link? s %) ids))
                                 keep (or (first untouched) (first (sort ids)))]
                             (update s :links #(apply dissoc % (remove #{keep} ids)))))))
                     snap (by-type snap :single-link))
        ;; same-ancestor
        snap (drop-relations snap (mapcat :ids (by-type snap :same-ancestor)))]
    (is (some? [wl ml deps enh]))
    snap))

;; ============================================================
;; Direct violations
;; ============================================================

(defn- own-writes
  "Rows the step's own operations (not the rules') changed in what each
  rule reads, by an operation on the row's own kind: {:tokens #{} :spans
  #{} :relations #{} :links #{}}."
  [before-step after-ts-exclusive]
  (let [rows (psc/q db {:select [:aw.target_table :aw.target_id :aw.change_type :aw.post_image :o.op_type]
                        :from [[:audit_writes :aw]]
                        :join [[:operations :o] [:= :o.id :aw.op_id]]
                        :where [:and [:> :o.ts after-ts-exclusive]
                                [:not-in :o.op_type ["layer/apply-constraints"]]]})
        own (fn [table ns] (filter #(and (= table (:target_table %))
                                         (str/starts-with? (:op_type %) (str ns "/")))
                                   rows))
        img (fn [r] (some-> (:post_image r) psc/read-json))]
    {:tokens (set (for [r (own "tokens" "token")
                        :let [p (img r) id (str (:target_id r)) was (get-in before-step [:tokens id])]
                        :when (and p (or (= "insert" (:change_type r))
                                         (nil? was) (not= [(:b was) (:e was)] [(:begin p) (:end_ p)])))]
                    id))
     :spans (set (for [r (own "spans" "span")
                       :let [p (img r) id (str (:target_id r))]
                       :when (and p (or (= "insert" (:change_type r))
                                        (and (contains? p :tokens)
                                             (not= (mapv str (:tokens p)) (get-in before-step [:spans id :tokens])))))]
                   id))
     :relations (set (for [r (own "relations" "relation")
                           :let [p (img r) id (str (:target_id r)) was (get-in before-step [:relations id])]
                           :when (and p (or (= "insert" (:change_type r)) (nil? was)
                                            (not= [(:s was) (:t was)] [(str (:source_span_id p)) (str (:target_span_id p))])))]
                       id))
     :links (set (for [r (own "vocab_links" "vocab-link")
                       :let [p (img r) id (str (:target_id r))]
                       :when (and p (or (= "insert" (:change_type r))
                                        (and (contains? p :tokens)
                                             (not= (mapv str (:tokens p)) (get-in before-step [:links id :tokens])))))]
                   id))}))

(def ^:private remediable #{:coextensive :single-span :single-link :same-ancestor})

(def ^:private rows-of {:coextensive :tokens :single-span :spans :single-link :links :same-ancestor :relations})

;; ============================================================
;; The project
;; ============================================================

(defn- id [resp] (-> resp :body :id str))

(defn- call [method path & [body]]
  (api-call admin-request (cond-> {:method method :path path} body (assoc :body body))))

(def ^:private dictionary ["ab" "cd" "efg" "hi" "jkl" "mn" "op"])

(defn- setup! [^SplittableRandom r]
  (let [sentences (vec (for [_ (range (+ 2 (n-of r 2)))]
                         (vec (for [_ (range (+ 2 (n-of r 3)))] (pick r dictionary)))))
        body (str/join " " (map #(str (str/join " " %) ".") sentences))
        proj (create-test-project admin-request "Oracle")
        doc (str (create-test-document admin-request proj "D"))
        tl (id (create-text-layer admin-request proj "T"))
        sl (id (create-token-layer-opts admin-request tl "Sentence" {:overlap-mode "non-overlapping"}))
        wl (id (create-token-layer-opts admin-request tl "Word" {:overlap-mode "non-overlapping"
                                                                 :parent-token-layer-id sl}))
        swl (id (create-token-layer-opts admin-request tl "Syntactic word" {:parent-token-layer-id wl}))
        ml (id (create-token-layer-opts admin-request tl "Morpheme" {:parent-token-layer-id wl}))
        gloss (id (create-span-layer admin-request wl "Gloss"))
        lemma (id (create-span-layer admin-request swl "Lemma"))
        mgloss (id (create-span-layer admin-request ml "Morpheme gloss"))
        deps (id (create-relation-layer admin-request lemma "Deps"))
        enh (id (create-relation-layer admin-request lemma "Enhanced"))
        txt (id (create-text admin-request tl doc body))
        vocab (id (create-vocab-layer admin-request "Lex"))
        _ (link-vocab-to-project admin-request proj vocab)
        items (vec (for [w ["ab" "cd" "x"]] (id (create-vocab-item admin-request vocab w))))
        ;; tokens, sentence by sentence
        cursor (volatile! 0)]
    (doseq [s sentences]
      (let [start @cursor
            words (reduce (fn [acc w] (let [b (+ start (reduce + (map #(inc (count %)) (map first acc))))]
                                        (conj acc [w b (+ b (count w))])))
                          [] s)
            end (inc (last (last words)))]
        (create-token admin-request sl txt start end)
        (let [lemmas (vec (for [[w b e] words]
                            (let [wt (id (create-token admin-request wl txt b e))
                                  sw (id (create-token admin-request swl txt b e))
                                  ms (vec (for [i (range (inc (n-of r 2)))] (id (create-token admin-request ml txt b e i))))]
                              (create-span admin-request gloss [wt] (pick r gloss-values))
                              (doseq [m ms] (create-span admin-request mgloss [m] (str w "-m")))
                              (when (chance r 0.3) (create-vocab-link admin-request (pick r items) [wt]))
                              (when (chance r 0.3) (create-vocab-link admin-request (pick r items) [(first ms)]))
                              (id (create-span admin-request lemma [sw] w)))))]
          ;; the first word heads itself, the others hang from it
          (doseq [[i l] (map-indexed vector lemmas)]
            (create-relation admin-request deps (first lemmas) l (if (zero? i) "root" (pick r (rest deprels))))
            (when (chance r 0.3) (create-relation admin-request enh (first lemmas) l "e")))
          (vreset! cursor (inc end)))))
    (let [cfg {:proj proj :doc doc :txt txt :sl sl :wl wl :swl swl :ml ml :gloss gloss :lemma lemma
               :mgloss mgloss :deps deps :enh enh :items items}
          put (fn [kind layer ns cs]
                (let [resp (call :put (str "/api/v1/" kind "-layers/" layer "/constraints/" ns) {:constraints cs})]
                  (is (= 200 (:status resp)) (pr-str resp))))]
      (put "token" swl "ud" [{:type "coextensive"}])
      (put "token" ml "igt" [{:type "coextensive"} {:type "single-link"}])
      (put "token" wl "igt" [{:type "single-link"}])
      (put "span" gloss "igt" [{:type "single-span"} {:type "value-set" :values gloss-values :delimiters "."}])
      (put "span" lemma "ud" [{:type "single-span"}])
      (put "span" mgloss "igt" [{:type "single-span"}])
      (put "relation" deps "ud" [{:type "max-in-degree" :max 1} {:type "acyclic" :self-loops true}
                                 {:type "same-ancestor" :token-layer sl}
                                 {:type "value-set" :values deprels :delimiters ":" :parts "first"}])
      (put "relation" enh "ud" [{:type "same-ancestor" :token-layer sl}])
      cfg)))

;; ============================================================
;; Steps
;; ============================================================

(defn- of-layer [snap k l] (map key (filter #(= l (:layer (val %))) (get snap k))))

(defn- word-op
  "One write, as a batch entry {:path :method :body}, or nil."
  [r {:keys [gloss lemma mgloss deps enh wl ml swl txt items]} snap]
  (let [words (of-layer snap :tokens wl)
        lemmas (of-layer snap :spans lemma)
        value (fn [] (if (chance r 0.8) (pick r gloss-values) (pick r ["XYZ" "N..V" "" nil "N.V"])))]
    (case (n-of r 12)
      0 (when-let [s (pick r (of-layer snap :spans gloss))]
          {:path (str "/api/v1/spans/" s) :method "PATCH" :body {:value (value)}})
      1 (when-let [t (pick r (concat words (of-layer snap :tokens ml)))]
          (let [layer (if (= wl (get-in snap [:tokens t :layer])) gloss mgloss)]
            {:path "/api/v1/spans" :method "POST"
             :body (cond-> {:span-layer-id layer :tokens [t] :value (value)}
                     (chance r 0.2) (assoc :metadata {"prov" "inferred" "provSource" "m"}))}))
      2 (when-let [s (pick r (concat (of-layer snap :spans gloss) (of-layer snap :spans mgloss)))]
          {:path (str "/api/v1/spans/" s) :method "DELETE"})
      3 (when (seq lemmas)
          {:path "/api/v1/relations" :method "POST"
           :body {:layer-id (pick r [deps deps enh]) :source-id (pick r lemmas) :target-id (pick r lemmas)
                  :value (pick r (conj deprels "nsubj:pass" "bad"))}})
      4 (when-let [rel (pick r (of-layer snap :relations deps))]
          {:path (str "/api/v1/relations/" rel "/target") :method "PUT" :body {:span-id (pick r lemmas)}})
      5 (when-let [rel (pick r (keys (:relations snap)))]
          {:path (str "/api/v1/relations/" rel) :method "DELETE"})
      6 (when-let [t (pick r (concat words (of-layer snap :tokens ml)))]
          {:path "/api/v1/vocab-links" :method "POST"
           :body {:vocab-item (pick r items)
                  :tokens (if (and (chance r 0.2) (= wl (get-in snap [:tokens t :layer])))
                            (vec (distinct [t (pick r words)]))
                            [t])}})
      7 (when-let [l (pick r (keys (:links snap)))]
          {:path (str "/api/v1/vocab-links/" l) :method "DELETE"})
      8 (when-let [w (pick r words)]
          (let [{:keys [b e]} (get-in snap [:tokens w])
                [b e] (if (chance r 0.7) [b e] [b (max b (dec e))])]
            {:path "/api/v1/tokens" :method "POST"
             :body {:token-layer-id (pick r [swl ml]) :text txt :begin b :end e}}))
      9 (when-let [sw (pick r (of-layer snap :tokens swl))]
          (when-not (some #(= [sw] (:tokens (val %))) (filter #(= lemma (:layer (val %))) (:spans snap)))
            {:path "/api/v1/spans" :method "POST" :body {:span-layer-id lemma :tokens [sw] :value "l"}}))
      10 (when-let [s (pick r (of-layer snap :spans mgloss))]
           {:path (str "/api/v1/spans/" s "/metadata") :method "PUT" :body {"prov" "inferred" "provSource" "m"}})
      11 (when-let [s (pick r (of-layer snap :spans gloss))]
           {:path (str "/api/v1/spans/" s "/metadata") :method "PUT" :body {"provConfirmed" true "prov" "inferred"}}))))

(defn- structural-op
  "A write that reshapes tokens, as a batch entry, or nil."
  [r {:keys [sl wl txt]} snap body]
  (let [sentences (sort-by #(get-in snap [:tokens % :b]) (of-layer snap :tokens sl))
        words (sort-by #(get-in snap [:tokens % :b]) (of-layer snap :tokens wl))
        tok (fn [t] (get-in snap [:tokens t]))]
    (case (n-of r 7)
      0 (when-let [s (pick r sentences)]
          (let [{:keys [b e]} (tok s)
                inner (filter #(let [{wb :b} (tok %)] (< b wb e)) words)]
            (when-let [w (pick r inner)]
              {:path (str "/api/v1/tokens/" s "/split") :method "POST" :body {:position (:b (tok w))}})))
      1 (when (> (count sentences) 1)
          (let [i (n-of r (dec (count sentences)))]
            {:path (str "/api/v1/tokens/" (nth sentences i) "/merge") :method "POST"
             :body {:other-token-id (nth sentences (inc i))}}))
      2 (when (> (count words) 1)
          (let [i (n-of r (dec (count words)))]
            {:path (str "/api/v1/tokens/" (nth words i) "/merge") :method "POST"
             :body {:other-token-id (nth words (inc i))}}))
      3 (when-let [w (pick r (filter #(> (- (:e (tok %)) (:b (tok %))) 1) words))]
          (let [{:keys [b e]} (tok w)]
            {:path (str "/api/v1/tokens/" w "/split") :method "POST" :body {:position (+ b 1 (n-of r (- e b 1)))}}))
      4 (when-let [w (pick r (filter #(> (- (:e (tok %)) (:b (tok %))) 1) words))]
          {:path (str "/api/v1/tokens/" w "/shift") :method "POST" :body {:end (dec (:e (tok w)))}})
      (5 6) (let [n (count body)
                  p (n-of r (inc n))
                  new (case (n-of r 3)
                        0 (str (subs body 0 p) (pick r ["a" "z" " " "q"]) (subs body p))
                        1 (if (< p n) (str (subs body 0 p) (subs body (inc p))) body)
                        2 (if (< p n) (str (subs body 0 p) (pick r ["a" " "]) (subs body (inc p))) body))]
              {:path (str "/api/v1/texts/" txt) :method "PATCH" :body {:body new}}))))

(defn- send! [{:keys [path method body]}]
  (call (keyword (str/lower-case method)) path body))

(defn- last-ts [] (or (:ts (psc/q1 db {:select [[[:max :ts] :ts]] :from :operations})) ""))

(defn- body-of [txt] (:body (psc/fetch-by-id db :texts txt)))

;; ============================================================
;; The run
;; ============================================================

(defn- run-seed [seed steps]
  (let [r (SplittableRandom. (long seed))
        cfg (setup! r)
        doc (:doc cfg)
        history (volatile! [(last-ts)])
        stats (volatile! {:refused 0 :accepted 0 :remedied 0})
        fail (fn [what & data] (is false (str "seed " seed ": " what " " (pr-str data))) (reduced :failed))]
    (is (empty? (violations cfg (snapshot doc))) (str "seed " seed ": the fixture breaks a rule"))
    (loop [i 0]
      (when (< i steps)
        (let [before (snapshot doc)
              ts0 (last-ts)
              kind (n-of r 10)
              [what resp]
              (cond
                (< kind 4) (let [op (word-op r cfg before)] [op (when op (send! op))])
                (< kind 7) (let [op (structural-op r cfg before (body-of (:txt cfg)))] [op (when op (send! op))])
                (< kind 9) (let [ops (vec (keep identity (for [_ (range (+ 2 (n-of r 7)))]
                                                           (if (chance r 0.7)
                                                             (word-op r cfg before)
                                                             (structural-op r cfg before (body-of (:txt cfg)))))))]
                             [ops (when (seq ops) (call :post "/api/v1/batch" ops))])
                :else (let [at (pick r @history)]
                        [[:restore at]
                         (when (and (seq at) (hread/exists-at? db doc (java.time.Instant/parse at)))
                           (call :post (str "/api/v1/documents/" doc "/restore?as-of=" at)))]))
              after (snapshot doc)
              status (:status resp)]
          (let [left (violations cfg after)
                result
                (cond
                  (nil? resp) :skip
                  (seq left) (fail "a rule is broken after" what status left)
                  (= 422 status)
                  (do (vswap! stats update :refused inc)
                      (when (not= before after) (fail "a refused step changed rows" what)))
                  (>= status 400) :other-refusal
                  :else
                  (let [ops (psc/q db {:select [:op_type :ts] :from :operations
                                       :where [:> :ts ts0] :order-by [:ts]})
                        own (remove #(= "layer/apply-constraints" (:op_type %)) ops)
                        remedied? (some #(= "layer/apply-constraints" (:op_type %)) ops)
                        pre (if (and remedied? (seq own))
                              (snapshot-at doc (:ts (last own)))
                              after)
                        vs (violations cfg pre)
                        mine (own-writes before ts0)]
                    (vswap! stats update :accepted inc)
                    (when remedied? (vswap! stats update :remedied inc))
                    (vswap! history conj (last-ts))
                    (cond
                      (some #(not (remediable (:type %))) vs)
                      (fail "an unremediable rule was broken and the step accepted" what vs)

                      (some (fn [v] (some #(contains? (get mine (rows-of (:type v))) %) (:ids v))) vs)
                      (fail "a direct violation was remedied, not refused" what vs mine)

                      (not= (data-of (remedy cfg before pre)) (data-of after))
                      (let [[only-model only-stored] (clojure.data/diff (data-of (remedy cfg before pre)) (data-of after))]
                        (fail "the stored state differs from the model of the remedies" what
                              {:violations-before-remedies vs :only-model only-model :only-stored only-stored}))

                      :else :ok)))]
            (when-not (= :failed result)
              (recur (inc i)))))))
    @stats))

(deftest random-steps-keep-every-rule-and-remedy-as-modeled
  (let [n (or (some-> (System/getenv "PLAID_ORACLE_SEEDS") parse-long) 40)
        totals (volatile! {})]
    (doseq [seed (range n)]
      (with-clean-db
        (fn [] (vswap! totals #(merge-with + % (run-seed (+ 1000 seed) 40))))))
    (testing "the steps exercise refusals, acceptances and remedies"
      (is (pos? (:refused @totals 0)) (pr-str @totals))
      (is (pos? (:remedied @totals 0)) (pr-str @totals)))))
