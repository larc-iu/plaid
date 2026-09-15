(ns plaid.sql.guideline
  "Guidelines: a project's own annotation manual, as a flat list of short
  Markdown documents. See the `20260915120000-guidelines` migration for the
  design and for why these are audited when comments are not.

  Two things about the shape are load-bearing and easy to undo by accident.

  `title` is the HANDLE: the assistant asks for a guideline by title, never by
  id. It is NOT unique, deliberately. Refusing a save because a title is taken
  would reject a document somebody had just written, to prevent a confusion
  that is mild and that `read_guideline` absorbs by answering with every match.
  The editor warns while the title is typed instead.

  The page order is `(title, id)` and NOT pinned-first, because
  `plaid.sql.pagination/paginate` keysets over NOT NULL TEXT columns compared
  as strings and `pinned` is an INTEGER. Whoever displays a page groups the
  pinned rows. Putting `pinned` in `:order-by` would compile and then silently
  page wrong."
  (:require [clojure.string]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.pagination :as pagination])
  (:refer-clojure :exclude [get list merge]))

(def attr-keys [:guideline/id
                :guideline/project
                :guideline/title
                :guideline/summary
                :guideline/body
                :guideline/pinned
                :guideline/created-at
                :guideline/updated-at])

(def ^:const max-title-length
  "Ceiling on a title. A title is a handle and a list row, not a sentence."
  100)

(def ^:const max-summary-length
  "Ceiling on the one-line summary. This is the line the assistant reads to
  decide whether to open the guideline, and the line under the title in the
  list, so it stays short enough to be both."
  200)

(def ^:const max-body-length
  "Ceiling on one guideline's body, in characters. About three thousand words,
  which is a long section of a manual, and bounded so the table cannot become
  a file dump."
  20000)

;; ============================================================
;; Row mapper
;; ============================================================

(defn- row->guideline
  "Row to external entity. `include-body?` decides between the full text and
  `:guideline/body-chars`, a length a caller can budget against without
  fetching every body. Both count the same way `validate-*!` does, so the cap
  and the reported size never disagree."
  [include-body? row]
  (when row
    (cond-> {:guideline/id         (:id row)
             :guideline/project    (:project_id row)
             :guideline/title      (:title row)
             :guideline/summary    (:summary row)
             :guideline/pinned     (= 1 (:pinned row))
             :guideline/created-at (:created_at row)
             :guideline/updated-at (:updated_at row)}
      include-body?       (assoc :guideline/body (:body row))
      (not include-body?) (assoc :guideline/body-chars (count (or (:body row) ""))))))

;; ============================================================
;; Reads
;; ============================================================

(defn get
  "Read one guideline by id, body included, or nil."
  [db id]
  (row->guideline true (psc/fetch-by-id db :guidelines id)))

(defn project-id
  "The project owning this guideline, or nil."
  [db id]
  (:project_id (psc/fetch-by-id db :guidelines id)))

(defn list-in-project
  "Guidelines in `project-id`, by title, keyset-paginated. `include-bodies?`
  swaps each entry's body for its length."
  [db project-id {:keys [limit cursor-vals include-bodies?]}]
  (pagination/paginate db {:from        :guidelines
                           :base-where  [:= :project_id project-id]
                           :order-by    [:title :id]
                           :limit       limit
                           :cursor-vals cursor-vals
                           :row->entity (partial row->guideline (boolean include-bodies?))}))

;; ============================================================
;; Validation
;; ============================================================

(defn- validate-text!
  "Throw a 400 unless `v` is a non-blank string within `ceiling`. `what` names
  the field as the caller would see it."
  [what v ceiling]
  (when-not (string? v)
    (throw (ex-info (str what " must be a string") {:code 400})))
  (when (clojure.string/blank? v)
    (throw (ex-info (str what " cannot be blank") {:code 400})))
  (when (> (count v) ceiling)
    (throw (ex-info (str what " exceeds " ceiling " characters")
                    {:code 400 :length (count v)}))))

