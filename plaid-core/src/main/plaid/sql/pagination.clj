(ns plaid.sql.pagination
  "Shared keyset (seek) pagination for SQL-backed and in-memory list
  endpoints. Every paginated list endpoint returns the uniform envelope

      {:entries [...] :next-cursor <opaque-string-or-nil>}

  Cursors are OPAQUE base64url strings the client round-trips verbatim;
  internally they encode the vector of ORDER BY key values of the last row
  on the previous page. Keyset (not OFFSET) so pages stay stable under
  concurrent inserts and cost is independent of page depth.

  Two paginators because the codebase has two list shapes:
    - `paginate`      — one SQL keyset scan (documents, users, api-tokens,
                        audit). The scaling targets.
    - `paginate-coll` — an already-materialized, in-app seq (projects,
                        vocab-layers — `get-accessible` computes an id-set
                        then batch-hydrates). Bounded per user; pagination
                        there is response-shaping, not query-scaling.

  Every paginated sort key is TEXT in the SQLite store, so cursor values
  are stringified and compared lexicographically end-to-end (SQLite BINARY
  collation in SQL; Java String compare in `paginate-coll`) — each
  paginator is internally self-consistent."
  (:require [clojure.data.json :as json]
            [plaid.sql.common :as psc])
  (:import (java.util Base64)))

(def ^:const default-limit
  "Page size when no `?limit` is supplied." 100)

