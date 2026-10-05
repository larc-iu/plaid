(ns plaid.rest-api.v1.split-keep-right-test
  "A token split with `keep` \"right\": the original token (its id, spans,
  comments and metadata) becomes the right half and the new token the left.
  For new text put in front of a token's own, such as a transcription
  inserted before a sentence: the sentence's translation and comments stay
  on its own text (REV-ASR R1)."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request api-call assert-created assert-ok
                                    with-admin with-test-users with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- token-row [id]
  (:body (api-call admin-request {:method :get :path (str "/api/v1/tokens/" id)})))

(defn- split [id position body]
  (api-call admin-request {:method :post
                           :path (str "/api/v1/tokens/" id "/split")
                           :body (merge {:position position} body)}))

(defn- setup
  "`new old`, a partitioning sentence layer with one sentence over it, a word
  layer under it with `new` and `old`, a translation span and a comment on
  the sentence, and metadata on it."
  []
  (let [proj (create-test-project admin-request "KeepRight")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        txt (-> (create-text admin-request tl doc "new old") :body :id)
        sl (-> (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"}) :body :id)
        wl (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"
                                                                  :parent-token-layer-id sl}) :body :id)
        sent (-> (api-call admin-request {:method :post :path "/api/v1/tokens/bulk"
                                          :body [{:token-layer-id sl :text txt :begin 0 :end 7}]})
                 :body :ids first)
        w-new (-> (create-token admin-request wl txt 0 3) :body :id)
        w-old (-> (create-token admin-request wl txt 4 7) :body :id)
        trans-layer (-> (create-span-layer admin-request sl "Translation") :body :id)
        span (-> (create-span admin-request trans-layer [sent] "OLD TRANSLATION") :body :id)
        _comment (-> (api-call admin-request {:method :post :path "/api/v1/comments"
                                              :body {:entity-type "token" :entity-id sent :body "a note"}})
                     :body :id)]
    (api-call admin-request {:method :put :path (str "/api/v1/tokens/" sent "/metadata") :body {"note" "kept"}})
    {:proj proj :doc doc :sent sent :span span :w-new w-new :w-old w-old}))

(deftest keep-right-keeps-the-original-on-the-right-half
  (let [{:keys [proj sent span w-new w-old]} (setup)
        res (split sent 3 {:keep "right"})
        left (-> res :body :id)]
    (assert-created res)
    ;; The original is the right half, `old`, with its metadata.
    (is (= [3 7] ((juxt :token/begin :token/end) (token-row sent))))
    (is (= {"note" "kept"} (:metadata (token-row sent))))
    ;; The new token is the left half, `new`, bare.
    (is (= [0 3] ((juxt :token/begin :token/end) (token-row left))))
    (is (empty? (:metadata (token-row left))))
    ;; The translation and the comment stay on the original.
    (is (= [sent] (:span/tokens (:body (api-call admin-request {:method :get :path (str "/api/v1/spans/" span)})))))
    (is (= [(str sent)] (->> (api-call admin-request {:method :get :path (str "/api/v1/projects/" proj "/comments")})
                             :body :entries (filter #(= "a note" (:comment/body %)))
                             (map (comp str :comment/entity-id)))))
    ;; The words are untouched.
    (is (= [0 3] ((juxt :token/begin :token/end) (token-row w-new))))
    (is (= [4 7] ((juxt :token/begin :token/end) (token-row w-old))))))

(deftest keep-right-names-the-left-half-with-the-id-given
  (let [{:keys [sent]} (setup)
        id "01a10000-0000-7000-8000-00000000abcd"
        res (split sent 3 {:keep "right" :id id})]
    (assert-created res)
    (is (= id (str (-> res :body :id))))
    (is (= [0 3] ((juxt :token/begin :token/end) (token-row id))))))

(deftest keep-left-is-the-default-and-unchanged
  (let [{:keys [sent span]} (setup)
        right (-> (split sent 3 {:keep "left"}) :body :id)]
    (is (= [0 3] ((juxt :token/begin :token/end) (token-row sent))))
    (is (= [3 7] ((juxt :token/begin :token/end) (token-row right))))
    (is (= [sent] (:span/tokens (:body (api-call admin-request {:method :get :path (str "/api/v1/spans/" span)})))))))

(deftest keep-right-goes-through-a-batch
  (let [{:keys [sent]} (setup)
        res (api-call admin-request {:method :post :path "/api/v1/batch"
                                     :body [{:method "post" :path (str "/api/v1/tokens/" sent "/split")
                                             :body {:position 3 :keep "right"}}]})]
    (assert-ok res)
    (is (= [3 7] ((juxt :token/begin :token/end) (token-row sent))))))

(deftest an-unknown-keep-is-refused
  (let [{:keys [sent]} (setup)]
    (is (= 400 (:status (split sent 3 {:keep "middle"}))))
    (is (= [0 7] ((juxt :token/begin :token/end) (token-row sent))))))

(defn- glossed-word
  "`alphabeta`, a word with a gloss, and one morpheme over it with a gloss
  of its own, on a morpheme layer nested under the words."
  []
  (let [proj (create-test-project admin-request "KeepRightWord")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        txt (-> (create-text admin-request tl doc "alphabeta") :body :id)
        wl (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
        ml (-> (create-token-layer-opts admin-request tl "Morphemes" {:overlap-mode "any"
                                                                      :parent-token-layer-id wl}) :body :id)
        word (-> (create-token admin-request wl txt 0 9) :body :id)
        morph (-> (create-token admin-request ml txt 0 9) :body :id)
        wg (-> (create-span-layer admin-request wl "Gloss") :body :id)
        mg (-> (create-span-layer admin-request ml "Gloss") :body :id)
        wspan (-> (create-span admin-request wg [word] "ALPHABETA") :body :id)
        mspan (-> (create-span admin-request mg [morph] "m-alphabeta") :body :id)]
    {:word word :morph morph :wspan wspan :mspan mspan}))

(defn- span-tokens [id]
  (:span/tokens (:body (api-call admin-request {:method :get :path (str "/api/v1/spans/" id)}))))

(deftest keep-right-takes-a-split-words-morphemes-to-the-same-side
  ;; REV-ASR R6: the word's gloss went right while its morpheme's stayed left.
  (let [{:keys [word morph wspan mspan]} (glossed-word)]
    (assert-created (split word 5 {:keep "right"}))
    (is (= [5 9] ((juxt :token/begin :token/end) (token-row word))))
    (is (= [5 9] ((juxt :token/begin :token/end) (token-row morph))))
    (is (= [word] (span-tokens wspan)))
    (is (= [morph] (span-tokens mspan)))))

(deftest keep-left-takes-a-split-words-morphemes-left-as-before
  (let [{:keys [word morph mspan]} (glossed-word)]
    (assert-created (split word 5 {}))
    (is (= [0 5] ((juxt :token/begin :token/end) (token-row word))))
    (is (= [0 5] ((juxt :token/begin :token/end) (token-row morph))))
    (is (= [morph] (span-tokens mspan)))))
