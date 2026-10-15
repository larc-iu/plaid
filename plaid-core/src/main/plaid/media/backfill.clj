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
  of a format whose length is not read (by extension), and files with no
  document. `--apply` writes each length in its own short statement, so the
  server's write lock is never waited on for long, and never replaces a
  length already stored (an upload made meanwhile keeps its own). Running it
  again is safe: what is stored is not read again, so a run after a complete
  one finds nothing to store.

  The length is not audited, as the recording itself is not (see the
  `document_media` migration), so nothing appears in any History."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [next.jdbc :as jdbc]
            [plaid.media.duration :as duration])
  (:import [java.io File]
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
  (let [name (.getName f)]
    (str/lower-case (subs name (inc (.lastIndexOf name "."))))))

(defn backfill!
  "Read every media file's length and, when `apply?`, store each one not
  stored yet. Returns the counts printed."
  [conn ^File media-dir apply?]
  (let [files (->> (or (.listFiles media-dir) (make-array File 0))
                   (filter #(.isFile ^File %))
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
           (if-let [secs (duration/seconds f (extension f))]
             (do
               (when apply?
                 ;; Only for a document that is still there, and never over
                 ;; a length an upload stored since the check above.
                 (jdbc/execute! conn [(str "INSERT INTO document_media (document_id, duration) "
                                           "SELECT ?, ? WHERE EXISTS (SELECT 1 FROM documents WHERE id = ?) "
                                           "ON CONFLICT (document_id) DO NOTHING")
                                      id (double secs) id]))
               (-> counts
                   (update (if apply? :stored :to-store) inc)
                   (update :seconds + secs)))
             (update-in counts [:unknown-format (extension f)] (fnil inc 0))))))
     {:files 0 :already-stored 0 (if apply? :stored :to-store) 0 :seconds 0.0
      :unknown-format {} :no-document 0}
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
      (let [counts (backfill! conn media-dir apply?)]
        (println (if apply? "Applied." "Dry run, nothing written. --apply writes."))
        (doseq [[k v] counts]
          (println (str (name k) ": " (if (= k :seconds) (format "%.1f" v) v))))))
    (shutdown-agents)))
