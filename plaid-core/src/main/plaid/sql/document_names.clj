(ns plaid.sql.document-names
  "Document names are unique within a project (Luke, 2026-10-16), ignoring
  case: \"Story\" and \"story\" are one name. Creating or renaming a document
  to a name another document of its project holds is refused. A copy or an
  import that asks for it takes the first free name instead: the name itself,
  else \"Name (2)\", \"Name (3)\" and on.

  Names are compared by `fold`, kept beside each name in `documents.name_key`,
  which a unique index over `(project_id, name_key)` holds to. The migrations
  that made the rule true renamed the documents that shared a name the same
  way, the oldest keeping the bare name."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :refer [submit-operation!]]
            [plaid.util.canonical :as canonical]
            [taoensso.timbre :as log]))

(def ^:private case-folds
  "Code point to what Python's `str.casefold` folds it to, read from
  `resources/casefold.txt` (written by `scripts/casefold_table.py`)."
  (with-open [r (io/reader (io/resource "casefold.txt") :encoding "UTF-8")]
    (into {}
          (comp (remove #(or (str/blank? %) (str/starts-with? % "#")))
                (map (fn [line]
                       (let [[cp & to] (str/split (str/trim line) #" ")]
                         [(Integer/parseInt cp 16)
                          (let [sb (StringBuilder.)]
                            (doseq [t to] (.appendCodePoint sb (Integer/parseInt t 16)))
                            (str sb))]))))
          (line-seq r))))

(defn fold
  "`name` as names are compared: composed, then Python's `str.casefold` (full
  Unicode case folding, the assistant's comparison), composed again. So ß and
  SS are one, so are ς and σ, and dotless ı stays apart from i and I."
  ^String [^String name]
  (let [sb (StringBuilder.)]
    (.forEach (.codePoints (canonical/nfc name))
              (reify java.util.function.IntConsumer
                (accept [_ cp]
                  (if-let [to (case-folds cp)]
                    (.append sb ^String to)
                    (.appendCodePoint sb cp)))))
    (canonical/nfc (str sb))))

(defn candidates
  "The names a copy or an import named `name` tries, in order: `name`, then
  \"name (2)\", \"name (3)\" and on."
  [name]
  (cons name (map #(str name " (" % ")") (iterate inc 2))))

(defn free-name
  "The first of `(candidates name)` that `taken?` says no to."
  [taken? name]
  (first (remove taken? (candidates name))))

(defn holder
  "The id of a document of `project` whose name folds as `name` does, other
  than `except` (nil for none), or nil."
  [tx project name except]
  (:id (psc/q1 tx {:select [:id]
                   :from [:documents]
                   :where (cond-> [:and [:= :project_id project] [:= :name_key (fold name)]]
                            except (conj [:<> :id except]))
                   :limit 1})))

(defn taken
  "The refusal for `name`: 422, with `name-taken` in the answer's body."
  [name]
  (ex-info (str "A document named “" name "” already exists in this project.")
           {:code 422 :plaid/body {:name-taken name}}))

(defn settle!
  "The name a write of `name` to a document of `project` stores, inside the
  write's transaction. `except` is the document being renamed (nil on a
  create). With `free?` a taken name gives way to the first free one, else a
  taken name is refused."
  [tx project name {:keys [except free?]}]
  (let [taken? #(some? (holder tx project % except))]
    (cond
      free? (free-name taken? name)
      (taken? name) (throw (taken name))
      :else name)))

;; ============================================================
;; The migrations: 20261016120000-document-names-unique.edn made names
;; unique exactly as stored, 20261016130000-document-names-fold.edn
;; ignoring case.
;; ============================================================

(defn renames
  "`[[id new-name] ...]` for `docs`, rows of one project with `:id`, `:name`
  and `:created_at`: in each group of documents whose names `key-fn` makes
  one, every one but the oldest (by `created_at`, then id) takes the first
  free name, free of every name in the project and of the names given before
  it, as `key-fn` compares them."
  ([docs] (renames docs identity))
  ([docs key-fn]
   (let [groups (->> docs
                     (group-by (comp key-fn :name))
                     (filter #(< 1 (count (val %))))
                     (sort-by key))]
     (first
      (reduce (fn [[out used] [_ group]]
                (reduce (fn [[out used] {:keys [id name]}]
                          (let [n (free-name (comp used key-fn) name)]
                            [(conj out [id n]) (conj used (key-fn n))]))
                        [out used]
                        (rest (sort-by (juxt :created_at :id) group))))
              [[] (set (map (comp key-fn :name) docs))]
              groups)))))

(defn- rename!
  "Rename one document as its own operation, by no one, keeping its
  `modified_at`: nobody edited it. `attrs` are further columns to set."
  [ds project {:keys [id name]} new-name & [attrs]]
  (let [r (submit-operation! [tx ds {:type :document/update
                                     :project project
                                     :document id
                                     :description (str "Rename document \"" name "\" to \"" new-name
                                                       "\": another document of the project had the same name")
                                     :user nil
                                     :skip-lock-check? true
                                     :skip-doc-version-bump? true}]
                             (let [row (psc/fetch-by-id tx :documents id)]
                               (crud/update-by-id! tx :documents id
                                                   (merge {:name new-name
                                                           :version (inc (or (:version row) 1))}
                                                          attrs))))]
    (when-not (:success r)
      (throw (ex-info (str "Renaming document " id " failed: " (:error r)) {:result r})))))

(defn up
  "Rename every document that shares its name within its project, then make
  the database refuse a duplicate. A project being deleted takes no
  operations and loses its history anyway, so its rows are renamed in place."
  [config]
  (let [ds (get-in config [:db :datasource])
        opts {:builder-fn rs/as-unqualified-maps}
        docs (jdbc/execute! ds ["SELECT d.id, d.name, d.project_id, d.created_at, p.deleted_at
                                 FROM documents d JOIN projects p ON p.id = d.project_id
                                 WHERE EXISTS (SELECT 1 FROM documents e
                                               WHERE e.project_id = d.project_id AND e.name = d.name
                                                 AND e.id <> d.id)"]
                            opts)
        projects (set (map :project_id docs))
        n (atom 0)]
    (doseq [project projects]
      (let [all (jdbc/execute! ds ["SELECT id, name, created_at FROM documents WHERE project_id = ?" project] opts)
            by-id (into {} (map (juxt :id identity)) docs)
            deleted? (some? (:deleted_at (some #(when (= project (:project_id %)) %) docs)))]
        (doseq [[id new-name] (renames all)]
          (swap! n inc)
          (if deleted?
            (jdbc/execute! ds ["UPDATE documents SET name = ? WHERE id = ?" new-name id])
            (rename! ds project (by-id id) new-name)))))
    (when (pos? @n)
      (log/info "Renamed" @n "documents in" (count projects) "projects: names are unique in a project"))
    (jdbc/execute! ds ["CREATE UNIQUE INDEX idx_documents_project_name_unique ON documents(project_id, name)"])))

(defn down [config]
  (jdbc/execute! (get-in config [:db :datasource])
                 ["DROP INDEX IF EXISTS idx_documents_project_name_unique"]))

(defn- refold!
  "Give every document its `name_key` by `fold` as it is now, rename the
  documents whose names are one by it the way `up` renamed exact duplicates
  (the oldest keeps its name, the later ones take the first free \"Name
  (2)\"), and put the unique index over `(project_id, name_key)`."
  [ds]
  (let [opts {:builder-fn rs/as-unqualified-maps}]
    (jdbc/execute! ds ["DROP INDEX IF EXISTS idx_documents_project_name_key"])
    ;; Derived from the name, filled in place: no one wrote it.
    (jdbc/with-transaction [tx ds]
      (doseq [{:keys [id name]} (jdbc/execute! tx ["SELECT id, name FROM documents"] opts)]
        (jdbc/execute! tx ["UPDATE documents SET name_key = ? WHERE id = ?" (fold name) id])))
    (let [docs (jdbc/execute! ds ["SELECT d.id, d.name, d.project_id, d.created_at, p.deleted_at
                                   FROM documents d JOIN projects p ON p.id = d.project_id
                                   WHERE EXISTS (SELECT 1 FROM documents e
                                                 WHERE e.project_id = d.project_id AND e.name_key = d.name_key
                                                   AND e.id <> d.id)"]
                              opts)
          projects (set (map :project_id docs))
          by-id (into {} (map (juxt :id identity)) docs)
          n (atom 0)]
      (doseq [project projects]
        (let [all (jdbc/execute! ds ["SELECT id, name, created_at FROM documents WHERE project_id = ?" project] opts)
              deleted? (some? (:deleted_at (some #(when (= project (:project_id %)) %) docs)))]
          (doseq [[id new-name] (renames all fold)]
            (swap! n inc)
            (if deleted?
              (jdbc/execute! ds ["UPDATE documents SET name = ?, name_key = ? WHERE id = ?" new-name (fold new-name) id])
              (rename! ds project (by-id id) new-name {:name_key (fold new-name)})))))
      (when (pos? @n)
        (log/info "Renamed" @n "documents in" (count projects) "projects: names are unique in a project, ignoring case")))
    (jdbc/execute! ds ["CREATE UNIQUE INDEX idx_documents_project_name_key ON documents(project_id, name_key)"])))

(defn up-fold
  "Add `name_key`, fill it, rename the documents whose names are one but for
  case, and move the unique index from the name to the folded name."
  [config]
  (let [ds (get-in config [:db :datasource])]
    (jdbc/execute! ds ["ALTER TABLE documents ADD COLUMN name_key TEXT"])
    (jdbc/execute! ds ["DROP INDEX IF EXISTS idx_documents_project_name_unique"])
    (refold! ds)))

(defn down-fold [config]
  (let [ds (get-in config [:db :datasource])]
    (jdbc/execute! ds ["DROP INDEX IF EXISTS idx_documents_project_name_key"])
    (jdbc/execute! ds ["ALTER TABLE documents DROP COLUMN name_key"])
    (jdbc/execute! ds ["CREATE UNIQUE INDEX idx_documents_project_name_unique ON documents(project_id, name)"])))

(defn up-casefold
  "Fold every name again now that `fold` is Python's `str.casefold` exactly
  (REV7-CORE-2): dotless ı no longer folds with i, and a letter like a
  Cherokee one folds to the form casefold gives. A finer fold, so no two names
  that were apart come together, but `refold!` renames them if they do."
  [config]
  (refold! (get-in config [:db :datasource])))

(defn down-casefold
  "Nothing to take back: the keys stay as the later fold made them."
  [_config])
