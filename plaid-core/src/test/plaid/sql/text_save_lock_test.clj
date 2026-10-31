(ns plaid.sql.text-save-lock-test
  "A body save works out its diff and token arithmetic once, under the write
  lock: sent with an Idempotency-Key (as both clients send every write),
  without one, and inside an atomic batch."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler admin-request api-call
                                    assert-created assert-ok with-admin with-clean-db]]
            [plaid.sql.text :as st]
            [plaid.test-helpers :refer :all]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private old-body "the cat sat on the mat.\nthe dog ran.\n")
(def ^:private new-body "oh, the cow sat on a mat.\nthe dog ran far.\n")

(defn- extents-of
  "[begin end] of each word of `body`."
  [body]
  (map (fn [m] [(.start m) (.end m)])
       (let [m (re-matcher #"[a-z]+" body)]
         (take-while some? (repeatedly #(when (.find m) (.toMatchResult m)))))))

(defn- id-of [res] (-> res :body :id))

(defn- setup
  "A project with a document holding `old-body`: sentences (a partition),
  words under them, a morpheme per word under those, nodes (any overlap) on
  the first two words, a gloss span on every word."
  [name]
  (let [req admin-request
        proj (create-test-project req name)
        doc (create-test-document req proj "Doc")
        tl (id-of (create-text-layer req proj "TL"))
        s (id-of (create-token-layer-opts req tl "Sentences" {:overlap-mode "partitioning"}))
        w (id-of (create-token-layer-opts req tl "Words" {:overlap-mode "non-overlapping"
                                                          :parent-token-layer-id s}))
        m (id-of (create-token-layer-opts req tl "Morphemes" {:overlap-mode "non-overlapping"
                                                              :parent-token-layer-id w}))
        n (id-of (create-token-layer-opts req tl "Nodes" {:overlap-mode "any"}))
        gloss (id-of (create-span-layer req w "Gloss"))
        text (id-of (create-text req tl doc old-body))
        words (extents-of old-body)
        mk (fn [layer exts]
             (-> (bulk-create-tokens req (mapv (fn [[b e]] {:token-layer-id layer :text text :begin b :end e}) exts))
                 :body :ids))
        _ (mk s [[0 24] [24 37]])
        w-ids (mk w words)
        _ (mk m words)
        n-ids (mk n (take 2 words))]
    (assert (= (count words) (count w-ids)))
    (assert-created (bulk-create-spans req (mapv (fn [id] {:span-layer-id gloss :tokens [id] :value "gl"}) w-ids)))
    {:project proj :doc doc :text text :text-layer tl
     :layers {:s s :w w :m m :n n} :words (vec w-ids) :nodes (vec n-ids)}))

(defn- snapshot
  "The document as layer names and extents, so two projects compare."
  [{:keys [doc text]}]
  (let [body (-> (get-text admin-request text) :body :text/body)
        tls (->> (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc "?include-body=true")})
                 :body :document/text-layers
                 (mapcat :text-layer/token-layers))
        where (into {} (for [tl tls t (:token-layer/tokens tl)]
                         [(:token/id t) [(:token-layer/name tl) (:token/begin t) (:token/end t)]]))]
    {:body body
     :tokens (sort (vals where))
     :spans (sort (for [tl tls sl (:token-layer/span-layers tl) sp (:span-layer/spans sl)]
                    [(:span-layer/name sl) (:span/value sp) (mapv where (:span/tokens sp))]))}))

(defn- plan-calls
  "Run `f`, answering its result and, per call of `save-plan`, whether it
  read from a transaction's Connection (under the write lock)."
  [f]
  (let [plan-save @#'st/save-plan
        calls (atom [])
        res (with-redefs [st/save-plan (fn [db eid body base tk]
                                         (swap! calls conj (instance? java.sql.Connection db))
                                         (plan-save db eid body base tk))]
              (f))]
    {:res res :calls @calls}))

(defn- keyed
  "`admin-request` with an Idempotency-Key, as the clients send every write."
  [method path]
  (mock/header (admin-request method path) "Idempotency-Key" (str (random-uuid))))

(deftest a-save-is-worked-out-once-under-the-lock-keyed-or-not
  (doseq [[label req] [["keyed" keyed] ["unkeyed" admin-request]]]
    (testing label
      (let [twin (setup (str "Twin " label))
            _ (assert-ok (update-text admin-request (:text twin) new-body))
            ctx (setup label)
            {:keys [res calls]} (plan-calls #(api-call req {:method :patch
                                                            :path (str "/api/v1/texts/" (:text ctx))
                                                            :body {:body new-body}}))]
        (assert-ok res)
        (is (= [true] calls))
        (is (= (snapshot twin) (snapshot ctx)))))))

(deftest a-save-in-an-atomic-batch-is-worked-out-once-under-the-batch-lock
  (let [twin (setup "Batch twin")
        _ (assert-ok (update-token admin-request (nth (:nodes twin) 1) :begin 4 :end 11))
        _ (assert-ok (update-text admin-request (:text twin) new-body))
        ctx (setup "Batch")
        {:keys [res calls]} (plan-calls
                             #(api-call admin-request {:method :post :path "/api/v1/batch"
                                                       :body [{:path (str "/api/v1/tokens/" (nth (:nodes ctx) 1))
                                                               :method "patch" :body {:begin 4 :end 11}}
                                                              {:path (str "/api/v1/texts/" (:text ctx))
                                                               :method "patch" :body {:body new-body}}]}))]
    (is (= 200 (:status res)))
    (is (= [true] calls))
    (is (= (snapshot twin) (snapshot ctx)))))

(deftest a-save-the-plan-refuses-is-refused
  (let [ctx (setup "Refused")
        res (api-call admin-request {:method :patch
                                     :path (str "/api/v1/texts/" (:text ctx))
                                     :body {:body (str "a" (char 0) "b")}})]
    (is (= 400 (:status res)))
    (is (= old-body (-> (get-text admin-request (:text ctx)) :body :text/body)))))
