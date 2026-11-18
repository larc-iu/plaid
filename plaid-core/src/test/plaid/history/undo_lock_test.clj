(ns plaid.history.undo-lock-test
  "What an undo holds the write lock for (SCL4-2, SCL4-3): an undo refused
  for its size is refused before the lock is taken, and the final check of
  a document's token layers reads only the documents whose texts or tokens
  the undo wrote."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [plaid.fixtures :as fix :refer [admin-request api-call assert-ok with-admin with-clean-db
                                            with-db with-mount-states with-rest-handler]]
            [plaid.history.restore :as restore]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- in-group [group]
  (fn [method path]
    (admin-request method (str path (if (str/includes? path "?") "&" "?") "group-id=" group))))

(defn- dry-undo [entry-id]
  (api-call admin-request {:method :post :path (str "/api/v1/audit/entries/" entry-id "/undo?dry-run=true")}))

(defn- setup! []
  (let [proj (create-test-project admin-request "Undo lock")
        doc-id (create-test-document admin-request proj "Doc")
        tl (id (create-text-layer admin-request proj "Text"))
        text (id (create-text admin-request tl doc-id "the quick brown fox"))
        word (id (create-token-layer admin-request tl "Words"))
        pos (id (create-span-layer admin-request word "POS"))
        toks (-> (bulk-create-tokens admin-request
                                     (mapv (fn [[b e]] {:token-layer-id word :text text :begin b :end e})
                                           [[0 3] [4 9] [10 15] [16 19]]))
                 :body :ids)
        spans (-> (bulk-create-spans admin-request
                                     (mapv (fn [t v] {:span-layer-id pos :tokens [t] :value v})
                                           toks ["DET" "ADJ" "ADJ" "NOUN"]))
                  :body :ids)]
    {:doc doc-id :text text :word word :toks toks :spans spans}))

(deftest an-undo-past-the-limit-is-refused-before-the-write-lock
  ;; Another connection holds the write lock past busy_timeout. Before the
  ;; fix the undo read and folded its rows under BEGIN IMMEDIATE, so it
  ;; waited for the lock and answered 503 after 5 s.
  (let [{:keys [spans]} (setup!)
        g (str (random-uuid))]
    (doseq [s (take 3 spans)] (assert-ok (update-span (in-group g) s :value "g")))
    (with-redefs [plaid.history.undo/max-rows 2]
      (with-open [holder (java.sql.DriverManager/getConnection
                          (.getJdbcUrl ^com.zaxxer.hikari.HikariDataSource fix/db))]
        (with-open [st (.createStatement holder)] (.execute st "BEGIN IMMEDIATE"))
        (try
          (let [t0 (System/nanoTime)
                resp (dry-undo g)
                ms (/ (- (System/nanoTime) t0) 1e6)]
            (is (= 413 (:status resp)))
            (is (= "This entry changed 3 rows. An undo takes at most 2." (-> resp :body :error)))
            (is (< ms 4000) "refused without waiting for the lock"))
          (finally
            (with-open [st (.createStatement holder)] (.execute st "ROLLBACK"))))))))

(deftest the-final-check-reads-only-documents-whose-tokens-the-undo-wrote
  (let [{:keys [doc text word spans]} (setup!)
        checked (atom [])
        real restore/final-state-violation]
    (with-redefs [restore/final-state-violation (fn [tx d] (swap! checked conj d) (real tx d))]
      (testing "an entry of span values only: no document is read for its token layers"
        (let [g (str (random-uuid))]
          (doseq [s (take 2 spans)] (assert-ok (update-span (in-group g) s :value "X")))
          (reset! checked [])
          (let [resp (dry-undo g)]
            (is (= 200 (:status resp)) (pr-str (:body resp)))
            (is (= 2 (-> resp :body :total)))
            (is (= [] @checked)))))
      (testing "an entry that made a token: its document is checked"
        (let [g (str (random-uuid))]
          (id (create-token (in-group g) word text 0 9))
          (reset! checked [])
          (let [resp (dry-undo g)]
            (is (= 200 (:status resp)) (pr-str (:body resp)))
            (is (= [(str doc)] (mapv str @checked)))))))))
