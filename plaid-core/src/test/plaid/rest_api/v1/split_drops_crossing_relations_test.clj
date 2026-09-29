(ns plaid.rest-api.v1.split-drops-crossing-relations-test
  "A token split can name relation layers whose relations must not cross the
  new boundary (a sentence split, for dependency trees), and then deletes
  those that would in the same transaction, from what is stored. A client
  that computed the crossing relations from a stale copy used to leave one
  drawn since behind (D5, V3 H3-3)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-test-users
                                    api-call assert-status with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        create-text-layer create-token-layer
                                        create-span-layer create-relation-layer
                                        create-text create-token create-span
                                        create-relation]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private text "The cat sat. Dogs ran.")

(def ^:private words
  {"The" [0 3] "cat" [4 7] "sat" [8 11] "Dogs" [13 17] "ran" [18 21]})

(defn- id [resp] (-> resp :body :id))

(defn- setup!
  "One document holding one sentence token over the whole text, words on a
  word layer with a span each, a dependency layer and a second relation
  layer, and relations:
    deps  cat->The (left), sat->Dogs (crosses 13), ran->Dogs (right)
    other sat->ran (crosses 13, but its layer is not named)"
  []
  (let [proj (create-test-project admin-request "Split")
        doc (create-test-document admin-request proj "D")
        tl (id (create-text-layer admin-request proj "T"))
        sl (id (create-token-layer admin-request tl "Sentence"))
        wl (id (create-token-layer admin-request tl "Word"))
        lemma (id (create-span-layer admin-request wl "Lemma"))
        deps (id (create-relation-layer admin-request lemma "Deps"))
        other (id (create-relation-layer admin-request lemma "Other"))
        txt (id (create-text admin-request tl doc text))
        sentence (id (create-token admin-request sl txt 0 (count text)))
        span (into {} (for [[w [b e]] words]
                        [w (id (create-span admin-request lemma [(id (create-token admin-request wl txt b e))] w))]))
        rel (fn [layer s t] (id (create-relation admin-request layer (span s) (span t) "dep")))]
    {:proj proj :doc doc :sentence sentence :deps deps :other other
     :rels {:cat-the (rel deps "cat" "The")
            :sat-dogs (rel deps "sat" "Dogs")
            :ran-dogs (rel deps "ran" "Dogs")
            :other-sat-ran (rel other "sat" "ran")}}))

(defn- exists? [rid] (some? (psc/fetch-by-id db :relations rid)))

(defn- split! [token body]
  (api-call admin-request {:method :post :path (str "/api/v1/tokens/" token "/split") :body body}))

(deftest a-split-naming-a-layer-drops-its-crossing-relations
  (let [{:keys [sentence deps rels]} (setup!)]
    (assert-status 201 (split! sentence {:position 13 :drop-crossing-relations [deps]}))
    (is (not (exists? (:sat-dogs rels))) "the relation now crossing the boundary is gone")
    (is (exists? (:cat-the rels)))
    (is (exists? (:ran-dogs rels)))
    (is (exists? (:other-sat-ran rels)) "a layer not named keeps its relations")))

(deftest a-split-naming-nothing-keeps-every-relation
  (let [{:keys [sentence rels]} (setup!)]
    (assert-status 201 (split! sentence {:position 13}))
    (is (every? exists? (vals rels)))))

(deftest a-relation-reaching-outside-the-split-token-is-left-alone
  (let [{:keys [sentence deps rels]} (setup!)]
    ;; First split at 13, keeping everything, then split the left sentence
    ;; at 8: sat->Dogs reached outside that sentence before this split.
    (assert-status 201 (split! sentence {:position 13}))
    (assert-status 201 (split! sentence {:position 8 :drop-crossing-relations [deps]}))
    (is (exists? (:sat-dogs rels)))
    (is (exists? (:cat-the rels)))))

(deftest a-layer-from-elsewhere-refuses-the-split
  (let [{:keys [sentence rels]} (setup!)
        stranger (-> (setup!) :deps)]
    (assert-status 400 (split! sentence {:position 13 :drop-crossing-relations [stranger]}))
    (assert-status 400 (split! sentence {:position 13 :drop-crossing-relations [(random-uuid)]}))
    (is (= (count text) (:end_ (psc/fetch-by-id db :tokens sentence))) "the split did not happen")
    (is (every? exists? (vals rels)))))
