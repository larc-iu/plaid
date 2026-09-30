(ns plaid.rest-api.v1.text-edit-test
  "`PATCH /texts/:id` with `edits` and `base`: edits from the caret, the
  body's digest as a precondition, and the answer's `reshape`."
  (:require [clojure.data.json :as json]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [db rest-handler with-db with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-ok assert-created assert-bad-request assert-not-found
                                    with-admin with-test-users with-clean-db]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :refer :all]
            [plaid.util.digest :as digest]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- edit-text
  ([text-id body] (edit-text text-id body ""))
  ([text-id body query]
   (api-call admin-request {:method :patch :path (str "/api/v1/texts/" text-id query) :body body})))

(defn- ins [i v] {:type "insert" :index i :value v})
(defn- del [i n] {:type "delete" :index i :value n})

(defn- setup
  "A document with sentences, words, morphemes and glosses over `body`, the
  words at the runs without spaces, each word one morpheme."
  [body & {:keys [plain other]}]
  (let [proj (create-test-project admin-request "EditProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        sentences (-> (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"}) :body :id)
        words (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"
                                                                     :parent-token-layer-id sentences})
                  :body :id)
        morphemes (-> (create-token-layer-opts admin-request tl "Morphemes" {:parent-token-layer-id words}) :body :id)
        _ (when plain
            (doseq [l [words morphemes]]
              (assert-status 204 (api-call admin-request {:method :put
                                                          :path (str "/api/v1/token-layers/" l "/config/plaid/plainEdits")
                                                          :body true}))))
        others (when other
                 (-> (create-token-layer-opts admin-request tl "Other" {:overlap-mode "non-overlapping"
                                                                        :parent-token-layer-id sentences})
                     :body :id))
        glosses (-> (create-span-layer admin-request morphemes "Gloss") :body :id)
        text-id (-> (create-text admin-request tl doc body) :body :id)
        _ (assert-created (bulk-create-tokens admin-request [{:token-layer-id sentences :text text-id
                                                              :begin 0 :end (count body)}]))
        runs (let [m (re-matcher #"\S+" body)] (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out)))
        ws (mapv (fn [[b e]] (-> (create-token admin-request words text-id b e) :body :id)) runs)
        ms (mapv (fn [[b e]] (-> (create-token admin-request morphemes text-id b e) :body :id)) runs)
        gs (mapv (fn [m] (-> (create-span admin-request glosses [m] "G") :body :id)) ms)
        os (when others (mapv (fn [[b e]] (-> (create-token admin-request others text-id b e) :body :id)) runs))]
    {:doc doc :text text-id :words ws :morphemes ms :glosses gs :sentences sentences :others os}))

(defn- extent [id]
  (let [t (get-token admin-request id)]
    (when (= 200 (:status t)) ((juxt :token/begin :token/end :token/value) (:body t)))))

