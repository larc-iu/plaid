(ns plaid.media.backfill
  "A one-off: store the length of every recording uploaded before core read
  it at upload (2026-10-15). A recording uploaded since has its length
  already. The length is read from each file's header by the same code the
  upload uses (`plaid.media.duration`), so it is what an upload of the same
  file would have stored.

  Usage, on the server's host, with the server running and AFTER the jar
  that carries this has started once (its migration makes the table):

      java -cp ~/plaid/plaid-current.jar clojure.main -m plaid.media.backfill \\
          --db ~/plaid/data/plaid.db                # dry run
      java -cp ... clojure.main -m plaid.media.backfill --db ... --apply

  The media directory is the `media` directory beside the database file, as
  core places it, unless `--media DIR` names another.

  The dry run (the default) reads the headers and writes nothing. It prints
  counts only: files, lengths already stored, lengths it would store, files
  of a format whose length is not read (`unknown-format`, by extension), files
  of a format that is read but whose header gave no length (`unreadable`, by
  extension, a damaged or unusual file worth a look), and files with no
  document. `--apply` writes each length in its own short transaction, so the
  server's write lock is never waited on for long, and never replaces a
  length already stored (an upload made meanwhile keeps its own). Nor does it
  store a length for a file that stopped being the document's while its
  header was read: the length is stored only when the same file (its inode,
  modification time and size) is still there under the write lock, and such a
  file is counted as `changed`. Running it
  again is safe: what is stored is not read again, so a run after a complete
  one finds nothing to store.

  The length is not audited, as the recording itself is not (see the
  `document_media` migration), so nothing appears in any History."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [next.jdbc :as jdbc]
            [plaid.media.duration :as duration]
            [plaid.media.storage :as storage])
  (:import [java.io File]
           [java.nio.file Files LinkOption]
           [java.nio.file.attribute BasicFileAttributes]
           [java.util UUID]))

(defn- document-id
  "The document a media file belongs to, by its name `<uuid>.<ext>`, or nil."
  [^File f]
  (let [name (.getName f)
        dot (.indexOf name ".")]
    (when (pos? dot)
      (try
        (str (UUID/fromString (subs name 0 dot)))
        (catch IllegalArgumentException _ nil)))))

(defn- extension [^File f]
  (str/lower-case (storage/recording-extension (.getName f))))

(defn- identity-of
  "What tells this file from a replacement stored under the same name or
  another: its inode, modification time and size, or nil when it is gone."
  [^File f]
  (try
    (let [a (Files/readAttributes (.toPath f) BasicFileAttributes
                                  ^"[Ljava.nio.file.LinkOption;" (make-array LinkOption 0))]
      [(.fileKey a) (.toMillis (.lastModifiedTime a)) (.size a)])
    (catch java.io.IOException _ nil)))

(defn- store-if-same-file!
  "Store `secs` for `id` when its recording is still the file `f` whose
  header was read (`seen` is that file's identity before the read), the
  document is still there and no length is stored. Under the write lock, so
  an upload or delete either committed before (and is seen here) or comes
  after (and replaces or removes this row as it would any). Returns whether
  it stored."
  [conn id ^File f seen secs]
  (jdbc/execute! conn ["BEGIN IMMEDIATE"])
  (try
    (let [same? (and seen (= seen (identity-of f)))
          n (if same?
              (-> (jdbc/execute-one! conn [(str "INSERT INTO document_media (document_id, duration) "
                                                "SELECT ?, ? WHERE EXISTS (SELECT 1 FROM documents WHERE id = ?) "
                                                "ON CONFLICT (document_id) DO NOTHING")
                                           id (double secs) id])
                  :next.jdbc/update-count)
              0)]
      (jdbc/execute! conn ["COMMIT"])
      (pos? (or n 0)))
    (catch Throwable t
      (try (jdbc/execute! conn ["ROLLBACK"]) (catch Throwable _ nil))
      (throw t))))

(defn backfill!
  "Read every media file's length and, when `apply?`, store each one not
  stored yet. Returns the counts printed."
  [conn ^File media-dir apply?]
  (let [files (->> (or (.listFiles media-dir) (make-array File 0))
                   (filter #(.isFile ^File %))
                   ;; Not an upload or a copy being staged (`<id>.<n>.upload`,
                   ;; `<id>.<n>.copy`), which is not a recording yet.
                   (filter #(storage/recording-name? (.getName ^File %)))
                   (keep (fn [f] (when-let [id (document-id f)] [id f])))
                   (sort-by first))
        live? (fn [id] (seq (jdbc/execute! conn ["SELECT 1 FROM documents WHERE id = ?" id])))
        known? (fn [id] (seq (jdbc/execute! conn ["SELECT 1 FROM document_media WHERE document_id = ?" id])))]
    (reduce
     (fn [counts [id f]]
       (let [counts (update counts :files inc)]
         (cond
           (not (live? id)) (update counts :no-document inc)
           (known? id) (update counts :already-stored inc)
           :else
           (let [seen (identity-of f)]
             (if-let [secs (duration/seconds f (extension f))]
               (cond
                 (not apply?) (-> counts (update :to-store inc) (update :seconds + secs))
                 (store-if-same-file! conn id f seen secs) (-> counts (update :stored inc) (update :seconds + secs))
                 :else (update counts :changed inc))
               (update-in counts
                          [(if (duration/reads-extension? (extension f)) :unreadable :unknown-format)
                           (extension f)]
                          (fnil inc 0)))))))
     (cond-> {:files 0 :already-stored 0 (if apply? :stored :to-store) 0 :seconds 0.0
              :unknown-format {} :unreadable {} :no-document 0}
       apply? (assoc :changed 0))
     files)))

(defn- parse-args [args]
  (loop [[a & more] args m {}]
    (case a
      nil m
      "--db" (recur (next more) (assoc m :db (first more)))
      "--media" (recur (next more) (assoc m :media (first more)))
      "--apply" (recur more (assoc m :apply? true))
      (throw (ex-info (str "Unknown argument " a ". Takes --db PATH, --media DIR and --apply.") {})))))

(defn -main [& args]
  (let [{:keys [db media apply?]} (parse-args args)
        db-file (some-> db io/file)
        media-dir (if media
                    (io/file media)
                    (some-> db-file .getAbsoluteFile .getParentFile (io/file "media")))]
    (when-not (and db-file (.isFile db-file))
      (binding [*out* *err*] (println "--db must name the server's database file."))
      (System/exit 2))
    (when-not (.isDirectory ^File media-dir)
      (binding [*out* *err*] (println "No media directory at" (str media-dir)))
      (System/exit 2))
    (with-open [conn (jdbc/get-connection (str "jdbc:sqlite:" (.getPath db-file)))]
      ;; Wait for the server's write lock rather than fail on it.
      (jdbc/execute! conn ["PRAGMA busy_timeout = 30000"])
      (when-not (seq (jdbc/execute! conn ["SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_media'"]))
        (binding [*out* *err*]
          (println "The database has no document_media table. Start the server with this version once first."))
        (System/exit 2))
      (let [counts (backfill! conn media-dir apply?)]
        (println (if apply? "Applied." "Dry run, nothing written. --apply writes."))
        (doseq [[k v] counts]
          (println (str (name k) ": " (if (= k :seconds) (format "%.1f" v) v))))))
    (shutdown-agents)))
