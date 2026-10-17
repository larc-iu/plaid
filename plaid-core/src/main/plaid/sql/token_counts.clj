(ns plaid.sql.token-counts
  "How many tokens of each layer, per document, have a surface that matches a
  regex: what an app's word count reads when some tokens of its word layer are
  not words to it (plaid-igt's ignored-tokens rule, so that punctuation ud's
  Tokenize made is no word there).

  The query language can say the same (`[:token ?t {:layer .. :value {:regex ..}}]`
  grouped by document), but it slices each token's surface out of its text with
  SQLite's `substr`, which walks the body from its start, once per token: on a
  document of 180,000 tokens that ran past the query timeout. Here each text body
  is read once and cut by code point in Java, so the cost is that of reading the
  tokens' offsets.

  A count is kept in memory per layer, document and pattern, beside the
  document's version, which every write to the document moves on (strict mode
  rests on it), and the number of the layer's tokens there. A read whose
  signature matches answers from it, so a list read again costs one grouped
  count and a read of the versions. Only committed state is kept: a read on a
  transaction's connection (inside a `/batch`) neither reads nor fills the
  cache, since what it sees may still roll back while a later write lands on
  the same version and count.

  A surface matches as the query language's REGEXP decides
  (`plaid.sql.query.exec/regexp-function`): as stored, or in NFC with the pattern
  in NFC, or, for a pattern that names a combining mark, in NFD."
  (:require [clojure.string :as str]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.query.clauses :as clauses]
            [plaid.sql.common :as psc]
            [plaid.sql.query.resolve :as resolve]
            [plaid.util.canonical :as canonical])
  (:import [java.util.regex Pattern]))

(def ^:dynamic *timeout-ms*
  "How long one count may run before it is refused 408, as a query is."
  30000)

(defn- refuse! [code msg]
  (throw (ex-info msg {:code code})))

(defn- pattern-of
  "The compiled pattern for a `{:regex .. :flags \"i\"?}` spec, or a 400."
  ^Pattern [{:keys [regex flags] :as spec}]
  (when-not (and (map? spec) (string? regex))
    (refuse! 400 "value must be {\"regex\": \"...\"}"))
  (when (> (count regex) clauses/regex-max-len)
    (refuse! 400 (str "regex is too long (max " clauses/regex-max-len " chars)")))
  (when (and flags (or (not (string? flags)) (not (re-matches #"i*" flags))))
    (refuse! 400 (str "regex flags " (pr-str flags) " unsupported (only \"i\")")))
  (let [p (if (and flags (str/includes? flags "i")) (str "(?iu)" regex) regex)]
    (try (clauses/compile-regex p)
         (catch java.util.regex.PatternSyntaxException e
           (refuse! 400 (str "invalid regex: " (.getMessage e)))))))

(defn- matcher-fn
  "A predicate on a surface string: does `pattern` match it, as REGEXP does?"
  [^Pattern pattern]
  (let [src (.pattern pattern)
        nfc-src (canonical/nfc src)
        composed (when-not (identical? nfc-src src)
                   (try (clauses/compile-regex nfc-src) (catch Exception _ nil)))
        decomposed (when (canonical/names-mark? src)
                     (try (clauses/compile-regex (canonical/decompose-pattern src)) (catch Exception _ nil)))
        found? (fn [^Pattern p ^String s] (.find (.matcher p s)))]
    (fn [^String s]
      (boolean
       (or (found? pattern s)
           (let [ns (canonical/nfc s)]
             (cond
               composed (found? composed ns)
               (identical? ns s) false
               :else (found? pattern ns)))
           (when decomposed (found? decomposed (canonical/nfd s))))))))

(defonce ^:private cache
  ;; [layer doc pattern] -> [[token count, document version] count]
  (java.util.concurrent.ConcurrentHashMap.))

(def ^:private cache-cap 200000)

(defn- rows
  "A read's rows as vectors, ids as strings, nothing coerced."
  [db sql-map]
  (jdbc/execute! db (psc/format-sql sql-map) {:builder-fn rs/as-unqualified-arrays}))

(defn- count-doc
  "The tokens of `layer` in `doc` whose surface `matches?`, read now: the
  layer's tokens there, and the one text they lie in, read once."
  [db matches? layer doc]
  (let [toks (rest (rows db {:select [:begin :end_ :text_id] :from [:tokens]
                             :where [:and [:= :token_layer_id layer] [:= :document_id doc]]}))
        text (nth (first toks) 2 nil)
        ^String body (or (when text
                           (ffirst (rest (rows db {:select [:body] :from [:texts] :where [:= :id text]}))))
                         "")
        ^ints cps (.toArray (.codePoints body))
        n (alength cps)]
    (reduce (fn [acc [begin end]]
              (let [b (max 0 (min n (long begin)))
                    e (max b (min n (long end)))]
                (if (matches? (String. cps (int b) (int (- e b)))) (inc acc) acc)))
            0 toks)))

(defn counts
  "For each of `layer-ids` the user can read, each document's count of tokens
  whose surface matches `value` (a regex spec), as `[[layer-id document-id n]]`.
  A document with tokens of the layer and no match counts 0. A layer the user
  cannot read is left out, as a query's scope leaves it out."
  [db user-id layer-ids value]
  (when-not (and (sequential? layer-ids) (every? string? layer-ids))
    (refuse! 400 "layers must be a list of token layer ids"))
  (let [^Pattern pattern (pattern-of value)
        matches? (matcher-fn pattern)
        pkey (str (.flags pattern) ":" (.pattern pattern))
        projects (resolve/effective-scope db user-id nil)
        ids (vec (distinct (map str/lower-case layer-ids)))
        layers (if (and (seq ids) (seq projects))
                 (mapv first (rest (rows db {:select [:id] :from [:token_layers]
                                             :where [:and [:in :id ids] [:in :project_id (vec projects)]]})))
                 [])
        deadline (+ (System/currentTimeMillis) (long *timeout-ms*))
        ;; A route's :db is the datasource, except inside a batch, where it is
        ;; the open transaction's connection.
        cached? (not (instance? java.sql.Connection db))]
    (if (empty? layers)
      []
      (let [groups (rest (rows db {:select [:token_layer_id :document_id [[:count :*]]]
                                   :from [:tokens]
                                   :where [:in :token_layer_id layers]
                                   :group-by [:token_layer_id :document_id]}))
            versions (into {} (rest (rows db {:select [:d.id :d.version]
                                              :from [[:documents :d]]
                                              :where [:in :d.project_id
                                                      {:select [:project_id] :from [:token_layers]
                                                       :where [:in :id layers]}]})))
            out (java.util.ArrayList.)]
        (when (> (.size ^java.util.Map cache) cache-cap) (.clear ^java.util.Map cache))
        (doseq [[layer doc cnt] groups]
          (when (> (System/currentTimeMillis) deadline)
            (refuse! 408 "Counting took longer than the time limit."))
          (let [k [layer doc pkey]
                sig [cnt (get versions doc)]
                [had n] (when cached? (.get ^java.util.Map cache k))
                n (if (and cached? (= had sig))
                    n
                    (let [n (count-doc db matches? layer doc)]
                      (when cached? (.put ^java.util.Map cache k [sig n]))
                      n))]
            (.add out [layer doc n])))
        (vec out)))))
