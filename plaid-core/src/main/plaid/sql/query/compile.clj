(ns plaid.sql.query.compile
  "Core compiler: a resolved query AST -> one HoneySQL map. Pure; no DB access.

  Structure: tables go in `:from` as a comma-join and every condition goes in a
  single AND-ed `:where` (SQLite/Postgres plan this identically to explicit INNER
  JOINs, and it keeps the compiler from juggling ON-clause placement).

  Three passes:
    A. scan entity clauses -> per-var constraints (layer-ids, value, doc, begin/end)
    B. for every var (incl. ones introduced only by relationships): allocate a table
       alias, emit its base table, and emit its SCOPE predicate — an `IN <layer-ids>`
       filter for layer-named vars, else a defense-in-depth join to the var's layer
       table filtered by `project_id IN scope`. THE ACL INVARIANT: no entity alias is
       emitted without a scope predicate (asserted at the end; a miss is a 500).
    C. relationship clauses + inline relation source/target -> join predicates.

  Token precedence is the canonical total order on `(begin, precedence, end, id)`,
  with `precedence` sorting NULLS LAST (precedence outranks extent). `:precedes*` is
  a row-value `<` on that key; `:precedes` binds the right token to the left's
  immediate successor via a correlated `ORDER BY … LIMIT 1` subquery — ~30× faster
  than a `NOT EXISTS`-between guard and correct for the composite key. The `end`/`id`
  tail makes the order total, so adjacency is well-defined even among tokens that
  share a begin offset."
  (:require [clojure.set :as set]
            [clojure.string :as str]
            [plaid.query.ast :as ast]
            [plaid.sql.common :as psc]
            [plaid.sql.query.resolve :as qr]))

(def ^:private entity-table
  {:span :spans :token :tokens :relation :relations :vocab :vocab_items
   :document :documents :text :texts})

(def ^:private alias-prefix
  {:span "s" :token "t" :relation "r" :vocab "v" :document "d" :text "tx"})

(def ^:private layer-fk
  {:span :span_layer_id :token :token_layer_id :relation :relation_layer_id :vocab :vocab_layer_id})

(def ^:private layer-tbl
  {:span :span_layers :token :token_layers :relation :relation_layers})

;; Layer variables: a var in an entity's :layer position is a node of a LAYER
;; kind, joined to the entity's `*_layer_id`. (Same-layer joins + projection.)
(def ^:private layer-entity-table
  {:text-layer :text_layers :span-layer :span_layers :token-layer :token_layers
   :relation-layer :relation_layers :vocab-layer :vocab_layers})

(def ^:private layer-alias-prefix
  {:text-layer "txlv" :span-layer "slv" :token-layer "tlv" :relation-layer "rlv" :vocab-layer "vlv"})