(deftest an-edit-answers-the-text-its-digest-and-what-it-reshaped
  (let [{:keys [text words morphemes glosses]} (setup "hh pumpkin cat")
        base (-> (get-text admin-request text) :body :text/digest)]
    (is (= (digest/text-digest "hh pumpkin cat") base))
    (testing "a word deleted whole"
      (let [res (edit-text text {:edits [(del 2 8)] :base base})
            body (:body res)]
        (assert-ok res)
        (is (= "hh cat" (:text/body body)))
        (is (= (digest/text-digest "hh cat") (:text/digest body)))
        (assert-not-found (get-token admin-request (words 1)))
        (assert-not-found (get-token admin-request (morphemes 1)))
        (assert-not-found (get-span admin-request (glosses 1)))
        (let [{:keys [tokens spans deleted]} (:reshape body)]
          (is (some #(= {:id (str (words 2)) :begin 3 :end 6} (update % :id str)) tokens) (pr-str tokens))
          (is (= #{(str (words 1)) (str (morphemes 1))} (set (map str (:tokens deleted)))))
          (is (= #{(str (glosses 1))} (set (map str (:spans deleted)))))
          (is (empty? spans)))))
    (testing "a stale base is 409 with the stored digest, and nothing is written"
      (let [res (edit-text text {:edits [(ins 0 "x")] :base base})]
        (assert-status 409 res)
        (is (true? (-> res :body :text-changed)))
        (is (= (digest/text-digest "hh cat") (-> res :body :digest)))
        (is (= "hh cat" (-> (get-text admin-request text) :body :text/body)))))
    (testing "without base the edit applies to what is stored"
      (assert-ok (edit-text text {:edits [(del 0 3)]}))
      (is (= "cat" (-> (get-text admin-request text) :body :text/body))))))

(deftest an-edit-is-refused-when-malformed
  (let [{:keys [text]} (setup "a b")]
    (assert-bad-request (edit-text text {:edits [(ins 9 "x")]}))
    (assert-bad-request (edit-text text {:edits [{:type "insert" :index 0}]}))
    (assert-bad-request (edit-text text {:edits "x"}))
    (assert-bad-request (edit-text text {:edits [] :body "x"}))
    (assert-bad-request (edit-text text {:edits [] :base 7}))
    (is (= "a b" (-> (get-text admin-request text) :body :text/body)))))

(deftest a-restating-edit-bumps-the-version-and-reads-as-a-body-save
  (let [{:keys [text doc]} (setup "a b")
        v (-> (get-document admin-request doc) :body :document/version)
        res (edit-text text {:edits [] :base (digest/text-digest "a b")} "?audit-message=Fixed%20a%20typo")]
    (assert-ok res)
    (is (= (inc v) (-> (get-document admin-request doc) :body :document/version)))
    (let [op (psc/q1 db {:select [:op_type :description] :from [:operations]
                         :where [:= :document_id (str doc)] :order-by [[:ts :desc]] :limit 1})]
      (is (= {:op_type "text/update-body" :description "Fixed a typo"} (select-keys op [:op_type :description]))))))

(deftest a-stale-document-version-is-honored
  (let [{:keys [text doc]} (setup "a b")
        v (-> (get-document admin-request doc) :body :document/version)
        res (edit-text text {:edits [(ins 0 "x")] :base (digest/text-digest "a b")}
                       (str "?document-version=" (dec v)))]
    (assert-status 409 res)
    (is (nil? (-> res :body :text-changed)))))

(deftest a-whole-body-save-takes-base-and-answers-reshape-too
  (let [{:keys [text words]} (setup "the cat sat")]
    (assert-status 409 (edit-text text {:body "the dog sat" :base "nope"}))
    (let [res (edit-text text {:body "the cats sat" :base (digest/text-digest "the cat sat")})]
      (assert-ok res)
      (is (some #{{:id (str (words 2)) :begin 9 :end 12}}
                (map #(update % :id str) (-> res :body :reshape :tokens)))))))

(deftest a-document-read-carries-the-digest
  (let [{:keys [text doc]} (setup "a b")
        read (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc "?include-body=true")})
        texts (for [tl (-> read :body :document/text-layers)] (:text-layer/text tl))]
    (assert-ok read)
    (is (= [(digest/text-digest "a b")] (map :text/digest texts)))
    (is (= text (:text/id (first texts))))))

(deftest reshape-is-what-a-fresh-read-shows
  ;; Over random edits, the answer's reshape patched onto the tokens read
  ;; before gives the tokens read after.
  (let [rng (java.util.Random. 7)
        {:keys [text doc]} (setup "the cat sat on a mat and the dog ran home")
        tokens-of (fn []
                    (let [read (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc "?include-body=true")})]
                      (into {}
                            (for [tl (-> read :body :document/text-layers)
                                  kl (:text-layer/token-layers tl)
                                  t (:token-layer/tokens kl)]
                              [(str (:token/id t)) [(:token/begin t) (:token/end t)]]))))]
    (dotimes [_ 200]
      (let [before (tokens-of)
            {body :text/body base :text/digest} (:body (get-text admin-request text))
            n (count body)
            pos (.nextInt rng (inc n))
            op (case (.nextInt rng 3)
                 0 (ins pos (rand-nth ["a" " " "xy z" "."]))
                 1 (del (min pos (max 0 (dec n))) (min 3 (- n (min pos (max 0 (dec n))))))
                 2 {:type "replace" :index (min pos n) :length (min 2 (- n (min pos n))) :value "Q"})
            res (edit-text text {:edits [op] :base base})
            _ (assert-ok res)
            {:keys [tokens deleted]} (-> res :body :reshape)
            patched (as-> before m
                      (apply dissoc m (map str (:tokens deleted)))
                      (reduce (fn [m {:keys [id begin end]}] (if (contains? m (str id)) (assoc m (str id) [begin end]) m))
                              m tokens))]
        (is (= (tokens-of) patched) (pr-str body op))))))

(deftest an-edit-in-a-batch-answers-its-digest-and-reshape
  ;; The edit and a token over the text it types, in one batch, the token
  ;; measured on the body the edit makes.
  (let [{:keys [text words]} (setup "the cat")
        layer (-> (get-token admin-request (words 0)) :body :token/layer)
        res (api-call admin-request {:method :post :path "/api/v1/batch"
                                     :body [{:path (str "/api/v1/texts/" text) :method "patch"
                                             :body {:edits [(ins 7 " sat")] :base (digest/text-digest "the cat")}}
                                            {:path "/api/v1/tokens/bulk" :method "post"
                                             :body [{:token-layer-id layer :text text :begin 8 :end 11}]}]})]
    (assert-ok res)
    (let [sub (-> res :body first :body)]
      (is (= (digest/text-digest "the cat sat") (:text/digest sub)))
      (is (map? (:reshape sub))))
    (is (= [4 7 "cat"] (extent (words 1))))
    (is (= "the cat sat" (-> (get-text admin-request text) :body :text/body)))))

(deftest an-edit-sent-again-with-its-idempotency-key-is-answered-once
  (let [{:keys [text]} (setup "the cat")
        send (fn []
               (let [resp (rest-handler (-> (admin-request :patch (str "/api/v1/texts/" text))
                                            (mock/header "accept" "application/json")
                                            (mock/header "Idempotency-Key" "01a0f0ac-0000-7000-8000-000000000001")
                                            (mock/json-body {:edits [(ins 7 "s")] :base (digest/text-digest "the cat")})))]
                 {:status (:status resp)
                  :headers (:headers resp)
                  :body (let [b (:body resp)] (json/read-str (if (string? b) b (slurp b)) :key-fn keyword))}))
        first-answer (send)
        again (send)]
    (is (= 200 (:status first-answer)))
    (is (= 200 (:status again)))
    (is (= (:body first-answer) (:body again)))
    (is (= "the cats" (-> (get-text admin-request text) :body :text/body)))))

(deftest the-answer-is-the-body-the-save-wrote
  ;; R16: a read after the commit could hold another save's body next to this
  ;; save's reshape. The answer's body and digest are the ones written.
  (let [{:keys [text]} (setup "the cat")
        real-get plaid.sql.text/get
        res (with-redefs [plaid.sql.text/get (fn [db id]
                                               (assoc (real-get db id) :text/body "someone else's"))]
              (edit-text text {:edits [(ins 7 "s")] :base (digest/text-digest "the cat")}))]
    (assert-ok res)
    (is (= "the cats" (-> res :body :text/body)))
    (is (= (digest/text-digest "the cats") (-> res :body :text/digest)))))

(deftest reshape-carries-a-trimmed-spans-value
  ;; R14: a span in the reshape comes with its value, so a page shows a value
  ;; a layer rule's remedy rewrote.
  (let [proj (create-test-project admin-request "SpanValueProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        words (-> (create-token-layer admin-request tl "W") :body :id)
        sl (-> (create-span-layer admin-request words "S") :body :id)
        text (-> (create-text admin-request tl doc "ab cd") :body :id)
        a (-> (create-token admin-request words text 0 2) :body :id)
        c (-> (create-token admin-request words text 3 5) :body :id)
        _ (assert-created (create-span admin-request sl [a c] "BOTH"))
        res (edit-text text {:edits [(del 0 3)] :base (digest/text-digest "ab cd")})
        spans (-> res :body :reshape :spans)]
    (assert-ok res)
    (is (= [{:tokens [(str c)] :value "BOTH"}] (map #(-> % (dissoc :id) (update :tokens (partial mapv str))) spans)))))

(deftest a-plain-layer-takes-an-edit-the-plain-way
  ;; Luke, 2026-09-30: an edit inside a word or touching it with no
  ;; whitespace grows or shrinks it, and nothing else happens to it. A layer
  ;; without the key keeps the other rules.
  (let [{:keys [text words morphemes glosses others]} (setup "the cat sat" :plain true :other true)
        digest-of #(-> (get-text admin-request text) :body :text/digest)
        all-there (fn [ids] (every? #(= 200 (:status (get-span admin-request %))) ids))]
    (testing "a space typed inside a word"
      (assert-ok (edit-text text {:edits [(ins 5 " ")] :base (digest-of)}))
      (is (= [4 8 "c at"] (extent (words 1))))
      (is (= [4 8 "c at"] (extent (morphemes 1))))
      (is (all-there glosses))
      (is (contains? #{[4 5 "c"] [6 8 "at"]} (extent (others 1)))))
    (testing "a whole-body save deleting a space and typing at a word's end"
      (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/texts/" text) :body {:body "thec at sats"}}))
      (is (= [[0 3 "the"] [3 7 "c at"] [8 12 "sats"]] (map extent words)))
      (is (= [[0 3 "the"] [3 7 "c at"] [8 12 "sats"]] (map extent morphemes)))
      (is (all-there glosses)))
    (testing "a word deleted whole goes with its morpheme and gloss"
      (let [res (edit-text text {:edits [(del 7 5)] :base (digest-of)})]
        (assert-ok res)
        (is (= "thec at" (-> res :body :text/body)))
        (assert-not-found (get-token admin-request (words 2)))
        (assert-not-found (get-token admin-request (morphemes 2)))
        (assert-not-found (get-span admin-request (glosses 2)))
        (is (all-there (take 2 glosses)))))))