(defn- validate-body!
  "A body may be empty (a guideline can be created from its title and summary
  and written later), but not absent and not past the ceiling."
  [body]
  (when-not (string? body)
    (throw (ex-info "Guideline body must be a string" {:code 400})))
  (when (> (count body) max-body-length)
    (throw (ex-info (str "Guideline body exceeds " max-body-length " characters")
                    {:code 400 :length (count body)}))))

;; ============================================================
;; Mutations
;; ============================================================

(defn create
  "Create a guideline in `project-id`. `attrs` takes `:guideline/title`,
  `:guideline/summary`, and optionally `:guideline/body` and
  `:guideline/pinned`. Returns the new id."
  [db project-id attrs user-id]
  (let [{:guideline/keys [title summary body pinned]} attrs
        new-id (psc/new-uuid)]
    (submit-operation! [tx db {:type        :guideline/create
                               :project     project-id
                               :document    nil
                               :description (str "Create guideline \"" title "\"")
                               :user        user-id}]
                       (validate-text! "Guideline title" title max-title-length)
                       (validate-text! "Guideline summary" summary max-summary-length)
                       (validate-body! (or body ""))
                       (when (nil? (psc/fetch-by-id tx :projects project-id))
                         (throw (ex-info (psc/err-msg-not-found "Project" project-id)
                                         {:code 400 :id project-id})))
                       (let [ts (op/op-ts)]
                         (crud/insert! tx :guidelines
                                       {:id         new-id
                                        :project_id project-id
                                        :title      title
                                        :summary    summary
                                        :body       (or body "")
                                        :pinned     (if pinned 1 0)
                                        :created_at ts
                                        :updated_at ts}))
                       new-id)))

(defn merge
  "Patch a guideline. Every key in `m` is optional and an absent one is left
  alone, so a body edit does not have to restate the title."
  [db eid m user-id]
  (submit-operation! [tx db {:type        :guideline/update
                             :project     (project-id db eid)
                             :document    nil
                             :description (str "Update guideline " eid)
                             :user        user-id}]
                     (let [existing (psc/fetch-by-id tx :guidelines eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Guideline" eid) {:code 404 :id eid})))
                       (when (contains? m :guideline/title)
                         (validate-text! "Guideline title" (:guideline/title m) max-title-length))
                       (when (contains? m :guideline/summary)
                         (validate-text! "Guideline summary" (:guideline/summary m) max-summary-length))
                       (when (contains? m :guideline/body)
                         (validate-body! (:guideline/body m)))
                       (let [attrs (cond-> {}
                                     (contains? m :guideline/title)
                                     (assoc :title (:guideline/title m))
                                     (contains? m :guideline/summary)
                                     (assoc :summary (:guideline/summary m))
                                     (contains? m :guideline/body)
                                     (assoc :body (:guideline/body m))
                                     (contains? m :guideline/pinned)
                                     (assoc :pinned (if (:guideline/pinned m) 1 0)))
                             ;; Only the columns that actually move. `updated_at`
                             ;; is added after this filter, never before: stamping
                             ;; it unconditionally would make every PATCH differ
                             ;; from the stored row, and `crud/update-by-id!`'s
                             ;; skip-when-pre=post would never fire, so restating
                             ;; a guideline would write an audit row saying
                             ;; nothing changed.
                             changed (into {} (remove (fn [[col v]] (= v (clojure.core/get existing col))) attrs))]
                         (when (seq changed)
                           (crud/update-by-id! tx :guidelines eid
                                               (assoc changed :updated_at (op/op-ts))))
                         eid))))

(defn delete
  "Delete a guideline."
  [db eid user-id]
  (submit-operation! [tx db {:type        :guideline/delete
                             :project     (project-id db eid)
                             :document    nil
                             :description (str "Delete guideline " eid)
                             :user        user-id}]
                     (let [existing (psc/fetch-by-id tx :guidelines eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Guideline" eid) {:code 404 :id eid})))
                       (crud/delete-by-id! tx :guidelines eid)
                       eid)))
