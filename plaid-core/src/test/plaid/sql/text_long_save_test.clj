(ns plaid.sql.text-long-save-test
  "A body save that changes every word of a long text, through PATCH /texts.

  Editscript's character diff gave up after 1,000 ms and returned the new
  text whole. The save then deleted the whole body and inserted the new one,
  which deleted every token with its spans, and answered 200. It happened
  from about 2,000 words when every word changed, and sooner on a busy
  server. Here editscript's clock moves 10 s at every look, so the old diff
  gives up on every stretch however fast the machine."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler admin-request api-call
                                    assert-created assert-ok with-admin with-clean-db]]
            [plaid.test-helpers :refer :all]
            [plaid.util.codepoint :as cp]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- slow-clock []
  (let [t (atom 0)]
    (fn ^long [] (swap! t + 10000))))

(defn- layers [doc]
  (->> (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc "?include-body=true")})
       :body :document/text-layers
       (mapcat :text-layer/token-layers)))

(deftest a-save-changing-every-word-of-3000-keeps-every-token-and-span
  (let [vocab ["the" "cat" "sat" "on" "a" "mat" "with" "tat" "kaki" "dog"
               "told" "me" "then" "we" "left" "at" "noon" "ab" "é" "to"]
        words (mapv #(nth vocab (mod (* 7 %) (count vocab))) (range 3000))
        sentences (partition-all 15 words)
        line (fn [ws] (str (str/join " " ws) ".\n"))
        old (apply str (map line sentences))
        new (apply str (map (comp line #(map str/capitalize %)) sentences))
        proj (create-test-project admin-request "LongSaveProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        s-layer (-> (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"}) :body :id)
        w-layer (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"
                                                                       :parent-token-layer-id s-layer})
                    :body :id)
        glosses (-> (create-span-layer admin-request w-layer "Gloss") :body :id)
        text-id (-> (create-text admin-request tl doc old) :body :id)
        ;; word extents, in code points
        extents (loop [ss sentences p 0 out []]
                  (if-let [s (first ss)]
                    (let [[out p] (reduce (fn [[out p] w]
                                            (let [n (cp/cp-count w)] [(conj out [p (+ p n)]) (+ p n 1)]))
                                          [out p] s)]
                      (recur (rest ss) (inc p) out))
                    out))
        s-extents (loop [ss sentences p 0 out []]
                    (if-let [s (first ss)]
                      (let [n (cp/cp-count (line s))] (recur (rest ss) (+ p n) (conj out [p (+ p n)])))
                      out))
        _ (assert-created (bulk-create-tokens admin-request
                                              (mapv (fn [[b e]] {:token-layer-id s-layer :text text-id :begin b :end e})
                                                    s-extents)))
        w-ids (-> (bulk-create-tokens admin-request
                                      (mapv (fn [[b e]] {:token-layer-id w-layer :text text-id :begin b :end e})
                                            extents))
                  :body :ids)
        _ (assert-created (bulk-create-spans admin-request
                                             (mapv (fn [id] {:span-layer-id glosses :tokens [id] :value "gl"}) w-ids)))
        res (with-redefs [editscript.util.common/current-time (slow-clock)]
              (update-text admin-request text-id new))
        after (layers doc)
        by-id (fn [lid] (first (filter #(= lid (:token-layer/id %)) after)))
        w-tokens (:token-layer/tokens (by-id w-layer))
        spans (mapcat :span-layer/spans (:token-layer/span-layers (by-id w-layer)))]
    (assert-ok res)
    (is (= new (-> (get-text admin-request text-id) :body :text/body)))
    (is (= (count sentences) (count (:token-layer/tokens (by-id s-layer)))))
    (is (= 3000 (count w-tokens)))
    (is (= 3000 (count spans)))
    (is (= (set (map str w-ids)) (set (map (comp str :token/id) w-tokens))))
    ;; every word token reads its word, capitalized, where it was
    (is (= (mapv str/capitalize words)
           (mapv #(cp/cp-subs new (:token/begin %) (:token/end %)) (sort-by :token/begin w-tokens))))
    (is (= extents (mapv (juxt :token/begin :token/end) (sort-by :token/begin w-tokens))))))
