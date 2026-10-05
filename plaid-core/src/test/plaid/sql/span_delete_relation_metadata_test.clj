(ns plaid.sql.span-delete-relation-metadata-test
  "A span delete takes the relations on the span with it, and their
  metadata too, alone and in bulk, as every other route that deletes
  relations does."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call assert-status with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer-opts create-span-layer create-relation-layer
                                        create-text create-token create-span create-relation]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- setup!
  "Three spans on three words, and relations with metadata: a to b, b to c,
  and c to itself."
  []
  (let [p (create-test-project admin-request "P")
        d (create-test-document admin-request p "D")
        tl (id (create-text-layer admin-request p "T"))
        wl (id (create-token-layer-opts admin-request tl "W" {:overlap-mode "non-overlapping"}))
        sl (id (create-span-layer admin-request wl "L"))
        rl (id (create-relation-layer admin-request sl "R"))
        tx (id (create-text admin-request tl d "a b c"))
        [a b c] (vec (for [i [0 2 4]]
                       (id (create-span admin-request sl [(id (create-token admin-request wl tx i (inc i)))] "x"))))
        rel (fn [s t] (let [r (create-relation admin-request rl s t "dep" {"note" "n"})]
                        (assert-status 201 r)
                        (id r)))]
    {:a a :b b :c c :ab (rel a b) :bc (rel b c) :cc (rel c c)}))

(defn- metadata-of [rel]
  (:n (psc/q1 db ["SELECT count(*) AS n FROM entity_metadata WHERE entity_type = 'relation' AND entity_id = ?"
                  (str rel)])))

(deftest a-span-delete-sweeps-its-relations-metadata
  (let [{:keys [a ab bc]} (setup!)]
    (is (= 1 (metadata-of ab)))
    (assert-status 204 (api-call admin-request {:method :delete :path (str "/api/v1/spans/" a)}))
    (testing "the relation on the span is gone with its metadata"
      (is (zero? (metadata-of ab))))
    (testing "another relation keeps its own"
      (is (= 1 (metadata-of bc))))))

(deftest a-bulk-span-delete-sweeps-its-relations-metadata
  (let [{:keys [b c ab bc cc]} (setup!)]
    (assert-status 204 (api-call admin-request {:method :delete :path "/api/v1/spans/bulk" :body [b c]}))
    (doseq [r [ab bc cc]]
      (is (zero? (metadata-of r))))))
