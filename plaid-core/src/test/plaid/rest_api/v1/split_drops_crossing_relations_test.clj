(ns plaid.rest-api.v1.split-drops-crossing-relations-test
  "A relation layer that declares same-ancestor over the sentence layer loses,
  in a sentence split's own transaction, the relations the split leaves
  crossing, read from what is stored. A client that computed the crossing
  relations from a stale copy used to leave one drawn since behind (D5, V3
  H3-3), and a split made in an app that cannot name the layer (igt splitting
  a sentence of a ud project) left them for the next open to repair."
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
    other sat->ran (crosses 13, but its layer declares nothing)"
  []
  (let [proj (create-test-project admin-request "Split")
        doc (create-test-document admin-request proj "D")
        tl (id (create-text-layer admin-request proj "T"))
        sl (id (create-token-layer admin-request tl "Sentence" "non-overlapping"))
        wl (id (create-token-layer admin-request tl "Word"))
        lemma (id (create-span-layer admin-request wl "Lemma"))
        deps (id (create-relation-layer admin-request lemma "Deps"))
        other (id (create-relation-layer admin-request lemma "Other"))
        txt (id (create-text admin-request tl doc text))
        sentence (id (create-token admin-request sl txt 0 (count text)))
        span (into {} (for [[w [b e]] words]
                        [w (id (create-span admin-request lemma [(id (create-token admin-request wl txt b e))] w))]))
        rel (fn [layer s t] (id (create-relation admin-request layer (span s) (span t) "dep")))]
    {:proj proj :doc doc :sl sl :sentence sentence :deps deps :other other
     :rels {:cat-the (rel deps "cat" "The")
            :sat-dogs (rel deps "sat" "Dogs")
            :ran-dogs (rel deps "ran" "Dogs")
            :other-sat-ran (rel other "sat" "ran")}}))

(defn- exists? [rid] (some? (psc/fetch-by-id db :relations rid)))

(defn- split! [token body]
  (api-call admin-request {:method :post :path (str "/api/v1/tokens/" token "/split") :body body}))

(defn- declare! [layer token-layer]
  (api-call admin-request {:method :put
                           :path (str "/api/v1/relation-layers/" layer "/constraints/ud")
                           :body {:constraints [{:type "same-ancestor" :token-layer token-layer}]}}))

(defn- rule-ops [doc]
  (psc/q db {:select [:id] :from :operations
             :where [:and [:= :op_type "layer/apply-constraints"] [:= :document_id (str doc)]]}))

(deftest a-split-drops-the-relations-its-declared-layer-leaves-crossing
  (let [{:keys [sentence deps rels doc sl]} (setup!)]
    (assert-status 200 (declare! deps sl))
    (assert-status 201 (split! sentence {:position 13}))
    (is (not (exists? (:sat-dogs rels))) "the relation now crossing the boundary is gone")
    (is (exists? (:cat-the rels)))
    (is (exists? (:ran-dogs rels)))
    (is (exists? (:other-sat-ran rels)) "a layer that declares nothing keeps its relations")
    (is (= 1 (count (rule-ops doc))) "one operation of the rules, in the split's transaction")))

(deftest a-split-with-nothing-declared-keeps-every-relation
  (let [{:keys [sentence rels doc]} (setup!)]
    (assert-status 201 (split! sentence {:position 13}))
    (is (every? exists? (vals rels)))
    (is (empty? (rule-ops doc)))))

(deftest a-relation-reaching-outside-its-sentence-refuses-the-declaration
  (let [{:keys [sentence deps rels sl]} (setup!)]
    ;; Split first with nothing declared: sat->Dogs now crosses, so the rule
    ;; cannot be declared over it.
    (assert-status 201 (split! sentence {:position 13}))
    (assert-status 422 (declare! deps sl))
    (is (exists? (:sat-dogs rels)))))

(deftest a-split-body-naming-layers-is-read-as-a-plain-split
  (let [{:keys [sentence rels]} (setup!)]
    (assert-status 201 (split! sentence {:position 13 :drop-crossing-relations [(random-uuid)]}))
    (is (every? exists? (vals rels)))))

(defn- batch! [ops]
  (api-call admin-request {:method :post :path "/api/v1/batch" :body ops}))

(defn- rule-op-groups [doc]
  (map :group_id (psc/q db {:select [:group_id] :from :operations
                            :where [:and [:= :op_type "layer/apply-constraints"] [:= :document_id (str doc)]]})))

(deftest a-batched-split-puts-the-rule-deletion-in-its-operation-group
  ;; An assistant plan splits a sentence through a batch whose sub-requests
  ;; name one group. The relation the rules delete belongs to that group, so
  ;; History shows one entry and the plan's unit holds the deletion (A2-UD-3).
  (let [{:keys [sentence deps rels doc sl]} (setup!)
        gid (random-uuid)
        q (str "?group-id=" gid "&group-kind=assistant-plan&group-ref=conv%3Ax%2Fplan%3Ay&group-message=Assistant")]
    (assert-status 200 (declare! deps sl))
    (assert-status 200 (batch! [{:path (str "/api/v1/tokens/" sentence "/split" q)
                                 :method "post" :body {:position 13}}]))
    (is (not (exists? (:sat-dogs rels))))
    (is (= [gid] (map #(some-> % str parse-uuid) (rule-op-groups doc)))
        "the rule's operation carries the batch's group")))

(deftest a-batch-naming-no-group-leaves-the-rule-deletion-ungrouped
  (let [{:keys [sentence deps doc sl]} (setup!)]
    (assert-status 200 (declare! deps sl))
    (assert-status 200 (batch! [{:path (str "/api/v1/tokens/" sentence "/split")
                                 :method "post" :body {:position 13}}]))
    (is (= [nil] (rule-op-groups doc)))))

(deftest a-batch-naming-two-groups-leaves-the-rule-deletion-ungrouped
  ;; Which of the two the deletion belongs to cannot be told, so it joins
  ;; neither, as before (REV-FX9-RM).
  (let [{:keys [sentence deps rels doc sl]} (setup!)
        g1 (random-uuid)
        g2 (random-uuid)]
    (assert-status 200 (declare! deps sl))
    (assert-status 200 (batch! [{:path (str "/api/v1/tokens/" sentence "/split?group-id=" g1)
                                 :method "post" :body {:position 13}}
                                {:path (str "/api/v1/relations/" (:other-sat-ran rels) "?group-id=" g2)
                                 :method "patch" :body {:value "x"}}]))
    (is (not (exists? (:sat-dogs rels))))
    (is (= [nil] (rule-op-groups doc)))))

(deftest a-batch-with-its-own-group-puts-the-rule-deletion-there
  ;; A group named on the batch itself binds every write in it, the remedy
  ;; included, whatever its sub-requests name.
  (let [{:keys [sentence deps rels doc sl]} (setup!)
        g (random-uuid)]
    (assert-status 200 (declare! deps sl))
    (assert-status 200 (api-call admin-request {:method :post :path (str "/api/v1/batch?group-id=" g)
                                                :body [{:path (str "/api/v1/tokens/" sentence "/split")
                                                        :method "post" :body {:position 13}}]}))
    (is (not (exists? (:sat-dogs rels))))
    (is (= [g] (map #(some-> % str parse-uuid) (rule-op-groups doc))))))