(def ^:const max-limit
  "Hard ceiling on `?limit`. The REST malli schema rejects larger values up
  front; clamping here is the defense-in-depth backstop." 1000)

(defn clamp-limit
  "nil / zero / negative / unparseable → default; values above max-limit →
  max-limit; an in-range positive value passes through. Always returns a
  positive integer."
  [limit]
  (let [n (cond
            (nil? limit) default-limit
            (integer? limit) limit
            :else (try (Long/parseLong (str limit))
                       (catch Exception _ default-limit)))]
    (cond
      (<= n 0) default-limit
      (> n max-limit) max-limit
      :else n)))

;; -- cursor codec -----------------------------------------------------------

(defn encode-cursor
  "Encode a vector of ORDER BY key values into an opaque base64url token,
  or nil when there is no next page (`vals` nil/empty). Values are
  stringified — every paginated sort key is TEXT in the store, so a string
  round-trip preserves ordering exactly."
  [vals]
  (when (seq vals)
    (let [payload (json/write-str {"v" (mapv str vals)})]
      (.encodeToString (.withoutPadding (Base64/getUrlEncoder)) (.getBytes ^String payload "UTF-8")))))

(defn decode-cursor
  "Decode an opaque cursor back into its vector of string key values, or nil
  when `cursor` is nil. Throws `(ex-info ... {:code 400})` on any malformed
  input so the REST layer surfaces a clean 400 rather than a 500."
  [cursor]
  (when (some? cursor)
    (try
      (let [bytes  (.decode (Base64/getUrlDecoder) ^String cursor)
            parsed (json/read-str (String. bytes "UTF-8"))
            vals   (clojure.core/get parsed "v")]
        ;; A base64-decodable payload that isn't a vector of scalars (missing
        ;; `v`, `v` not a vector, or an element that would bind as a non-scalar
        ;; SQL param) is a malformed cursor → 400, NOT a 500. The read path has
        ;; no global exception middleware, so this must carry `:code 400`
        ;; explicitly for `list-response` to surface it cleanly.
        (when-not (and (vector? vals)
                       (every? #(or (string? %) (number? %) (boolean? %)) vals))
          (throw (ex-info "Invalid pagination cursor" {:code 400})))
        (vec vals))
      (catch clojure.lang.ExceptionInfo e (throw e))
      (catch Exception _
        (throw (ex-info "Invalid pagination cursor" {:code 400}))))))

;; -- keyset predicate -------------------------------------------------------

(defn keyset-where
  "Lexicographic 'strictly after' seek predicate for ORDER BY `order-cols`
  ASC. `cursor-vals` is the previous page's last-row key vector. Returns a
  HoneySQL predicate, or nil when there is no cursor (first page).
  Generalizes the hand-written (ts,id) audit predicate to N columns:

    [c0]       -> [:> c0 v0]
    [c0 c1]    -> [:or [:> c0 v0] [:and [:= c0 v0] [:> c1 v1]]]
    [c0 c1 c2] -> [:or [:> c0 v0]
                       [:and [:= c0 v0] [:> c1 v1]]
                       [:and [:= c0 v0] [:= c1 v1] [:> c2 v2]]]"
  [order-cols cursor-vals]
  (when (seq cursor-vals)
    (let [pairs (mapv vector order-cols cursor-vals)
          terms (for [i (range (count pairs))]
                  (let [[col v] (nth pairs i)
                        eqs (for [j (range i)
                                  :let [[c2 v2] (nth pairs j)]]
                              [:= c2 v2])]
                    (if (seq eqs)
                      (into [:and] (conj (vec eqs) [:> col v]))
                      [:> col v])))]
      (into [:or] (vec terms)))))

;; -- paginators -------------------------------------------------------------

(defn paginate
  "Keyset-paginate a single SQL scan. Options:
    :select      column vector (default [:*])
    :from        table keyword (required)
    :base-where  optional HoneySQL predicate scoping the set
    :order-by    vector of bare ASC column keywords (no [:col :desc]
                 directives — the cursor is extracted by `(get row col)`);
                 MUST end in a unique tiebreaker (e.g. [:name :id]) for a
                 total order. Every column MUST be NOT NULL and TEXT: the
                 cursor is stringified and the seek compares lexicographically,
                 so a NULL value would encode to \"\" and silently skip rows,
                 and a numeric column would compare as a string. (All current
                 callers' sort columns satisfy this.)
    :limit       raw user limit (clamped; nil → default)
    :cursor-vals decoded cursor vector, or nil for the first page
    :row->entity row → external entity map (default identity)
  Returns {:entries [...] :next-cursor <raw-vals-or-nil>}. :next-cursor is
  the last row's `order-by` values IFF the page was full (== limit)."
  [db {:keys [select from base-where order-by limit cursor-vals row->entity]
       :or   {select [:*] row->entity identity}}]
  (let [lim   (clamp-limit limit)
        seek  (keyset-where order-by cursor-vals)
        where (cond
                (and base-where seek) [:and base-where seek]
                base-where            base-where
                seek                  seek
                :else                 nil)
        rows  (psc/q db (cond-> {:select   select
                                 :from     [from]
                                 :order-by (vec order-by)
                                 :limit    lim}
                          where (assoc :where where)))
        next-cursor (when (= (count rows) lim)
                      (let [last-row (peek (vec rows))
                            vals     (mapv #(clojure.core/get last-row %) order-by)]
                        ;; A nil here means an order-by column is nullable —
                        ;; encoding it would silently drop the NULL-keyed rows
                        ;; (NULL > '' is false in SQLite). Fail loudly instead of
                        ;; losing data. See the NOT-NULL contract above.
                        (when (some nil? vals)
                          (throw (ex-info "paginate: order-by column produced a nil cursor value; every order-by column must be NOT NULL"
                                          {:order-by order-by})))
                        vals))]
    {:entries     (mapv row->entity rows)
     :next-cursor next-cursor}))

(defn paginate-coll
  "Keyset-paginate an already-materialized seq of external entity maps.
  `key-fns` extract the sort key from an entity (same role as :order-by
  columns; the last MUST be a unique tiebreaker). The seq is sorted here by
  the stringified key vector, so callers need not pre-sort. Mirrors
  `paginate`'s envelope."
  [entities key-fns limit cursor-vals]
  (let [lim    (clamp-limit limit)
        skey   (fn [e] (mapv (fn [f] (str (f e))) key-fns))
        sorted (sort-by skey entities)
        pool   (if (seq cursor-vals)
                 (filter #(pos? (compare (skey %) (vec cursor-vals))) sorted)
                 sorted)
        page   (vec (take lim pool))
        next-cursor (when (= (count page) lim)
                      (mapv (fn [f] (f (peek page))) key-fns))]
    {:entries     page
     :next-cursor next-cursor}))

;; -- REST malli fragment ----------------------------------------------------

(def query-params
  "Malli `:map` entries for the shared ?limit/?cursor query params. Splice
  into a reitit `:parameters {:query ...}` via `(into [:map] query-params)`."
  [[:limit  {:optional true} [:int {:min 1 :max max-limit}]]
   [:cursor {:optional true} string?]])