;; A layer clause's structural slot -> the FK column on the host layer table that
;; points at the referenced parent layer. Keyed by [layer-kind slot]; the kind IS
;; the clause head (a layer var's kind equals the clause that binds it).
(def ^:private layer-slot-fk
  {[:token-layer :text-layer]         :text_layer_id
   [:token-layer :parent-token-layer] :parent_token_layer_id
   [:span-layer :token-layer]         :token_layer_id
   [:relation-layer :span-layer]      :span_layer_id})

(defn- layer-kind? [k] (contains? layer-entity-table k))

(defn- err-500! [msg data]
  (throw (ex-info msg (merge {:code 500 :query-error/stage :compile} data))))

;; ---------------------------------------------------------------------------
;; Mutable-ish compile state (a local atom; contained within compile-query)
;; ---------------------------------------------------------------------------

(defn- new-state [scope kinds]
  (atom {:n 0
         :scope (vec scope)
         :kinds kinds
         :var->alias {}
         :scalar-col {}   ; scalar var -> {:sql <col-ref> :enc <fn>}: its bound column
         :from []
         :where []
         :scoped #{}}))   ; entity vars that have received a scope predicate

(defn- next-alias! [st prefix]
  (let [n (:n (swap! st update :n inc))]
    (keyword (str prefix "_" n))))

(defn- col
  "Qualified column keyword: (col :s_1 :value) => :s_1.value"
  [alias c]
  (keyword (str (name alias) "." (name c))))

(defn- add-from! [st entry] (swap! st update :from conj entry))
(defn- add-where! [st pred] (when pred (swap! st update :where conj pred)))

;; ---------------------------------------------------------------------------
;; Pass A: collect per-var entity constraints
;; ---------------------------------------------------------------------------

(defn- collect-entity-constraints
  "Map of var -> VECTOR of the constraint maps from each entity clause at THIS
  clause level. It does NOT descend into `:not` groups: a negated clause's
  constraints belong inside its own NOT EXISTS subquery (built by `compile-not!`
  from the body's own constraints), never ANDed onto the outer alias. Folding a
  `:not` body's constraint onto the outer var would both corrupt the outer
  predicate and lose the negation — e.g. `[:token ?t {:value NOUN}]` plus
  `[:not [:token ?t {:begin 0}]]` would wrongly become `value=NOUN AND begin=0`.
  Two entity clauses naming the same var at one level still AND (same-layer join):
  `value NOUN` AND `value VERB` must be unsatisfiable, not last-wins."
  [clauses]
  (reduce
   (fn [acc clause]
     (let [[head v cmap] clause]
       (cond
         (contains? entity-table head) (update acc v (fnil conj []) (or cmap {}))
         (contains? layer-entity-table head) (update acc v (fnil conj []) (or cmap {}))
         :else acc)))
   {} clauses))

;; ---------------------------------------------------------------------------
;; Pass B: ensure every var has a table + scope predicate + filters
;; ---------------------------------------------------------------------------

(defn- atomic-pred
  "`= literal` for a scalar value, `IN (…)` for a vector (value alternation).
  `enc` encodes each literal to its stored form."
  [col v enc]
  (if (vector? v)
    [:in col (mapv enc v)]
    [:= col (enc v)]))

(defn- regex-pred
  "Portable case-(in)sensitive regex match of `col` against `pattern`.
  *** Dialect seam *** — the ONE place a regex predicate is emitted:
    SQLite:   REGEXP(pattern, col) — a UDF registered per query connection in
              exec.clj (Java Pattern under the hood). Case-insensitivity is an
              inline `(?i)` on the pattern.
    Postgres: would be `col ~ pattern` / `col ~* pattern` — change THIS fn only."
  [col pattern case-insensitive?]
  ;; HoneySQL renders :regexp as the infix `col REGEXP pattern`, which SQLite
  ;; maps to `regexp(pattern, col)` — exactly our UDF's (pattern, value) arg order.
  [:regexp col (if case-insensitive? (str "(?i)" pattern) pattern)])

(defn- value-pred
  "The predicate for one text-match spec: a regex spec `{:regex .. :flags}` ->
  REGEXP against `regex-col`; a vector -> IN; a scalar -> `=` (against `col`, with
  literals `enc`oded). `regex-col` may differ from `col` so a regex can run on the
  decoded text (e.g. JSON-extracted value) while equality compares the stored form."
  [col v enc regex-col]
  (if (and (map? v) (contains? v :regex))
    (regex-pred regex-col (:regex v) (boolean (some-> (:flags v) (str/includes? "i"))))
    (atomic-pred col v enc)))

(defn- emit-match! [st col v enc regex-col]
  (add-where! st (value-pred col v enc regex-col)))

;; --- entity metadata (entity_metadata wide-narrow table) -------------------
;; A QL kind -> the entity_type string the metadata table keys on. Metadata
;; values are stored JSON-encoded (write-json), like :value.
(def ^:private kind->meta-type
  {:span "span" :token "token" :relation "relation"
   :document "document" :text "text" :vocab "vocab-item"})

(defn- metadata-exists-pred
  "EXISTS a entity_metadata row for (kind, `a`.id, `mk`) whose value matches
  `spec`. Correlates to the already-scoped entity `a`, and rides the table's
  PRIMARY KEY (entity_type, entity_id, key), so it's an indexed lookup."
  [st kind a mk spec]
  (let [em (next-alias! st "em")
        et (or (kind->meta-type kind)
               (err-500! (str "kind " kind " has no metadata entity-type") {:kind kind}))]
    [:exists {:select [1]
              :from [[:entity_metadata em]]
              :where [:and
                      [:= (col em :entity_type) et]
                      [:= (col em :entity_id) (col a :id)]
                      [:= (col em :key) mk]
                      (value-pred (col em :value) spec psc/write-json
                                  [:json_extract (col em :value) [:inline "$"]])]}]))

(defn- bind-scalar!
  "Bind scalar var `v` to column `col-ref` (with literal-encoder `enc`; `json?`
  marks a JSON-encoded column so aggregation can decode it). The first binding
  records the column; a later binding of the SAME var emits a column-equality
  join — that is how `{:value {:var ?x}}` on two clauses means \"same value\".
  (Inside a `:not`, sub-st inherits the outer :scalar-col, so a re-use there joins
  to the outer column as a correlated predicate.)"
  [st v col-ref enc json?]
  (if-let [bound (get-in @st [:scalar-col v])]
    ;; join the two columns by VALUE. A JSON-encoded column (:value on span/relation)
    ;; stores the text "cat" (with quotes); a plain column (:form/:name/:body/:doc/
    ;; begin/end) stores cat. Decode whichever side is JSON-encoded before comparing —
    ;; mirroring resolve-term — else a value<->form join is `"cat" = cat` and silently
    ;; never matches. (value<->value: both decode, still equal.)
    (let [decode (fn [sql j?] (if j? [:json_extract sql [:inline "$"]] sql))]
      (add-where! st [:= (decode (:sql bound) (:json? bound)) (decode col-ref json?)]))
    (swap! st assoc-in [:scalar-col v] {:sql col-ref :enc enc :json? json?})))

(defn- emit-field!
  "One scalar-key constraint: a `{:var ?v}` value BINDS a scalar var (join);
  otherwise it filters via `emit-match!` (= / IN / regex). `regex-col` is the
  expression a regex runs against (may differ from `col`, e.g. the decoded value);
  `json?` marks `col` as JSON-encoded (for a bound scalar's later aggregation)."
  [st col v enc regex-col json?]
  (if (and (map? v) (contains? v :var))
    (bind-scalar! st (:var v) col enc json?)
    (emit-match! st col v enc regex-col)))

;; --- token surface form (the domain's :token/value) -----------------------
;; A token carries only offsets; its surface is the substring of its text body.
;; There is no `value` column, so slice it: join the token's text (once, cached by
;; alias) and `substr(body, begin+1, end-begin)` (SQLite substr is 1-based, len arg).
(defn- token-text-alias!
  [st a]
  (or (get-in @st [:token-text a])
      (let [tx (next-alias! st "txt")]
        (add-from! st [:texts tx])
        (add-where! st [:= (col a :text_id) (col tx :id)])
        (swap! st assoc-in [:token-text a] tx)
        tx)))

(defn- token-surface-sql
  [st a]
  (let [tx (token-text-alias! st a)]
    [:substr (col tx :body) [:+ (col a :begin) [:inline 1]] [:- (col a :end_) (col a :begin)]]))

(defn- emit-entity-filters!
  "Emit the value/form/doc/begin/end/name/body/id/metadata predicates from one
  entity constraint map (`kind` is the host entity's kind, for metadata's
  entity_type). Kept separate from `ensure-var!` (which only allocates the table +
  scope predicate, idempotently) so these filters can be emitted in the RIGHT
  query scope: a constraint that re-states an outer var inside a `:not` must land
  inside that NOT EXISTS subquery as a correlated predicate, not on the outer alias."
  [st kind a cmap]
  ;; :value — for span/relation it is the JSON-encoded annotation (regex matches the
  ;; DECODED scalar); for a TOKEN it is the SURFACE substring (plain text, sliced
  ;; from the text body), so match/regex run on the substr expression directly.
  (when (contains? cmap :value)
    (if (= kind :token)
      (let [surf (token-surface-sql st a)]
        (emit-field! st surf (:value cmap) identity surf false))
      (emit-field! st (col a :value) (:value cmap) psc/write-json
                   [:json_extract (col a :value) [:inline "$"]] true)))
  ;; :form (vocab_items.form) is plain TEXT — regex runs on the column directly.
  (when (contains? cmap :form)
    (emit-field! st (col a :form) (:form cmap) identity (col a :form) false))
  (when (contains? cmap :doc)   (emit-field! st (col a :document_id) (:doc cmap) str (col a :document_id) false))
  (when (contains? cmap :begin) (emit-field! st (col a :begin) (:begin cmap) identity (col a :begin) false))
  (when (contains? cmap :end)   (emit-field! st (col a :end_) (:end cmap) identity (col a :end_) false))
  ;; document name / text body (plain TEXT — regex runs on the column directly), id
  (when (contains? cmap :name)  (emit-field! st (col a :name) (:name cmap) identity (col a :name) false))
  (when (contains? cmap :body)  (emit-field! st (col a :body) (:body cmap) identity (col a :body) false))
  (when (contains? cmap :id)    (emit-field! st (col a :id) (:id cmap) str (col a :id) false))
  ;; metadata: one correlated EXISTS per key (indexed on the PK)
  (when (contains? cmap :metadata)
    (doseq [[mk spec] (:metadata cmap)]
      (add-where! st (metadata-exists-pred st kind a mk spec)))))

(declare ensure-var!)

(defn- ensure-layer-var!
  "Allocate a layer-table alias for a LAYER variable `v` of `kind` and emit its
  SCOPE predicate (project_id IN scope; vocab layers are global -> via
  project_vocabs grants), registering it in :scoped. Its FILTERS — `:name`/`:alias`
  and the structural-slot joins — are emitted SEPARATELY, per clause, by
  `emit-layer-filters!` (like `emit-entity-filters!` for entity clauses), so a layer
  var re-stated inside a `:not` gets its predicates INSIDE that NOT EXISTS subquery
  rather than dropped on the outer alias. Because a layer name is not unique across
  projects, an unconstrained-by-id layer var ranges over EVERY matching layer in
  scope — the sanctioned intentional multi-layer match."
  [st v kind]
  (let [a (next-alias! st (layer-alias-prefix kind))]
    (swap! st assoc-in [:var->alias v] a)
    (add-from! st [(layer-entity-table kind) a])
    (if (= kind :vocab-layer)
      (let [pv (next-alias! st "pv")]
        (add-from! st [:project_vocabs pv])
        (add-where! st [:= (col a :id) (col pv :vocab_layer_id)])
        (add-where! st [:in (col pv :project_id) (:scope @st)]))
      (add-where! st [:in (col a :project_id) (:scope @st)]))
    (swap! st update :scoped conj v)))

(defn- ensure-var!
  "Allocate (once) a table alias for var v, emit its base table, scope predicate,
  and the value/doc/begin/end filters from ALL its entity constraint maps (ANDed).
  `constraints` maps var -> vector of constraint maps. Idempotent. A LAYER var is
  handled by `ensure-layer-var!`; an entity var whose `:layer` is itself a var is
  scoped by joining to that (scoped) layer node — the named version of the
  defense-in-depth join."
  [st v constraints]
  (let [kind (get-in @st [:kinds v])]
    (when (nil? kind)
      (err-500! (str "No inferred kind for var " v) {:var v}))
    ;; scalar vars are NOT tables — they bind a column of their host entity
    ;; clause (emit-entity-filters! does the binding/join). Skip allocation.
    (when (and (not= :scalar kind) (not (get-in @st [:var->alias v])))
      (if (layer-kind? kind)
        (ensure-layer-var! st v kind)
        (let [a (next-alias! st (alias-prefix kind))]
          (swap! st assoc-in [:var->alias v] a)
          (add-from! st [(entity-table kind) a])
          ;; --- scope predicate (THE ACL invariant) ---
          (let [cmaps (get constraints v)                 ; vector of constraint maps (may be nil)
                layer-id-sets (keep ::qr/layer-ids cmaps)  ; one per layer-named clause
                layer-var (some #(let [l (:layer %)] (when (symbol? l) l)) cmaps)]
            ;; a layer-named clause pins scope AND filters the layer; emit one IN per
            ;; such clause UNCONDITIONALLY, so a literal layer still applies even when
            ;; the same var ALSO names a layer variable (the two are not exclusive —
            ;; the cond below would otherwise drop the literal under the layer-var arm).
            (doseq [ids layer-id-sets]
              (add-where! st [:in (col a (layer-fk kind)) (vec ids)]))
            (cond
              ;; :layer is a VARIABLE -> also join to the (scoped) layer node it names
              layer-var
              (add-where! st [:= (col a (layer-fk kind)) (col (ensure-var! st layer-var constraints) :id)])
              ;; a layer-named clause already pinned scope via the IN(s) above
              (seq layer-id-sets) nil
              ;; vocab layers are global — scope via project_vocabs grants
              (= kind :vocab)
              (let [pv (next-alias! st "pv")]
                (add-from! st [:project_vocabs pv])
                (add-where! st [:= (col a :vocab_layer_id) (col pv :vocab_layer_id)])
                (add-where! st [:in (col pv :project_id) (:scope @st)]))
              ;; a document carries project_id directly
              (= kind :document)
              (add-where! st [:in (col a :project_id) (:scope @st)])
              ;; a text is scoped through its document
              (= kind :text)
              (let [d (next-alias! st "txd")]
                (add-from! st [:documents d])
                (add-where! st [:= (col a :document_id) (col d :id)])
                (add-where! st [:in (col d :project_id) (:scope @st)]))
              ;; defense-in-depth: join the var's layer table, filter project_id IN scope
              :else
              (let [lt-table (or (layer-tbl kind)
                                 (err-500! (str "No layer table registered for kind " kind
                                                " — keep entity-table/alias-prefix/layer-fk/layer-tbl in sync")
                                           {:kind kind}))
                    lt (next-alias! st "lt")]
                (add-from! st [lt-table lt])
                (add-where! st [:= (col a (layer-fk kind)) (col lt :id)])
                (add-where! st [:in (col lt :project_id) (:scope @st)])))
            ;; Attribute filters (value/form/doc/begin/end) are NOT emitted here —
            ;; `compile-query` Pass B and `compile-not!` emit them per-clause via
            ;; `emit-entity-filters!` so a re-stated outer var inside a `:not`
            ;; gets its predicate in the subquery, not on the outer alias.
            (swap! st update :scoped conj v)))))
    (get-in @st [:var->alias v])))

(defn- emit-layer-filters!
  "Emit one layer clause's `:name`/`:alias` filters and structural-slot joins
  against the layer var's alias `a` (`kind` = the clause head). Separated from
  `ensure-layer-var!` (which only allocates the table + scope) so a correlated layer
  var re-stated inside a `:not` gets these predicates INSIDE the NOT EXISTS subquery
  — mirroring `emit-entity-filters!`. A var-valued structural slot joins to the
  (already-ensured, scoped) parent layer node; a scalar slot filters the FK to the
  in-scope id(s) resolve attached."
  [st a kind cs constraints]
  (when (contains? cs :name)
    (add-where! st (atomic-pred (col a :name) (:name cs) identity)))
  ;; :alias lives in config JSON under the reserved "plaid"/"alias" pair
  (when (contains? cs :alias)
    (add-where! st (atomic-pred [:json_extract (col a :config) [:inline "$.plaid.alias"]]
                                (:alias cs) identity)))
  ;; structural slots: join this layer's FK to its referenced parent layer
  (doseq [[slot _parent-kind] (ast/layer-slots-for kind)
          :when (contains? cs slot)]
    (let [fk (layer-slot-fk [kind slot])
          ref (get cs slot)]
      (if (symbol? ref)
        (add-where! st [:= (col a fk) (col (ensure-var! st ref constraints) :id)])
        (add-where! st [:in (col a fk) (vec (get-in cs [::qr/slot-layer-ids slot]))])))))

;; ---------------------------------------------------------------------------
;; Pass C: relationship predicates
;; ---------------------------------------------------------------------------

(defn- token-key
  "Row-value for the canonical token order `(begin, precedence, end, id)` with
  precedence NULLS LAST. The NULLS-LAST rank is encoded as a leading null-flag
  column (0 = present, 1 = NULL) so the whole tuple is non-NULL and SQL row-value
  comparison is well-defined; the `end`/`id` tail makes the order total.

  LOCKSTEP: `successor-subquery`'s ORDER BY expresses this SAME order with native
  `:asc-nulls-last`. The two encodings (this null-flag composite for the `>`
  filter, that ORDER BY for the `LIMIT 1` pick) must stay equivalent or
  `:precedes` selects the wrong successor — change them together."
  [a]
  [:composite
   (col a :begin)
   [:case [:is (col a :precedence) nil] 1 :else 0]
   [:coalesce (col a :precedence) 0]
   (col a :end_)
   (col a :id)])

(defn- precedes*-pred
  "Row-value `<` on (begin, precedence) within the same text+layer: t1 is
  strictly earlier than t2 in canonical token order."
  [t1 t2]
  [:and
   [:= (col t1 :text_id) (col t2 :text_id)]
   [:= (col t1 :token_layer_id) (col t2 :token_layer_id)]
   [:< (token-key t1) (token-key t2)]])

(defn- within-pred
  "Offset containment: `child`'s extent sits inside `parent`'s, same text, and
  they are distinct tokens. This is the token-hierarchy relation (derived purely
  from offsets). Containment is non-strict on the offsets so an equal-extent
  child (e.g. a full-width morpheme) still counts as within its parent; the
  `id <> id` guard keeps a token from being `within` (or `first-in`) itself when
  child and parent resolve to the same layer."
  [child parent]
  [:and
   [:<> (col child :id) (col parent :id)]
   [:= (col child :text_id) (col parent :text_id)]
   [:<= (col parent :begin) (col child :begin)]
   [:<= (col child :end_) (col parent :end_)]])

(defn- successor-subquery
  "Correlated subquery returning the id of the token immediately after `t1` in
  (begin, precedence) order within the same text+layer."
  [st t1]
  (let [pt (next-alias! st "pt")]
    {:select [(col pt :id)]
     :from [[:tokens pt]]
     :where [:and
             [:= (col pt :text_id) (col t1 :text_id)]
             [:= (col pt :token_layer_id) (col t1 :token_layer_id)]
             [:> (token-key pt) (token-key t1)]]
     :order-by [[(col pt :begin) :asc]
                [(col pt :precedence) :asc-nulls-last]
                [(col pt :end_) :asc]
                [(col pt :id) :asc]]
     :limit 1}))

(defn- first-in-subquery
  "Correlated EXISTS body: a token of `t`'s own layer that is also within
  `container` and strictly precedes `t`. `:first-in` asserts NOT EXISTS of this."
  [st t container]
  (let [fi (next-alias! st "fi")]
    {:select [1]
     :from [[:tokens fi]]
     :where [:and
             [:= (col fi :token_layer_id) (col t :token_layer_id)]
             (within-pred fi container)
             (precedes*-pred fi t)]}))

;; --- span↔span topology (token-set semantics) -----------------------------
;; A span is the SET of tokens it covers (possibly discontinuous). So:
;;   overlaps     A,B share a covered token
;;   contains     every token B covers is also covered by A (B ⊆ A)
;;   coextensive  A and B cover exactly the same tokens (A ⊆ B and B ⊆ A)
;; All carry an id<>id guard (like `within`) so a span isn't trivially related to
;; itself. The span_tokens helper aliases correlate to already-scoped span ids,
;; so they need no scope predicate of their own.

(defn- span-overlap-pred
  "EXISTS a token covered by both spans `a-id` and `b-id`."
  [st a-id b-id]
  (let [sta (next-alias! st "sta")
        stb (next-alias! st "stb")]
    [:exists {:select [1]
              :from [[:span_tokens sta] [:span_tokens stb]]
              :where [:and
                      [:= (col sta :span_id) a-id]
                      [:= (col stb :span_id) b-id]
                      [:= (col sta :token_id) (col stb :token_id)]]}]))

(defn- span-superset-pred
  "`super-id` covers every token `sub-id` covers (super ⊇ sub): NOT EXISTS a token
  of `sub` that `super` does not also cover."
  [st super-id sub-id]
  (let [sub (next-alias! st "stsub")
        sup (next-alias! st "stsup")]
    [:not [:exists {:select [1]
                    :from [[:span_tokens sub]]
                    :where [:and
                            [:= (col sub :span_id) sub-id]
                            [:not [:exists {:select [1]
                                            :from [[:span_tokens sup]]
                                            :where [:and
                                                    [:= (col sup :span_id) super-id]
                                                    [:= (col sup :token_id) (col sub :token_id)]]}]]]}]]))

(defn- compile-rel!
  [st constraints clause]
  (let [[head a b] clause
        av #(ensure-var! st % constraints)]
    (case head
      :covers   (let [s (av a) t (av b)
                      stj (next-alias! st "st")]
                  (add-from! st [:span_tokens stj])
                  (add-where! st [:= (col stj :span_id) (col s :id)])
                  (add-where! st [:= (col stj :token_id) (col t :id)]))
      :precedes  (let [t1 (av a) t2 (av b)]
                   (add-where! st [:= (col t2 :id) (successor-subquery st t1)]))
      :precedes* (let [t1 (av a) t2 (av b)]
                   (add-where! st (precedes*-pred t1 t2)))
      :within    (let [c (av a) p (av b)]
                   (add-where! st (within-pred c p)))
      :first-in  (let [t (av a) cont (av b)]
                   (add-where! st (within-pred t cont))
                   (add-where! st [:not [:exists (first-in-subquery st t cont)]]))
      :overlaps    (let [sa (av a) sb (av b)]
                     (add-where! st [:<> (col sa :id) (col sb :id)])
                     (add-where! st (span-overlap-pred st (col sa :id) (col sb :id))))
      :contains    (let [sa (av a) sb (av b)]
                     (add-where! st [:<> (col sa :id) (col sb :id)])
                     (add-where! st (span-superset-pred st (col sa :id) (col sb :id))))
      :coextensive (let [sa (av a) sb (av b)]
                     (add-where! st [:<> (col sa :id) (col sb :id)])
                     (add-where! st (span-superset-pred st (col sa :id) (col sb :id)))
                     (add-where! st (span-superset-pred st (col sb :id) (col sa :id))))
      :related*    (let [sa (av a) sb (av b)
                         cmap (nth clause 3)
                         layer-ids (vec (::qr/layer-ids cmap))
                         r0 (next-alias! st "rc0")
                         r1 (next-alias! st "rc1")
                         ;; per-hop relation filter: in the (scoped) layer set, and
                         ;; the optional :value. Correlates scope via layer-ids.
                         hop (fn [r]
                               (let [s (next-alias! st "rcs")
                                     sl (next-alias! st "rcsl")]
                                 (cond-> [:and [:in (col r :relation_layer_id) layer-ids]
                                          ;; defense-in-depth: the span this hop reaches must
                                          ;; itself live in a span layer within scope, so
                                          ;; reachability can't cross into an unreadable project
                                          ;; even if a relation's endpoints ever did. (Today the
                                          ;; relation write-path forbids that, so this is belt &
                                          ;; braces — but it makes :related* self-sufficient.)
                                          [:exists {:select [1]
                                                    :from [[:spans s] [:span_layers sl]]
                                                    :where [:and [:= (col s :id) (col r :target_span_id)]
                                                            [:= (col sl :id) (col s :span_layer_id)]
                                                            [:in (col sl :project_id) (:scope @st)]]}]]
                                   (contains? cmap :value)
                                   (conj (atomic-pred (col r :value) (:value cmap) psc/write-json)))))]
                     ;; transitive reachability over source_span_id -> target_span_id,
                     ;; via a correlated recursive CTE inside EXISTS (>=1 hop).
                     (add-where! st
                                 [:exists
                                  {:with-recursive
                                   [[[:reach {:columns [:rid]}]
                                     {:union
                                      [{:select [(col r0 :target_span_id)]
                                        :from [[:relations r0]]
                                        :where (conj (hop r0) [:= (col r0 :source_span_id) (col sa :id)])}
                                       {:select [(col r1 :target_span_id)]
                                        :from [[:relations r1] :reach]
                                        :where (conj (hop r1) [:= (col r1 :source_span_id) :reach.rid])}]}]]
                                   :select [1] :from [:reach] :where [:= :reach.rid (col sb :id)]}]))
      :source   (let [r (av a) s (av b)]
                  (add-where! st [:= (col r :source_span_id) (col s :id)]))
      :target   (let [r (av a) s (av b)]
                  (add-where! st [:= (col r :target_span_id) (col s :id)]))
      :vocab-link (let [t (av a) v (av b)
                        vl (next-alias! st "vl")
                        vlt (next-alias! st "vlt")]
                    (add-from! st [:vocab_links vl])
                    (add-from! st [:vocab_link_tokens vlt])
                    (add-where! st [:= (col vlt :token_id) (col t :id)])
                    (add-where! st [:= (col vlt :vocab_link_id) (col vl :id)])
                    (add-where! st [:= (col vl :vocab_item_id) (col v :id)]))
      (err-500! (str "Compiler reached unknown relationship clause :" (name head)) {:clause clause}))))

(defn- compile-relation-inline!
  "A :relation entity clause may carry inline :source/:target span vars — compile
  them as relationship predicates."
  [st constraints clause]
  (let [[head r cmap] clause]
    (when (= head :relation)
      (let [ra (ensure-var! st r constraints)]
        (when-let [s (:source cmap)]
          (add-where! st [:= (col ra :source_span_id) (col (ensure-var! st s constraints) :id)]))
        (when-let [t (:target cmap)]
          (add-where! st [:= (col ra :target_span_id) (col (ensure-var! st t constraints) :id)]))))))

(defn- compile-not!
  "Compile a `[:not & inner-clauses]` clause to a correlated `NOT EXISTS`. A var
  already bound in the outer query is CORRELATED (the subquery references its
  outer alias); a var appearing ONLY inside the :not is existential and gets a
  fresh alias + scope predicate INSIDE the subquery. The subquery is built in a
  sub-state that shares the outer var->alias / kinds / scope / alias-counter but
  has its own :from/:where."
  [outer-st constraints clause]
  (let [inner (rest clause)
        ;; the :not body's OWN constraints (used to scope inner-only vars). Outer
        ;; vars re-stated inside the body are correlated, so their predicates are
        ;; emitted against the outer alias INSIDE this subquery (see below).
        inner-cons (collect-entity-constraints inner)
        sub-st (atom (assoc @outer-st :from [] :where [] :scoped #{}))]
    ;; existential (inner-only) vars get a table + scope here; correlated (outer)
    ;; vars are already in var->alias, so ensure-var! no-ops for them. (A nested
    ;; :not's own vars are handled by its recursive compile-not! call, not here.)
    (doseq [v (distinct (mapcat ast/clause-vars inner))]
      (ensure-var! sub-st v inner-cons))
    (doseq [c inner]
      (cond
        (= :not (first c)) (compile-not! sub-st constraints c)   ; nested NOT EXISTS
        ;; layer clauses: the pre-loop ensure-var! allocated + scoped the var; emit
        ;; its name/alias/structural filters INSIDE the subquery so a CORRELATED outer
        ;; layer var's predicates are negated here, not silently dropped.
        (contains? layer-entity-table (first c))
        (let [[head v cmap] c]
          (emit-layer-filters! sub-st (get-in @sub-st [:var->alias v]) head (or cmap {}) inner-cons))
        (contains? entity-table (first c))
        (let [[_ v cmap] c]
          ;; emit this clause's attribute filters INSIDE the subquery — for a
          ;; correlated outer var this is the negated predicate's correct home.
          (emit-entity-filters! sub-st (first c) (get-in @sub-st [:var->alias v]) (or cmap {}))
          (compile-relation-inline! sub-st inner-cons c))
        :else (compile-rel! sub-st constraints c)))
    (let [subq (cond-> {:select [1] :where (into [:and] (:where @sub-st))}
                 (seq (:from @sub-st)) (assoc :from (:from @sub-st)))]
      (add-where! outer-st [:not [:exists subq]]))
    ;; advance the outer alias counter past the subquery's, and record the inner
    ;; vars (scoped in the subquery) as scoped so the ACL assert is satisfied.
    (swap! outer-st assoc :n (:n @sub-st))
    (swap! outer-st update :scoped into (:scoped @sub-st))))

;; ---------------------------------------------------------------------------
;; Predicate clauses: [op a b] over already-bound terms
;; ---------------------------------------------------------------------------

(def ^:private pred-honeysql-op
  {:=  :=
   :!= :<>
   :<  :<
   :>  :>
   :<= :<=
   :>= :>=})

;; --- field references (dot paths): ?t.begin / ?s.metadata.k / ?sl.config.k ----
;; attr keyword -> {:column kw :enc fn :json? bool}. The column lives on the
;; entity/layer alias; :value is stored JSON-encoded so it is DECODED for
;; comparison (json? true); doc/id are opaque id strings (enc str).
(def ^:private attr->col
  {:begin      {:column :begin       :enc identity :json? false}
   :end        {:column :end_        :enc identity :json? false}
   :precedence {:column :precedence  :enc identity :json? false}
   :value      {:column :value       :enc identity :json? true}
   :form       {:column :form        :enc identity :json? false}
   :name       {:column :name        :enc identity :json? false}
   :body       {:column :body        :enc identity :json? false}
   :doc        {:column :document_id :enc str      :json? false}
   :id         {:column :id          :enc str      :json? false}})

(defn- json-path
  "A SQLite `$`-path string from verbatim (case-sensitive) key segments. Used as a
  BOUND parameter to json_extract (never inlined), so user keys can't inject SQL."
  [segs]
  (str "$" (apply str (map #(str "." %) segs))))

(defn- field-expr
  "Resolve a field-ref term to {:sql expr :enc enc}. `ast/field-resolve` interprets
  the path against the host var's kind; this builds the column / decoded column /
  config json_extract / correlated metadata scalar-subquery on the var's alias."
  [st fr]
  (let [v    (ast/field-var fr)
        kind (get-in @st [:kinds v])
        a    (or (get-in @st [:var->alias v])
                 (err-500! (str "Field path " (ast/field->str fr) " head var was never bound") {:var v}))
        res  (ast/field-resolve kind (ast/field-path fr))]
    (when (:error res)
      (err-500! (str "Field path " (ast/field->str fr) " reached the compiler unvalidated: " (:error res)) {:fr fr}))
    (case (:type res)
      (:core :layer-attr)
      (cond
        (= (:attr res) :alias)
        {:sql [:json_extract (col a :config) [:inline "$.plaid.alias"]] :enc identity}
        ;; a token's :value is the surface substring (no column), not a JSON annotation
        (and (= kind :token) (= (:attr res) :value))
        {:sql (token-surface-sql st a) :enc identity}
        :else
        (let [{:keys [column enc json?]} (attr->col (:attr res))]
          {:sql (if json? [:json_extract (col a column) [:inline "$"]] (col a column)) :enc enc}))
      :config
      {:sql [:json_extract (col a :config) (json-path (:subpath res))] :enc identity}
      :metadata
      (let [em (next-alias! st "emf")
            et (or (kind->meta-type kind) (err-500! (str "kind " kind " has no metadata entity-type") {:kind kind}))]
        {:sql {:select [[[:json_extract (col em :value) (json-path (:subpath res))] :v]]
               :from   [[:entity_metadata em]]
               :where  [:and
                        [:= (col em :entity_type) et]
                        [:= (col em :entity_id) (col a :id)]
                        [:= (col em :key) (:key res)]]
               :limit  1}
         :enc identity}))))

(defn- resolve-term
  "Resolve a predicate term to {:sql expr :enc enc} (a field path -> its column/
  subquery, a bound var: entity -> its .id, scalar -> its bound column) or
  {:lit v} (a literal)."
  [st t]
  (cond
    (ast/field-ref? t) (field-expr st t)
    (ast/var? t)
    (let [kind (get-in @st [:kinds t])]
      (if (= :scalar kind)
        (let [{:keys [sql enc json?]} (or (get-in @st [:scalar-col t])
                                          (err-500! (str "Scalar var " t " used in a predicate was never bound") {:var t}))]
          ;; a JSON-encoded scalar (:value) is DECODED for comparison, so e.g.
          ;; `[< ?v 5]` is a numeric compare, not a lexical one on quoted JSON;
          ;; the other-side literal is then taken raw (enc identity).
          (if json?
            {:sql [:json_extract sql [:inline "$"]] :enc identity}
            {:sql sql :enc enc}))
        {:sql (col (or (get-in @st [:var->alias t])
                       (err-500! (str "Entity var " t " in a predicate was never bound") {:var t}))
                   :id)
         :enc str}))
    :else {:lit t}))

(defn- compile-pred!
  "Compile `[op a b]` to a WHERE comparison. A literal is encoded with the OTHER
  term's encoder, so a literal compared to a JSON-encoded :value column is itself
  JSON-encoded; comparing two entity vars compares their ids."
  [st clause]
  (let [[op a b] clause
        ta (resolve-term st a)
        tb (resolve-term st b)
        side (fn [t other] (if (contains? t :lit) ((or (:enc other) identity) (:lit t)) (:sql t)))]
    (add-where! st [(pred-honeysql-op op) (side ta tb) (side tb ta)])))

;; ---------------------------------------------------------------------------
;; Assemble
;; ---------------------------------------------------------------------------

(defn- find-select [st find-vars]
  (mapv (fn [v]
          (let [a (get-in @st [:var->alias v])]
            (when (nil? a) (err-500! (str "Find var " v " was never bound to a table") {:var v}))
            [(col a :id) (keyword (subs (name v) 1))]))
        find-vars))

;; ORDER BY: an :order-by attribute -> the column it sorts on (ast validated the
;; attribute is legal for the var's kind). The sort column is projected as a
;; hidden `__ord_N` so it survives the UNION; exec applies the ORDER BY at
;; assembly (outside any compound SELECT). NULLS LAST throughout (only
;; :precedence is nullable) so missing values sort to the end either direction.
(defn order-directive
  "The ORDER BY directive ([[col dir] ...]) compile-query attached as metadata,
  or nil. exec reads it from the head branch and applies it once at assembly."
  [hq]
  (::order-by (meta hq)))

(defn- order-projection
  "For each :order-by spec `[field-ref dir]`, a [hidden-select-pair order-by-pair].
  The select pair exposes the sort expression (`field-expr`, e.g. a decoded :value
  or a metadata subquery) under `:__ord_N`; the order-by pair references it."
  [st order-by]
  (map-indexed
   (fn [i [fr dir]]
     (let [ord-kw (keyword (str "__ord_" i))]
       [[(:sql (field-expr st fr)) ord-kw]
        [ord-kw (if (= dir :desc) :desc-nulls-last :asc-nulls-last)]]))
   order-by))

;; --- aggregate projection ($:return {:group .. :aggregates ..}) -------------
;; The match query projects (DISTINCT) the group columns, the aggregate source
;; columns, and EVERY entity/layer var's id — so DISTINCT counts true matches
;; (every distinct binding of all variables), not raw join rows. exec then wraps
;; this in `SELECT <group>, <agg fns> ... GROUP BY <group>`.

(defn aggregate-plan
  "The aggregate plan compile-query attached as metadata (or nil): :group-cols /
  :group-labels and per-aggregate {:op :col :label}. exec builds the outer query."
  [hq]
  (::aggregate (meta hq)))

(defn- term-label
  "Output column label for an aggregate source / group key: a value var `?b` ->
  \"b\"; a field path `?t.begin` -> \"t_begin\" (alnum-cleaned, so it's a safe
  positional-free label)."
  [t]
  (if (ast/field-ref? t)
    (str/join "_" (cons (subs (name (ast/field-var t)) 1)
                        (map #(str/replace % #"[^A-Za-z0-9]+" "") (ast/field-path t))))
    (subs (name t) 1)))

(defn- scalar-agg-expr
  "SQL for an aggregate/group VALUE: a field path -> its (decoded) expression; a
  scalar var -> its bound column (json_extract-decoded if JSON-encoded, e.g. :value)."
  [st src]
  (if (ast/field-ref? src)
    (:sql (field-expr st src))
    (let [{:keys [sql json?]} (or (get-in @st [:scalar-col src])
                                  (err-500! (str "Aggregate/group var " src " was never bound to a column") {:var src}))]
      (if json? [:json_extract sql [:inline "$"]] sql))))

(defn- group-expr
  "SQL for a group key: a field path / scalar var -> its (decoded) value; an
  entity/layer var -> its id."
  [st g]
  (cond
    (ast/field-ref? g) (:sql (field-expr st g))
    (= :scalar (get-in @st [:kinds g])) (scalar-agg-expr st g)
    :else (col (or (get-in @st [:var->alias g])
                   (err-500! (str "Group var " g " was never bound to a table") {:var g}))
               :id)))

(defn- aggregate-projection
  "Returns {:select <distinct-match projection> :plan <plan for exec>}. ALL the
  internal aliases (__g_N / __a_N / __e_N) are POSITIONAL — no user var name ever
  becomes a SQL identifier. The `__e_N` entity-id columns (which make a match
  distinct) are ordered by var name so they align across UNION branches; `expand`
  guarantees every branch binds the same entity-var set under aggregation."
  [st ret]
  (let [group-vars (:group ret)
        g-proj (map-indexed (fn [i v] [(group-expr st v) (keyword (str "__g_" i))]) group-vars)
        agg-srcs (distinct (keep second (:aggregates ret)))
        src->kw (into {} (map-indexed (fn [i v] [v (keyword (str "__a_" i))]) agg-srcs))
        a-proj (mapv (fn [v] [(scalar-agg-expr st v) (src->kw v)]) agg-srcs)
        ;; every entity/layer var id makes a match distinct; sort by var name so
        ;; column N denotes the SAME variable in every branch of a UNION.
        e-vars (sort-by name (keys (:var->alias @st)))
        e-proj (map-indexed (fn [i v] [(col (get-in @st [:var->alias v]) :id) (keyword (str "__e_" i))]) e-vars)
        label (fn [op src] (if src (str (name op) "_" (term-label src)) (name op)))
        plan {:group-cols (mapv second g-proj)
              :group-labels (mapv term-label group-vars)
              :aggs (mapv (fn [[op src]] {:op op :col (when src (src->kw src)) :label (label op src)})
                          (:aggregates ret))}]
    {:select (vec (concat g-proj a-proj e-proj)) :plan plan}))

(defn- assert-acl-invariant! [st]
  (let [scoped-kind? #(or (contains? entity-table %) (layer-kind? %))
        entity-vars (->> (:kinds @st) (filter (fn [[_ k]] (scoped-kind? k))) (map key) set)
        unscoped (set/difference entity-vars (:scoped @st))]
    (when (seq unscoped)
      (err-500! (str "ACL invariant violated: entity/layer vars without a scope predicate: " (vec unscoped))
                {:vars (vec unscoped)}))))

(defn compile-query
  "Resolved AST -> HoneySQL map. Throws 500 only on internal invariant failures."
  [resolved]
  (let [scope (::qr/scope resolved)
        ;; validate already inferred + attached the var-kinds; reuse it (fall back
        ;; to re-inferring if a caller hands us an AST that skipped validate).
        kinds (or (::ast/var-kinds resolved) (ast/infer-kinds resolved))
        st (new-state scope kinds)
        constraints (collect-entity-constraints (:where resolved))]
    ;; Pass B: every POSITIVELY-bound var (entity + relationship-introduced) gets
    ;; a table + scope. Vars that appear only inside a :not are existential to the
    ;; subquery and are allocated there by compile-not!, not in the outer query.
    (doseq [v (ast/positive-binding-vars (:where resolved))]
      (ensure-var! st v constraints))
    ;; emit each positive entity/layer clause's filters against its var's alias —
    ;; per-clause so two clauses on one var AND. Layer filters (name/alias/structural
    ;; slots) are emitted here too (not in ensure-layer-var!) so the :not path can
    ;; correlate them; see emit-layer-filters!.
    (doseq [clause (:where resolved)]
      (let [[head v cmap] clause]
        (cond
          (contains? entity-table head)
          (emit-entity-filters! st head (get-in @st [:var->alias v]) (or cmap {}))
          (contains? layer-entity-table head)
          (emit-layer-filters! st (get-in @st [:var->alias v]) head (or cmap {}) constraints))))
    ;; Pass C: relationship clauses, inline relation source/target, and negation.
    (doseq [clause (:where resolved)]
      (cond
        (= :not (first clause)) (compile-not! st constraints clause)
        ;; layer-constraint clauses are fully handled by ensure-layer-var! in Pass B
        (contains? layer-entity-table (first clause)) nil
        (contains? entity-table (first clause)) (compile-relation-inline! st constraints clause)
        (pred-honeysql-op (first clause)) (compile-pred! st clause)
        :else (compile-rel! st constraints clause)))
    (assert-acl-invariant! st)
    (if (ast/aggregate? resolved)
      ;; aggregate mode: project the distinct-match columns; exec wraps in GROUP BY
      (let [{:keys [select plan]} (aggregate-projection st (:return resolved))]
        (vary-meta {:select-distinct select :from (:from @st) :where (into [:and] (:where @st))}
                   assoc ::aggregate plan))
      (let [order-pairs (order-projection st (:order-by resolved))
            select (into (find-select st (:find resolved)) (map first) order-pairs)
            directive (mapv second order-pairs)
            hq (cond-> {:select-distinct select
                        :from (:from @st)
                        :where (into [:and] (:where @st))}
                 (:limit resolved) (assoc :limit (:limit resolved)))]
        (cond-> hq
          (seq directive) (vary-meta assoc ::order-by directive))))))
