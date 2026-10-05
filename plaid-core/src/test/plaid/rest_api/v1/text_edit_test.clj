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
            [plaid.algos.text]
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
  [body & {:keys [other nodes runs split sents]}]
  (let [proj (create-test-project admin-request "EditProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        sentences (-> (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"}) :body :id)
        words (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"
                                                                     :parent-token-layer-id sentences})
                  :body :id)
        morphemes (-> (create-token-layer-opts admin-request tl "Morphemes" {:parent-token-layer-id words}) :body :id)
        _ (when split
            (assert-status 204 (api-call admin-request {:method :put
                                                        :path (str "/api/v1/token-layers/" words "/config/plaid/splitOnSpace")
                                                        :body true})))
        ;; another app's layer: beside the words, or (`:child`) nested under them
        others (when other
                 (-> (create-token-layer-opts admin-request tl "Other" {:overlap-mode "non-overlapping"
                                                                        :parent-token-layer-id (if (= other :child) words sentences)})
                     :body :id))
        glosses (-> (create-span-layer admin-request morphemes "Gloss") :body :id)
        text-id (-> (create-text admin-request tl doc body) :body :id)
        _ (assert-created (bulk-create-tokens admin-request (mapv (fn [[b e]] {:token-layer-id sentences :text text-id
                                                                               :begin b :end e})
                                                                  (or sents [[0 (count body)]]))))
        runs (if (= runs :chars)
               (mapv (fn [i] [i (inc i)]) (range (count body)))
               (let [m (re-matcher #"\S+" body)] (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out))))
        ws (mapv (fn [[b e]] (-> (create-token admin-request words text-id b e) :body :id)) runs)
        ms (mapv (fn [[b e]] (-> (create-token admin-request morphemes text-id b e) :body :id)) runs)
        gs (mapv (fn [m] (-> (create-span admin-request glosses [m] "G") :body :id)) ms)
        os (when others (mapv (fn [[b e]] (-> (create-token admin-request others text-id b e) :body :id)) runs))
        ;; UMR's nodes: a layer beside the words, overlap allowed, no parent
        node-layer (when nodes
                     (-> (create-token-layer-opts admin-request tl "Nodes" {:overlap-mode "any"}) :body :id))
        ns (when node-layer (mapv (fn [[b e]] (-> (create-token admin-request node-layer text-id b e) :body :id)) runs))]
    {:doc doc :text text-id :words ws :morphemes ms :glosses gs :sentences sentences :others os :nodes ns
     :node-layer node-layer :layers {:text tl :words words :morphemes morphemes :glosses glosses}}))

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
    (assert-bad-request (edit-text text {:edits [{:type "insert" :index 0 :value "x" :side "left"}]}))
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

(deftest a-layer-beside-the-words-takes-an-edit-the-plain-way-too
  ;; Luke, 2026-09-30: an edit inside a word or touching it with no
  ;; whitespace grows or shrinks it, and nothing else happens to it. Another
  ;; app's word layer on the same text takes it the same way.
  (let [{:keys [text words morphemes glosses others]} (setup "the cat sat" :other true)
        digest-of #(-> (get-text admin-request text) :body :text/digest)
        all-there (fn [ids] (every? #(= 200 (:status (get-span admin-request %))) ids))]
    (testing "a space typed inside a word"
      (assert-ok (edit-text text {:edits [(ins 5 " ")] :base (digest-of)}))
      (is (= [4 8 "c at"] (extent (words 1))))
      (is (= [4 8 "c at"] (extent (morphemes 1))))
      (is (all-there glosses))
      (is (= [4 8 "c at"] (extent (others 1)))))
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

(deftest a-layer-under-the-words-follows-them
  ;; H1: igt and ud on one project. ud's syntactic words nest under the words with a coextensive rule. An edit must move them
  ;; with their word, never delete them for not matching it.
  (let [{:keys [text words others]} (setup "dog cat eel" :other :child)
        syn others
        lemma (-> (create-span-layer admin-request (first (map #(:token/layer (:body (get-token admin-request %))) syn)) "Lemma")
                  :body :id)
        lemmas (mapv (fn [s w] (-> (create-span admin-request lemma [s] w) :body :id)) syn ["DOG" "CAT" "EEL"])
        layer-of (:token/layer (:body (get-token admin-request (first syn))))
        _ (assert-status 200 (api-call admin-request {:method :put :path (str "/api/v1/token-layers/" layer-of "/constraints/ud")
                                                      :body {:constraints [{:type "coextensive"}]}}))
        digest-of #(-> (get-text admin-request text) :body :text/digest)
        all-there (fn [ids] (every? #(= 200 (:status (get-span admin-request %))) ids))]
    (testing "a letter typed at a word's end"
      (assert-ok (edit-text text {:edits [(ins 3 "s")] :base (digest-of)}))
      (is (= [0 4 "dogs"] (extent (words 0)) (extent (syn 0))))
      (is (all-there lemmas)))
    (testing "a space typed inside a word"
      (assert-ok (edit-text text {:edits [(ins 6 " ")] :base (digest-of)}))
      (is (= [5 9 "c at"] (extent (words 1)) (extent (syn 1))))
      (is (all-there lemmas)))
    (testing "a whole-body save"
      (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/texts/" text) :body {:body "dogsc at eels"}}))
      (is (= [[0 4 "dogs"] [4 8 "c at"] [9 13 "eels"]] (map extent words) (map extent syn)))
      (is (all-there lemmas)))))

(deftest nodes-beside-the-words-follow-the-words
  ;; UMR's node layer beside the words: the words decide and each node stays
  ;; on its word.
  (let [{:keys [text words nodes]} (setup "dog cat eel" :nodes true)
        digest-of #(-> (get-text admin-request text) :body :text/digest)]
    (testing "a letter typed at a word's end"
      (assert-ok (edit-text text {:edits [(ins 3 "s")] :base (digest-of)}))
      (is (= [0 4 "dogs"] (extent (words 0)) (extent (nodes 0)))))
    (testing "a space typed inside a word"
      (assert-ok (edit-text text {:edits [(ins 6 " ")] :base (digest-of)}))
      (is (= [5 9 "c at"] (extent (words 1)) (extent (nodes 1)))))
    (testing "a stretch over two words typed over"
      (assert-ok (edit-text text {:edits [{:type "replace" :index 3 :length 3 :value "X"}] :base (digest-of)}))
      (is (= "dogX at eel" (-> (get-text admin-request text) :body :text/body)))
      (is (= [0 4 "dogX"] (extent (words 0)) (extent (nodes 0))))
      (is (= [5 7 "at"] (extent (words 1)) (extent (nodes 1)))))))

(deftest nodes-beside-the-words-take-their-words-outcome
  ;; A node layer beside the words (a UMR-only text, or ud and UMR on one
  ;; text): a node never differs from its word.
  (doseq [[label body edit child] [["a letter typed after `200`" "200 dollars" (ins 3 "x") false]
                                   ["a letter typed after `就` in a text without spaces" "他就去" (ins 2 "x") false]
                                   ["a space typed inside a word" "dog cat eel" (ins 5 " ") false]
                                   ["a stretch over two words typed over" "dog cat eel" {:type "replace" :index 2 :length 3 :value "X"} false]
                                   ["ud's syntactic words under the words" "dog cat eel" (ins 3 "s") true]]]
    (testing label
      (let [{:keys [text words nodes node-layer]} (setup body :nodes true :other (when child :child) :runs (when (= body "他就去") :chars))
            over (when (< 1 (count words))
                   (-> (create-token admin-request node-layer text
                                     (first (extent (words 0))) (second (extent (words 1))))
                       :body :id))
            base (-> (get-text admin-request text) :body :text/digest)]
        (assert-ok (edit-text text {:edits [edit] :base base}))
        ;; a node whose word went (joined into another) keeps the letters it
        ;; has, as nothing goes unless all its letters do
        (doseq [[w n] (map vector words nodes)]
          (if (extent w)
            (is (= (extent w) (extent n)) (str label ": word " (extent w) " node " (extent n)))
            (is (some? (extent n)) (str label ": the node of a word joined into another is kept"))))
        (when (and over (extent (words 0)) (extent (words 1)))
          (is (= [(first (extent (words 0))) (second (extent (words 1)))] (take 2 (extent over)))
              (str label ": a node over two words")))))))

(deftest a-word-layer-that-splits-on-space
  ;; ud (Luke, 2026-09-30): the plain rule, but a space typed inside a word
  ;; splits it, the word and what is as long as it going on the half sharing
  ;; more letters (`split-spaced-words`), the other half a word of its own (2026-10-02). F1:
  ;; `walkdd`, Backspace, ` home` keeps the analysis.
  (let [{:keys [text words others]} (setup "a walkdd cat" :split true :other :child)
        digest-of #(-> (get-text admin-request text) :body :text/digest)]
    (testing "a letter deleted inside and a word typed after"
      (assert-ok (edit-text text {:edits [(del 7 1) (ins 7 " home")] :base (digest-of)}))
      (is (= "a walkd home cat" (-> (get-text admin-request text) :body :text/body)))
      (is (= [2 7 "walkd"] (extent (words 1)) (extent (others 1)))))
    (testing "a space typed inside a word splits it"
      (let [res (edit-text text {:edits [(ins 14 " ")] :base (digest-of)})
            made (filter :layer (-> res :body :reshape :tokens))]
        (assert-ok res)
        (is (= [15 17 "at"] (extent (words 2)) (extent (others 2))))
        ;; Q2-UD-POLISH-2: the other part is a word of its own, with a token
        ;; under it on each layer the word had one as long as it on
        (is (= 3 (count made) (count (distinct (map :layer made)))) "a word, a morpheme and the other layer's token")
        (is (every? #(= [13 14 "c"] (extent (:id %))) made))))
    (testing "a deleted space keeps both words"
      (assert-ok (edit-text text {:edits [(del 1 1)] :base (digest-of)}))
      (is (= [[0 1 "a"] [1 6 "walkd"]] [(extent (words 0)) (extent (words 1))])))))

(deftest a-split-word-keeps-its-morphemes-and-deals-out-only-syntactic-words
  ;; FX6-SPLIT (N1-CASCADE-5, 2026-10-06): a project whose word layer splits
  ;; on space, with a morpheme layer and a layer of role `syntactic-word`
  ;; under the words. A space typed inside `singers`, analysed as two
  ;; morphemes as long as it (si + ngers, each glossed), leaves both
  ;; morphemes and their glosses on `sing` and gives `ers` a new bare
  ;; morpheme and syntactic word. A multi-word token's two syntactic words
  ;; still go one to each part.
  (let [{:keys [text words morphemes glosses layers]} (setup "singers cant" :split true)
        {word-layer :words morph-layer :morphemes gloss-layer :glosses} layers
        sw (-> (create-token-layer-opts admin-request (:text layers) "Syntactic words" {:parent-token-layer-id word-layer})
               :body :id)
        _ (assert-status 204 (api-call admin-request {:method :put
                                                      :path (str "/api/v1/token-layers/" sw "/config/plaid/role")
                                                      :body "syntactic-word"}))
        ;; singers: a second morpheme as long as it, glossed
        ngers (-> (create-token admin-request morph-layer text 0 7 2) :body :id)
        ngers-gloss (-> (create-span admin-request gloss-layer [ngers] "G2") :body :id)
        sing-sw (-> (create-token admin-request sw text 0 7 0) :body :id)
        ;; cant: ca + nt
        ca (-> (create-token admin-request sw text 8 12 0) :body :id)
        nt (-> (create-token admin-request sw text 8 12 1) :body :id)
        digest-of #(-> (get-text admin-request text) :body :text/digest)
        made-of (fn [res] (->> (-> res :body :reshape :tokens) (filter :layer)
                               (map (fn [{:keys [id layer]}] [(str layer) (extent id)])) set))]
    (testing "singers: the morphemes stay on sing with their glosses"
      (let [res (edit-text text {:edits [(ins 4 " ")] :base (digest-of)})]
        (assert-ok res)
        (is (= "sing ers cant" (-> (get-text admin-request text) :body :text/body)))
        (is (= [0 4 "sing"] (extent (words 0)) (extent (morphemes 0)) (extent ngers) (extent sing-sw)))
        (is (= 200 (:status (get-span admin-request (glosses 0)))))
        (is (= 200 (:status (get-span admin-request ngers-gloss))))
        (is (= #{[(str word-layer) [5 8 "ers"]] [(str morph-layer) [5 8 "ers"]] [(str sw) [5 8 "ers"]]}
               (made-of res)))))
    (testing "cant: the syntactic words go one to each part, the morpheme stays with the word"
      (let [res (edit-text text {:edits [(ins 11 " ")] :base (digest-of)})]
        (assert-ok res)
        (is (= "sing ers ca nt" (-> (get-text admin-request text) :body :text/body)))
        (is (= [9 11 "ca"] (extent ca) (extent (words 1)) (extent (morphemes 1))))
        (is (= [12 14 "nt"] (extent nt)))
        (is (= #{[(str word-layer) [12 14 "nt"]] [(str morph-layer) [12 14 "nt"]]}
               (made-of res)))))))

(deftest a-node-is-never-deleted-while-its-word-stays
  ;; REV2 M3: `cat eel` typed over as `one`: a node goes only with its word.
  (let [{:keys [text words nodes]} (setup "dog cat eel fox." :nodes true)
        base (-> (get-text admin-request text) :body :text/digest)]
    (assert-ok (edit-text text {:edits [{:type "replace" :index 4 :length 7 :value "one"}] :base base}))
    (doseq [[w n] (map vector words nodes)]
      (when (extent w)
        (is (= (extent w) (extent n)) (str "word " (extent w) " node " (extent n)))))))

(deftest a-line-typed-before-the-first-sentence-is-a-sentence-of-its-own
  ;; REV3 N1: the first sentence keeps its id and what hangs off it, and the
  ;; answer names the sentence made
  (let [{:keys [text sentences]} (setup "Hi.\nThe end.")
        base (-> (get-text admin-request text) :body :text/digest)
        res (edit-text text {:edits [(ins 0 "Oh.\n")] :base base})
        sents (->> (psc/q db {:select [:id :begin :end_] :from [:tokens]
                              :where [:and [:= :text_id (str text)] [:= :token_layer_id (str sentences)]]})
                   (sort-by :begin))]
    (assert-ok res)
    (is (= [[0 4] [4 16]] (map (juxt :begin :end_) sents)))
    (is (some #(and (= (str (:id (first sents))) (str (:id %))) (= 0 (:begin %)) (some? (:layer %)))
              (-> res :body :reshape :tokens))
        (pr-str (-> res :body :reshape :tokens)))))

(deftest an-empty-segment-at-a-growing-rows-end-stays-at-its-end
  ;; REV4 R3: legacy data can hold an empty time-alignment segment at a row's
  ;; end; text typed there saves, and the empty segment stays at the row's end
  (let [{:keys [text]} (setup "Hi. The end.")
        tl (:text/layer (:body (get-text admin-request text)))
        rows (-> (create-token-layer-opts admin-request tl "Rows" {:overlap-mode "non-overlapping"}) :body :id)
        r1 (-> (create-token admin-request rows text 0 3) :body :id)
        empty (-> (create-token admin-request rows text 3 3) :body :id)
        r2 (-> (create-token admin-request rows text 4 12) :body :id)
        base (-> (get-text admin-request text) :body :text/digest)]
    (assert-ok (edit-text text {:edits [{:type "insert" :index 3 :value "x" :side "before"}] :base base}))
    (is (= [0 4 "Hi.x"] (extent r1)))
    (is (= [4 4 ""] (extent empty)))
    (is (= [5 13 "The end."] (extent r2)))))

(defn- rows-setup
  "igt's layers as its Media tab has them: sentences, words, morphemes
  under them with igt's rules, and rows beside them, a span
  on every token, and an empty row at each of `points` (legacy data)."
  [body sents words rows points]
  (let [proj (create-test-project admin-request "RowsProj")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        mk-layer (fn [n opts] (-> (create-token-layer-opts admin-request tl n opts) :body :id))
        s (mk-layer "Sentences" {:overlap-mode "partitioning"})
        w (mk-layer "Words" {:overlap-mode "non-overlapping" :parent-token-layer-id s})
        m (mk-layer "Morphemes" {:overlap-mode "any" :parent-token-layer-id w})
        a (mk-layer "Rows" {:overlap-mode "non-overlapping"})
        sl (into {} (map (fn [l] [l (-> (create-span-layer admin-request l "V") :body :id)])) [s w m a])
        _ (assert-status 200 (api-call admin-request {:method :put :path (str "/api/v1/token-layers/" m "/constraints/igt")
                                                      :body {:constraints [{:type "coextensive"} {:type "single-link"}]}}))
        doc (create-test-document admin-request proj "Doc")
        text (-> (create-text admin-request tl doc body) :body :id)
        _ (assert-created (bulk-create-tokens admin-request (mapv (fn [[b e]] {:token-layer-id s :text text :begin b :end e}) sents)))
        mk (fn [l b e] (let [t (-> (create-token admin-request l text b e) :body :id)]
                         (create-span admin-request (sl l) [t] "V")
                         t))
        _ (doseq [[b e] words] (mk w b e) (mk m b e))
        rs (mapv (fn [[b e]] (mk a b e)) rows)
        ps (mapv (fn [p] (-> (create-token admin-request a text p p) :body :id)) points)]
    {:text text :rows rs :points ps}))

(deftest an-empty-row-in-whitespace-after-a-row-saves
  ;; REV5 L3, answered 409 until REV-r4d: legacy data with an empty row
  ;; inside the whitespace after a row, text typed there. The row takes the
  ;; text as its sentence does and the empty row goes to its end.
  (let [{:keys [text rows points]} (rows-setup "Hi.  Yo. End." [[0 5] [5 9] [9 13]] [[0 3] [5 8] [9 13]]
                                               [[0 3] [5 8] [9 13]] [4])
        r (edit-text text {:edits [(ins 4 "x")]})]
    (is (= 200 (:status r)) (pr-str (:body r)))
    (is (= "Hi. x Yo. End." (:text/body (:body r))))
    (is (= [[0 5] [6 9] [10 14]] (map #(take 2 (extent %)) rows)))
    (is (= [5 5] (take 2 (extent (first points)))))))

(deftest an-overlap-refusal-names-the-layer
  ;; REV5 L3: should a rule ever leave two rows over the same text (here the
  ;; step that keeps an empty row at a row's edge is taken away), the save
  ;; is refused with a 409 naming the layer by its name
  (let [{:keys [text]} (rows-setup "Hi.  Yo. End." [[0 5] [5 9] [9 13]] [[0 3] [5 8] [9 13]]
                                   [[0 3] [5 8] [9 13]] [4])
        r (with-redefs [plaid.algos.text/pin-points-to-edges (fn [_ _ points] points)]
            (edit-text text {:edits [(ins 4 "x")]}))]
    (is (= 409 (:status r)))
    (is (re-find #"layer \"Rows\"" (str (:error (:body r)))) (pr-str (:body r)))
    (is (not (re-find #"[0-9a-f]{8}-[0-9a-f]{4}-" (str (:body r)))) (pr-str (:body r)))))

(deftest an-empty-row-at-a-rows-edge-and-text-typed-there-saves
  ;; REV-r4d: an empty time-alignment row at the end of a row and text typed
  ;; at that point with no `side` answered 500 "The new body could not be
  ;; applied." (the row grew over the empty row)
  (doseq [[at op want] [[3 (ins 3 " Oh") [6 6]] [3 (ins 3 "x") [4 4]] [12 (ins 12 " Oh") [15 15]]]]
    (testing (pr-str at op)
      (let [{:keys [text points]} (rows-setup "Hi. The end." [[0 4] [4 12]] [[0 3] [4 7] [8 12]] [[0 3] [4 12]] [at])
            r (edit-text text {:edits [op]})]
        (is (= 200 (:status r)) (pr-str (:body r)))
        (is (= want (take 2 (extent (first points)))))))))

(deftest an-empty-row-a-row-that-follows-its-sentence-grows-over-saves
  ;; REV-r4d oracle: a row over its sentence follows the sentence, which can
  ;; take text before an empty row that stood apart from the row, not at its
  ;; edge. The empty row goes to the row's edge on the side it stood, where
  ;; it answered 409 for two rows over the same text.
  (let [{:keys [text rows points]} (rows-setup "mat\nكتاب tat" [[0 4] [4 9] [9 12]] [[0 3] [4 8] [9 12]]
                                               [[0 3] [4 8] [9 12]] [8])
        r (api-call admin-request {:method :patch :path (str "/api/v1/texts/" text) :body {:body "XZ XZ XZ"}})]
    (is (= 200 (:status r)) (pr-str (:body r)))
    ;; `mat` and `tat` are typed over as words of their own (REV-one-rule
    ;; F1), and the row over the last sentence follows it
    (is (= [3 8] (take 2 (extent (peek rows)))))
    (is (= [2 2] (take 2 (extent (first points)))))))

(deftest every-layer-takes-an-edit-the-plain-way-with-no-key
  ;; One rule set (Luke, 2026-10-01): a layer whose config says nothing about
  ;; edits takes them the plain way, as igt's, ud's and UMR's layers do.
  (doseq [[label body edit want] [["a space typed inside a word" "the cat sat" (ins 5 " ") [4 8 "c at"]]
                                  ["a letter typed at a word's end" "the cat sat" (ins 7 "s") [4 8 "cats"]]
                                  ["a deleted space" "the cat sat" (del 7 1) [4 7 "cat"]]]]
    (testing label
      (let [{:keys [text words morphemes glosses]} (setup body)
            base (-> (get-text admin-request text) :body :text/digest)]
        (assert-ok (edit-text text {:edits [edit] :base base}))
        (is (= want (extent (words 1)) (extent (morphemes 1))))
        (is (every? #(= 200 (:status (get-span admin-request %))) glosses))))))

(deftest a-whole-body-save-takes-the-plain-way-with-no-key
  (let [{:keys [text words morphemes glosses]} (setup "the cat sat")]
    (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/texts/" text) :body {:body "the c at sats"}}))
    (is (= [[0 3 "the"] [4 8 "c at"] [9 13 "sats"]] (map extent words) (map extent morphemes)))
    (is (every? #(= 200 (:status (get-span admin-request %))) glosses))))

(deftest a-plain-api-clients-layers-take-the-plain-way
  ;; a layer made by a script: one root layer, no parent, no partition, no config
  (let [proj (create-test-project admin-request "ApiProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        toks (-> (create-token-layer admin-request tl "Tokens") :body :id)
        text (-> (create-text admin-request tl doc "the cat sat") :body :id)
        ts (mapv (fn [[b e]] (-> (create-token admin-request toks text b e) :body :id)) [[0 3] [4 7] [8 11]])]
    (assert-ok (edit-text text {:edits [(ins 5 " ") (ins 12 "s")] :base (digest/text-digest "the cat sat")}))
    (is (= [[0 3 "the"] [4 8 "c at"] [9 13 "sats"]] (map extent ts)))
    (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/texts/" text) :body {:body "the c atsats"}}))
    (is (= [[0 3 "the"] [4 8 "c at"] [8 12 "sats"]] (map extent ts)))))

(deftest umr-only-words-and-nodes-take-the-plain-way
  ;; UMR's own words (no key) and its nodes beside them: the words decide,
  ;; each node keeps to its word, on both paths
  (let [{:keys [text words nodes]} (setup "dog cat eel" :nodes true)
        digest-of #(-> (get-text admin-request text) :body :text/digest)]
    (assert-ok (edit-text text {:edits [(ins 5 " ")] :base (digest-of)}))
    (is (= [4 8 "c at"] (extent (words 1)) (extent (nodes 1))))
    (assert-ok (api-call admin-request {:method :patch :path (str "/api/v1/texts/" text) :body {:body "dogs c at eel"}}))
    (is (= [[0 4 "dogs"] [5 9 "c at"] [10 13 "eel"]] (map extent words) (map extent nodes)))))

(deftest words-typed-over-as-words-each-keep-their-token
  ;; REV-one-rule F1 (Luke, 2026-09-21: a replaced word keeps its
  ;; annotations): a stretch of whole words typed over as words of its own is
  ;; each word typed over, on both paths. With fewer new words than old, the
  ;; last new word goes to the old word sharing most letters with it.
  (testing "`不 大` typed over as `x y`"
    (let [{:keys [text words nodes]} (setup "我 不 大 好 。" :nodes true)
          base (-> (get-text admin-request text) :body :text/digest)]
      (assert-ok (edit-text text {:edits [{:type "replace" :index 2 :length 3 :value "x y"}] :base base}))
      (is (= [[0 1 "我"] [2 3 "x"] [4 5 "y"] [6 7 "好"] [8 9 "。"]] (map extent words) (map extent nodes)))))
  (testing "and as a whole body"
    (let [{:keys [text words nodes]} (setup "我 不 大 好 。" :nodes true)]
      (assert-ok (edit-text text {:body "我 x y 好 。"}))
      (is (= [[0 1 "我"] [2 3 "x"] [4 5 "y"] [6 7 "好"] [8 9 "。"]] (map extent words) (map extent nodes)))))
  (testing "`cat eel` typed over as `one` keeps `eel` and its node, a relation on it kept"
    (let [{:keys [text words nodes node-layer]} (setup "dog cat eel fox." :nodes true)
          sl (-> (create-span-layer admin-request node-layer "Concept") :body :id)
          rl (-> (create-relation-layer admin-request sl "Edges") :body :id)
          [sd _ se] (mapv (fn [n] (-> (create-span admin-request sl [n] "C") :body :id)) (take 3 nodes))
          rel (-> (create-relation admin-request rl se sd "ARG0") :body :id)
          base (-> (get-text admin-request text) :body :text/digest)]
      (assert-ok (edit-text text {:edits [{:type "replace" :index 4 :length 7 :value "one"}] :base base}))
      (is (= "dog one fox." (-> (get-text admin-request text) :body :text/body)))
      (is (nil? (extent (words 1))))
      (is (= [4 7 "one"] (extent (words 2)) (extent (nodes 2))))
      (assert-ok (get-relation admin-request rel)))))

(deftest a-root-word-layer-with-a-layer-under-it-decides
  ;; REV-one-rule F6: words a script made on a root layer, morphemes on a
  ;; layer that forbids overlap under them. The words decide, so a word with
  ;; no morphemes grows at its edge, and the morphemes follow their words.
  (let [proj (create-test-project admin-request "RootWordsProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        s (-> (create-token-layer-opts admin-request tl "S" {:overlap-mode "partitioning"}) :body :id)
        w (-> (create-token-layer-opts admin-request tl "W" {:overlap-mode "non-overlapping"}) :body :id)
        m (-> (create-token-layer-opts admin-request tl "M" {:overlap-mode "non-overlapping" :parent-token-layer-id w}) :body :id)
        text (-> (create-text admin-request tl doc "the dogs ran. cat sat.") :body :id)
        _ (assert-created (bulk-create-tokens admin-request [{:token-layer-id s :text text :begin 0 :end 14}
                                                             {:token-layer-id s :text text :begin 14 :end 22}]))
        ws (mapv (fn [[b e]] (-> (create-token admin-request w text b e) :body :id)) [[0 3] [4 8] [9 13] [14 17] [18 22]])
        ms (mapv (fn [[b e]] (-> (create-token admin-request m text b e) :body :id)) [[4 7] [7 8]])
        base (digest/text-digest "the dogs ran. cat sat.")]
    (assert-ok (edit-text text {:edits [(ins 3 "x") (ins 9 "x") (ins 16 "x")] :base base}))
    (is (= [[0 4 "thex"] [5 10 "dogsx"] [11 15 "ran."] [16 20 "xcat"] [21 25 "sat."]] (map extent ws)))
    (is (= [[5 8 "dog"] [8 10 "sx"]] (map extent ms)))))

(deftest a-head-sentence-is-made-only-on-the-words-partition
  ;; REV-one-rule F7: a document partition of one token beside the sentences
  ;; is never split by a line typed before the first sentence
  (let [{:keys [text sentences]} (setup "Hi.\nThe end." :sents [[0 4] [4 12]])
        tl (:text/layer (:body (get-text admin-request text)))
        dl (-> (create-token-layer-opts admin-request tl "Document" {:overlap-mode "partitioning"}) :body :id)
        _ (assert-created (bulk-create-tokens admin-request [{:token-layer-id dl :text text :begin 0 :end 12}]))
        layer-extents (fn [l] (->> (psc/q db {:select [:begin :end_] :from [:tokens]
                                              :where [:and [:= :text_id (str text)] [:= :token_layer_id (str l)]]})
                                   (map (juxt :begin :end_)) sort))]
    (assert-ok (edit-text text {:edits [(ins 0 "Oh.\n")] :base (digest/text-digest "Hi.\nThe end.")}))
    (is (= [[0 4] [4 8] [8 16]] (layer-extents sentences)))
    (is (= [[0 16]] (layer-extents dl)))))

(deftest a-whole-body-save-never-deletes-a-word-with-a-letter-left
  ;; REV2-one-rule G1: a body save that deletes the space or the sentence
  ;; break between two words, and letters beside it, keeps every word with a
  ;; letter left, as the same change sent as edits does
  (doseq [[old new sents want] [["who reported prior discrimination often." "who reportedimination often." nil
                                 [[0 3 "who"] [4 12 "reported"] nil [12 21 "imination"] [22 28 "often."]]]
                                ["xx yy abc.\ndefb. zz ww." "xx yy abfb. zz ww." [[0 11] [11 23]]
                                 [[0 2 "xx"] [3 5 "yy"] [6 8 "ab"] [8 11 "fb."] [12 14 "zz"] [15 18 "ww."]]]
                                ["人你大。\n见界小天。" "人你小天。" [[0 5] [5 10]]
                                 [[0 2 "人你"] [2 5 "小天。"]]]]]
    (testing (pr-str old)
      (let [{:keys [text words morphemes]} (setup old :sents (or sents [[0 (count old)]]))]
        (assert-ok (edit-text text {:body new}))
        (is (= new (-> (get-text admin-request text) :body :text/body)))
        (is (= want (map extent words)) (pr-str (map extent words)))
        (is (= (map extent words) (map extent morphemes)))))))

(deftest several-words-typed-over-as-one-keep-the-letters-left-of-each
  ;; `the area` typed over as `tlaak` is read as a whole-body save reads it
  ;; (REV-F-TEXT-CORE, one reading for a change over several words): its
  ;; diff keeps letters of both words, so neither goes (REV2-one-rule), and
  ;; each keeps its node. REV2-one-rule E1 had the edits path keep `area`
  ;; alone, on `tlaak`, and delete `the`.
  (let [{:keys [text words nodes]} (setup "see the area now" :nodes true)]
    (assert-ok (edit-text text {:edits [{:type "replace" :index 4 :length 8 :value "tlaak"}]
                                :base (digest/text-digest "see the area now")}))
    (is (= [4 6 "tl"] (extent (words 1)) (extent (nodes 1))))
    (is (= [6 9 "aak"] (extent (words 2)) (extent (nodes 2))))))
