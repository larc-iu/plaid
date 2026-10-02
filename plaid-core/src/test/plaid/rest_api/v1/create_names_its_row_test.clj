(ns plaid.rest-api.v1.create-names-its-row-test
  "A create's audit entry names the row it made, as an update names the row
  it changed, so a client can tell who filled an empty cell (FX-UI's note
  for H11-MULTI-1: the conflict toast said Someone)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-clean-db admin-request api-call]]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))

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
        said (descriptions doc)]
    (doseq [[what said-as] [["span" (str "Create span " s1 " ")]
                            ["relation" (str "Create relation " r " ")]
                            ["vocab link" (str "Create vocab mapping " l)]]]
      (testing what
        (is (some #(clojure.string/starts-with? % said-as) said) (pr-str said))))))
