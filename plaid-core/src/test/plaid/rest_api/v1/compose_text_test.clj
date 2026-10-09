(ns plaid.rest-api.v1.compose-text-test
  "Core stores all text composed (NFC, Luke 2026-10-09): every place text
  enters, a body with its token offsets, and what is left as sent."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [db rest-handler with-db with-mount-states with-rest-handler admin-request
                                    api-call assert-ok assert-created assert-status with-admin with-test-users
                                    with-clean-db]]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :refer [submit-operation!]]
            [plaid.test-helpers :refer :all]
            [plaid.util.digest :as digest]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private decomposed "pʰa\u0301")
(def ^:private composed "pʰá")

(defn- id-of [resp] (-> resp :body :id))

(defn- project-with-words
  "A project, a document, a text layer with a word layer (no overlap) and a
  morpheme layer under it, and a gloss span layer on the morphemes."
  []
  (let [proj (create-test-project admin-request "P")
        doc (create-test-document admin-request proj "D")
        tl (id-of (create-text-layer admin-request proj "T"))
        words (id-of (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}))
        morphs (id-of (create-token-layer-opts admin-request tl "Morphs" {:overlap-mode "non-overlapping"
                                                                          :parent-token-layer-id words}))
        gloss (id-of (create-span-layer admin-request morphs "Gloss"))]
    {:proj proj :doc doc :tl tl :words words :morphs morphs :gloss gloss}))

(defn- edit! [text-id body]
  (api-call admin-request {:method :patch :path (str "/api/v1/texts/" text-id) :body body}))

(defn- extent [id]
  (let [t (:body (get-token admin-request id))]
    [(:token/begin t) (:token/end t) (:token/value t)]))

(defn- body-of [text-id] (:text/body (:body (get-text admin-request text-id))))

(deftest a-text-is-created-composed
  (let [{:keys [doc tl words]} (project-with-words)
        text (id-of (create-text admin-request tl doc (str decomposed " ba\u0301")))]
    (is (= "pʰá bá" (body-of text)))
    (is (= "pʰá bá" (:body (psc/fetch-by-id db :texts text))))
    (testing "tokens are made on the stored body"
      (let [w (id-of (create-token admin-request words text 4 6))]
        (is (= [4 6 "bá"] (extent w)))))))

(deftest a-whole-body-save-is-composed-and-its-tokens-follow
  (let [{:keys [doc tl words]} (project-with-words)
        text (id-of (create-text admin-request tl doc "pʰa ba"))
        w1 (id-of (create-token admin-request words text 0 3))
        w2 (id-of (create-token admin-request words text 4 6))
        res (edit! text {:body (str decomposed " ba\u0301")})]
    (assert-ok res)
    (is (= "pʰá bá" (:text/body (:body res))))
    (is (= (digest/text-digest "pʰá bá") (:text/digest (:body res))))
    (is (= [0 3 composed] (extent w1)))
    (is (= [4 6 "bá"] (extent w2)))))

(deftest an-edit-that-composes-with-its-neighbour
  (let [{:keys [doc tl words morphs gloss]} (project-with-words)
        text (id-of (create-text admin-request tl doc "pʰa ba"))
        w1 (id-of (create-token admin-request words text 0 3))
        w2 (id-of (create-token admin-request words text 4 6))
        m1 (id-of (create-token admin-request morphs text 0 3))
        g1 (id-of (create-span admin-request gloss [m1] "G"))
        base (-> (get-text admin-request text) :body :text/digest)]
    (testing "a mark typed after the a at the end of the word becomes á in the word"
      (let [res (edit! text {:edits [{:type "insert" :index 3 :value "\u0301"}] :base base})]
        (assert-ok res)
        (is (= "pʰá ba" (:text/body (:body res))))
        (is (= (digest/text-digest "pʰá ba") (:text/digest (:body res))))
        (is (= [0 3 composed] (extent w1)))
        (is (= [0 3 composed] (extent m1)))
        (is (= [4 6 "ba"] (extent w2)))
        (assert-ok (get-span admin-request g1))
        (testing "the answer's digest is the base of the next edit"
          (let [res2 (edit! text {:edits [{:type "insert" :index 6 :value "\u0301"}]
                                  :base (:text/digest (:body res))})]
            (assert-ok res2)
            (is (= "pʰá bá" (:text/body (:body res2))))
            (is (= [4 6 "bá"] (extent w2)))))))
    (testing "a base digest of the decomposed body the editor holds is refused as a changed text"
      (let [res (edit! text {:edits [{:type "insert" :index 0 :value "x"}]
                             :base (digest/text-digest "pʰa\u0301 ba\u0301")})]
        (assert-status 409 res)
        (is (true? (:text-changed (:body res))))))))

