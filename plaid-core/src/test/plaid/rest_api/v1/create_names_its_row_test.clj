(ns plaid.rest-api.v1.create-names-its-row-test
  "A create's audit entry names the row it made, as an update names the row
  it changed, so a client can tell who filled an empty cell (FX-UI's note
  for H11-MULTI-1: the conflict toast said Someone)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-clean-db admin-request api-call]]
            [plaid.test-helpers :as h :refer [id]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- descriptions [doc]
  (->> (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc "/audit")})
       :body :entries (mapcat :audit/ops) (map :op/description)))

(deftest a-create-names-what-it-made
  (let [proj (h/create-test-project admin-request "Names")
        doc (h/create-test-document admin-request proj "D")
        tl (id (h/create-text-layer admin-request proj "T"))
        wl (id (h/create-token-layer admin-request tl "Word"))
        sl (id (h/create-span-layer admin-request wl "Gloss"))
        rl (id (h/create-relation-layer admin-request sl "Deps"))
        vocab (id (h/create-vocab-layer admin-request "Lex"))
        _ (h/link-vocab-to-project admin-request proj vocab)
        item (id (h/create-vocab-item admin-request vocab "dog"))
        text (id (h/create-text admin-request tl doc "dog barks"))
        t1 (id (h/create-token admin-request wl text 0 3))
        t2 (id (h/create-token admin-request wl text 4 9))
        s1 (id (h/create-span admin-request sl [t1] "DOG"))
        s2 (id (h/create-span admin-request sl [t2] "BARK"))
        r (id (h/create-relation admin-request rl s2 s1 "nsubj"))
        l (id (h/create-vocab-link admin-request item [t1]))
        _ (h/update-span-tokens admin-request s2 [t1 t2])
        said (descriptions doc)]
    (testing "a span's token count reads in plain words"
      (is (some #(= % (str "Create span " s1 " with 1 token in layer " sl)) said) (pr-str said))
      (is (some #(= % (str "Update tokens of span " s2 " to 2 tokens")) said) (pr-str said)))
    (doseq [[what said-as] [["span" (str "Create span " s1 " ")]
                            ["relation" (str "Create relation " r " ")]
                            ["vocab link" (str "Create vocab mapping " l)]]]
      (testing what
        (is (some #(clojure.string/starts-with? % said-as) said) (pr-str said))))))

(deftest a-bulk-write-counts-in-plain-words
  ;; H15-CORE polish: History showed "Bulk delete 1 tokens".
  (let [proj (h/create-test-project admin-request "Counts")
        doc (h/create-test-document admin-request proj "D")
        tl (id (h/create-text-layer admin-request proj "T"))
        wl (id (h/create-token-layer admin-request tl "Word"))
        sl (id (h/create-span-layer admin-request wl "Gloss"))
        text (id (h/create-text admin-request tl doc "dog barks"))
        [t1] (-> (h/bulk-create-tokens admin-request [{:token-layer-id wl :text text :begin 0 :end 3}]) :body :ids)
        t2 (id (h/create-token admin-request wl text 4 9))
        _ (h/bulk-create-spans admin-request [{:span-layer-id sl :tokens [t1] :value "DOG"}
                                              {:span-layer-id sl :tokens [t2] :value "BARK"}])
        _ (h/bulk-delete-tokens admin-request [t1])
        said (descriptions doc)]
    (doseq [line ["Create 1 token in layer " "Create 2 spans in layer " "Delete 1 token"]]
      (testing line
        (is (some #(clojure.string/starts-with? % line) said) (pr-str said))))
    (is (not-any? #(clojure.string/includes? % "Bulk") said) (pr-str said))))

(deftest a-refusal-names-its-own-fault
  ;; H15-CORE polish: an empty token list was "Tokens must all belong to the
  ;; same text", and a link to a token that does not exist "Vocab link must
  ;; reference at least one token".
  (let [proj (h/create-test-project admin-request "Faults")
        doc (h/create-test-document admin-request proj "D")
        tl (id (h/create-text-layer admin-request proj "T"))
        wl (id (h/create-token-layer admin-request tl "Word"))
        vocab (id (h/create-vocab-layer admin-request "Lex"))
        _ (h/link-vocab-to-project admin-request proj vocab)
        item (id (h/create-vocab-item admin-request vocab "dog"))
        text (id (h/create-text admin-request tl doc "dog barks"))
        t1 (id (h/create-token admin-request wl text 0 3))
        gone (id (h/create-token admin-request wl text 4 9))
        _ (h/bulk-delete-tokens admin-request [gone])]
    (testing "an empty token list"
      (let [r (h/bulk-create-tokens admin-request [])]
        (is (= 400 (:status r)))
        (is (= "Token list is empty" (-> r :body :error)) (pr-str (:body r)))))
    (testing "a link naming a token that does not exist"
      (let [r (h/create-vocab-link admin-request item [t1 gone])]
        (is (= 400 (:status r)) (pr-str r))
        (is (= (str "Token not found with id `" gone "`") (-> r :body :error)) (pr-str (:body r)))))))