(deftest an-edit-at-a-token-edge-keeps-the-composed-letter-with-its-token
  (let [{:keys [doc tl words morphs]} (project-with-words)
        ;; one word "tax", morphemes "ta" and "x" glued
        text (id-of (create-text admin-request tl doc "tax"))
        _w (id-of (create-token admin-request words text 0 3))
        ma (id-of (create-token admin-request morphs text 0 2))
        mx (id-of (create-token admin-request morphs text 2 3))]
    (testing "ops applied as sent: a mark inserted at the edge"
      (assert-ok (edit! text {:body [{:type "insert" :index 2 :value "\u0301"}]}))
      (is (= "táx" (body-of text)))
      (is (= [0 2 "tá"] (extent ma)))
      (is (= [2 3 "x"] (extent mx))))
    (testing "edits at the caret: a decomposed letter typed at the start of the second morpheme"
      (let [base (-> (get-text admin-request text) :body :text/digest)]
        (assert-ok (edit! text {:edits [{:type "insert" :index 2 :value "e\u0300"}] :base base}))
        (is (= "táèx" (body-of text)))
        (let [[b1 e1] (extent ma) [b2 e2] (extent mx)]
          (is (= 0 b1))
          (is (<= e1 b2))
          (is (= 4 e2)))))))

(deftest combining-marks-and-astral-characters-around-token-edges
  (let [{:keys [doc tl words]} (project-with-words)
        ;; \uD801\uDC00 é ␠ \uD801\uDC01, created decomposed
        text (id-of (create-text admin-request tl doc "\uD801\uDC00e\u0301 \uD801\uDC01"))
        w1 (id-of (create-token admin-request words text 0 2))
        w2 (id-of (create-token admin-request words text 3 4))]
    (is (= "\uD801\uDC00é \uD801\uDC01" (body-of text)))
    (is (= [0 2 "\uD801\uDC00é"] (extent w1)))
    (is (= [3 4 "\uD801\uDC01"] (extent w2)))
    (testing "o and an acute typed at the end of the first word, and an astral letter and a mark before the second"
      (let [base (-> (get-text admin-request text) :body :text/digest)]
        (assert-ok (edit! text {:edits [{:type "insert" :index 2 :value "o\u0301"}
                                        {:type "insert" :index 5 :value "\uD801\uDC02\u0323"}]
                                :base base}))
        (is (= "\uD801\uDC00éó \uD801\uDC02\u0323\uD801\uDC01" (body-of text)))
        (is (= [0 3 "\uD801\uDC00éó"] (extent w1)))
        (is (= [4 7 "\uD801\uDC02\u0323\uD801\uDC01"] (extent w2)))))))

(deftest values-names-and-fields-are-composed
  (let [{:keys [proj doc tl words morphs gloss]} (project-with-words)
        text (id-of (create-text admin-request tl doc "ab"))
        _w (id-of (create-token admin-request words text 0 2))
        m1 (id-of (create-token admin-request morphs text 0 1))
        m2 (id-of (create-token admin-request morphs text 1 2))
        rel-layer (id-of (create-relation-layer admin-request gloss "Ru\u0301l"))
        s1 (id-of (create-span admin-request gloss [m1] decomposed {"ke\u0301y" "va\u0301l"}))
        s2 (id-of (create-span admin-request gloss [m2] "x"))
        r (id-of (create-relation admin-request rel-layer s1 s2 "e\u0301"))]
    (testing "span and relation values and inline metadata"
      (is (= composed (:span/value (:body (get-span admin-request s1)))))
      (is (= {"kéy" "vál"} (:metadata (:body (get-span admin-request s1)))))
      (is (= "é" (:relation/value (:body (get-relation admin-request r))))))
    (testing "a span's value updated"
      (assert-ok (update-span admin-request s2 :value "o\u0308"))
      (is (= "ö" (:span/value (:body (get-span admin-request s2))))))
    (testing "metadata routes, put and patch"
      (assert-ok (update-document-metadata admin-request doc {"ti\u0301tulo" ["u\u0301no"]}))
      (is (= #{"título"} (set (map :key (psc/q db {:select [:key] :from [:entity_metadata]
                                                   :where [:= :entity_id (str doc)]})))))
      (is (= ["úno"] (get-in (:body (get-document admin-request doc)) [:metadata "título"]))))
    (testing "names"
      (assert-created (create-token-layer admin-request tl "Mo\u0301rf"))
      (is (contains? (set (map :name (psc/q db {:select [:name] :from [:token_layers]}))) "Mórf"))
      (is (= "Rúl" (:name (psc/fetch-by-id db :relation_layers rel-layer))))
      (let [p2 (create-test-project admin-request "Proyecto\u0301")
            d2 (create-test-document admin-request p2 "Documento\u0301")]
        (is (= "Proyectó" (:name (psc/fetch-by-id db :projects p2))))
        (is (= "Documentó" (:name (psc/fetch-by-id db :documents d2))))))
    (testing "a layer's config"
      (assert-status 204 (api-call admin-request {:method :put
                                                  :path (str "/api/v1/token-layers/" words "/config/igt/la\u0301bel")
                                                  :body {"tags" ["ne\u0301g"]}}))
      (is (= {"igt" {"lábel" {"tags" ["nég"]}}}
             (psc/parse-config (:config (psc/fetch-by-id db :token_layers words))))))
    (testing "vocabulary: layer name, form and fields"
      (let [vl (id-of (create-vocab-layer admin-request "Le\u0301xico"))
            item (id-of (create-vocab-item admin-request vl "ca\u0301sa" {"glo\u0301sa" "house"}))]
        (is (= "Léxico" (:name (psc/fetch-by-id db :vocab_layers vl))))
        (is (= "cása" (:vocab-item/form (:body (get-vocab-item admin-request item)))))
        (is (= #{"glósa"} (set (map :key (psc/q db {:select [:key] :from [:entity_metadata]
                                                    :where [:= :entity_id (str item)]})))))))
    (testing "a comment and its anchor label"
      (let [c (api-call admin-request {:method :post :path "/api/v1/comments"
                                       :body {:entity-type "span" :entity-id s1 :body "Que\u0301?"
                                              :anchor-label "Gloss of pʰa\u0301"}})
            row (psc/fetch-by-id db :comments (-> c :body :comment/id))]
        (assert-created c)
        (is (= ["Qué?" "Gloss of pʰá"] [(:body row) (:anchor_label row)]))))
    (testing "a guideline"
      (let [g (api-call admin-request {:method :post :path (str "/api/v1/projects/" proj "/guidelines")
                                       :body {:title "To\u0301nes" :body "a\u0301 is high"}})
            row (psc/fetch-by-id db :guidelines (id-of g))]
        (assert-created g)
        (is (= ["Tónes" "á is high"] [(:title row) (:body row)]))))
    (testing "an audit message"
      (assert-ok (update-span admin-request s2 :value "y"))
      (assert-ok (api-call admin-request {:method :patch
                                          :path (str "/api/v1/spans/" s2 "?audit-message="
                                                     (java.net.URLEncoder/encode "Fixe\u0301d" "UTF-8"))
                                          :body {:value "z"}}))
      (is (= "Fixéd" (:description (psc/q1 db {:select [:description] :from [:operations]
                                               :order-by [[:ts :desc]] :limit 1})))))
    (testing "a span made in a batch"
      (let [res (api-call admin-request {:method :post :path "/api/v1/batch"
                                         :body [{:path "/api/v1/spans" :method "post"
                                                 :body {:span-layer-id gloss :tokens [m1] :value "e\u0302"}}]})
            sid (-> res :body first :body :id)]
        (assert-ok res)
        (is (= "ê" (:span/value (:body (get-span admin-request sid))))))
      (testing "a value list taken by a span in the other spelling"
        (assert-ok (api-call admin-request {:method :put :path (str "/api/v1/span-layers/" gloss "/constraints/igt")
                                            :body {:constraints [{:type "value-set" :values ["nu\u0301" "z" composed "e\u0302"]}]}}))
        (assert-created (create-span admin-request gloss [m2] "nú"))))))

(deftest users-and-tokens-are-composed-but-passwords-are-not
  (let [create (rest-handler (-> (admin-request :post "/api/v1/users")
                                 (mock/json-body {:email "nfc@example.com" :password "pa\u0301sswörd"
                                                  :is-admin false :display-name "Jose\u0301"})))]
    (is (= 201 (:status create)))
    (is (= "José" (:display_name (psc/fetch-by-id db :users "nfc@example.com"))))
    (testing "a display name changed"
      (assert-ok (api-call admin-request {:method :patch :path "/api/v1/users/nfc@example.com"
                                          :body {:display-name "Zoe\u0308"}}))
      (is (= "Zoë" (:display_name (psc/fetch-by-id db :users "nfc@example.com")))))
    (testing "the password is compared as typed"
      (let [login (fn [pw] (:status (rest-handler (-> (mock/request :post "/api/v1/login")
                                                      (mock/json-body {:user-id "nfc@example.com" :password pw})))))]
        (is (= 200 (login "pa\u0301sswörd")))
        (is (= 401 (login "pásswörd")))))
    (testing "an API token's name"
      (assert-created (api-call admin-request {:method :post :path "/api/v1/users/admin@example.com/tokens"
                                               :body {:name "Scri\u0301pt"}}))
      (is (contains? (set (map :name (psc/q db {:select [:name] :from [:api_tokens]}))) "Scrípt")))))

(deftest private-user-data-is-kept-as-sent
  (let [path "/api/v1/users/admin@example.com/data/igt:draft"]
    (assert-ok (api-call admin-request {:method :put :path path :body {"text" "pʰa\u0301"}}))
    (is (= "pʰa\u0301" (get-in (api-call admin-request {:method :get :path path}) [:body :value "text"])))))

(deftest a-restore-to-a-time-before-composing-writes-composed-text
  (let [{:keys [proj doc tl words gloss morphs]} (project-with-words)
        text (id-of (create-text admin-request tl doc "x"))
        w (id-of (create-token admin-request words text 0 1))
        m (id-of (create-token admin-request morphs text 0 1))
        s (id-of (create-span admin-request gloss [m] "g"))
        ;; what an older core stored: a decomposed body and value
        _ (submit-operation! [tx db {:type :text/update-body :project proj :document doc
                                     :description "decomposed" :user "admin@example.com"}]
                             (crud/update-by-id! tx :texts text {:body "ba\u0301 x"})
                             (crud/update-by-id! tx :tokens w {:begin 0 :end_ 3})
                             (crud/update-by-id! tx :tokens m {:begin 0 :end_ 3})
                             (crud/update-by-id! tx :spans s {:value (psc/write-json "glo\u0301ss")}))
        ts (:ts (psc/q1 db {:select [:ts] :from [:operations] :order-by [[:ts :desc]] :limit 1}))]
    (assert-ok (edit! text {:body "ba x zz"}))
    (assert-ok (update-span admin-request s "other"))
    (let [res (api-call admin-request {:method :post
                                       :path (str "/api/v1/documents/" doc "/restore?as-of="
                                                  (java.net.URLEncoder/encode (str ts) "UTF-8"))})]
      (assert-ok res)
      (is (= "bá x" (body-of text)))
      (is (= [0 2 "bá"] (extent w)))
      (is (= [0 2 "bá"] (extent m)))
      (is (= "glóss" (:span/value (:body (get-span admin-request s))))))))
