(ns plaid.sql.audit-walk-test
  "The audit feeds page by walking a scope's operations from the page's edge
  (perf-audit-feed, ruled 2026-09-27). Checked against a reference that reads
  the whole scope at once and sorts it: over interleaved groups that run
  across many pages, atomic batches, a group that also wrote in another
  project, an op-type filter and a time window, every page size and both
  directions must give the same units, in the same order, each once, each
  with every one of its members in scope."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler with-admin with-clean-db]]
            [plaid.sql.audit :as audit]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.sql.operation :as op]
            [plaid.sql.project :as project]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(def ^:private user "admin@example.com")

(defn- new-project! [name]
  (:extra (project/create db {:project/name name :project/maintainers [user]} user)))

(defn- create-doc! [proj name]
  (:extra (doc/create db {:document/name name :document/project proj} user)))

(defn- build-history!
  "Seeded interleaving of standalone writes, writes in five long-running
  groups, and contiguous atomic batches, over two projects. Returns the two
  project ids."
  [seed]
  (let [rng (java.util.Random. seed)
        p1 (new-project! "Walk one")
        p2 (new-project! "Walk two")
        groups (vec (repeatedly 5 psc/new-uuid))
        docs (atom [(create-doc! p1 "d0")])]
    (dotimes [i 90]
      (let [roll (.nextInt rng 10)
            proj (if (< (.nextInt rng 10) 8) p1 p2)
            write! (fn []
                     (if (and (seq @docs) (< (.nextInt rng 3) 1))
                       (doc/merge db (rand-nth @docs) {:document/name (str "r" i)} user)
                       (when (= proj p1) (swap! docs conj (create-doc! proj (str "d" i))))))
            write! (fn [] (or (write!) (create-doc! proj (str "x" i))))]
        (cond
          (< roll 4) (binding [op/*current-group-id* (nth groups (.nextInt rng 5))]
                       (write!))
          (< roll 5) (binding [op/*current-batch-id* (psc/new-uuid)]
                       (dotimes [_ (inc (.nextInt rng 3))] (write!)))
          :else (write!))))
    [p1 p2]))

(defn- unit-of [row] (or (:group_id row) (:batch_id row) (:id row)))

(defn- reference
  "Every unit of `rows` (already scoped and filtered), placed by its newest
  member newest-first and its oldest member oldest-first."
  [rows desc?]
  (let [by-unit (group-by unit-of rows)
        pos (fn [ms] (let [tss (sort (map :ts ms))]
                       (if desc? (last tss) (first tss))))
        placed (map (fn [[u ms]] [u (pos ms) (sort (map :ts ms))]) by-unit)]
    (->> placed
         (sort-by second (if desc? #(compare %2 %1) compare))
         (mapv (fn [[u _ tss]] [(str u) (vec tss)])))))

(defn- walk
  "Every page of `fetch` at page size `limit`, concatenated."
  [fetch limit order]
  (loop [cursor nil acc [] guard 0]
    (let [{:keys [entries next-cursor]} (fetch {:limit limit :cursor-vals cursor :order order})
          acc (into acc (map (fn [e] [(str (:audit/id e)) (mapv :op/time (:audit/ops e))])) entries)]
      (if (and next-cursor (< guard 1000))
        (recur next-cursor acc (inc guard))
        acc))))

(defn- scoped-ops [where]
  (psc/q db (cond-> {:select [:*] :from [:operations] :order-by [:ts]}
              where (assoc :where where))))

(deftest the-walk-matches-a-whole-scope-sort
  (let [[p1 _] (build-history! 20260927)
        all-ts (mapv :ts (scoped-ops [:= :project_id p1]))
        mid-lo (nth all-ts 20)
        mid-hi (nth all-ts 70)
        cases [["project" [:= :project_id p1]
                (fn [opts] (audit/get-project-audit-log db p1 nil nil opts))]
               ["whole server" nil
                (fn [opts] (audit/get-audit-log db nil nil opts))]
               ["user" [:= :user_id user]
                (fn [opts] (audit/get-user-audit-log db user nil nil opts))]
               ["project, renames only" [:and [:= :project_id p1] [:= :op_type "document/update"]]
                (fn [opts] (audit/get-project-audit-log db p1 nil nil
                                                        (assoc opts :op-types ["document/update"])))]
               ["project, in a window" [:and [:= :project_id p1] [:>= :ts mid-lo] [:<= :ts mid-hi]]
                (fn [opts] (audit/get-project-audit-log db p1 mid-lo mid-hi opts))]]]
    (doseq [[label where fetch] cases
            order [:desc :asc]
            :let [expected (reference (scoped-ops where) (= order :desc))]
            limit [1 2 3 7 50 1000]
            ;; The walk reads the scope a step at a time. Steps of one or a
            ;; few operations put a step boundary inside groups and batches.
            step [1 4 250]]
      (testing (str label ", " (name order) ", pages of " limit ", steps of " step)
        (is (seq expected))
        (is (= expected (with-redefs [audit/walk-chunk step]
                          (walk fetch limit order))))))))

(deftest a-long-running-group-takes-its-place-from-the-walk
  (let [p (new-project! "Group")
        g (psc/new-uuid)
        first-in-group (binding [op/*current-group-id* g] (create-doc! p "g1"))
        _ (dotimes [i 3] (create-doc! p (str "s" i)))
        _ (binding [op/*current-group-id* g] (create-doc! p "g2"))
        fetch (fn [opts] (audit/get-project-audit-log db p nil nil opts))
        ids (fn [order] (mapv (comp str :audit/id)
                              (:entries (fetch {:limit 100 :order order}))))]
    (is (some? first-in-group))
    (testing "newest-first, the group sits at its latest write"
      (is (= (str g) (first (ids :desc)))))
    (testing "oldest-first, it sits at its first write, after the project create"
      (is (= (str g) (second (ids :asc)))))
    (testing "an entry's time is still its first member's"
      (let [e (first (:entries (fetch {:limit 1 :order :desc})))]
        (is (= (:op/time (first (:audit/ops e))) (:audit/time e)))
        (is (= 2 (count (:audit/ops e))))))))

(deftest ops-limit-keeps-each-entrys-oldest-operations
  (let [[p1 _] (build-history! 20261005)
        fetch (fn [opts] (:entries (audit/get-project-audit-log db p1 nil nil (merge {:limit 1000} opts))))
        full (fetch {})
        cut (fetch {:ops-limit 2})]
    (is (some #(> (count (:audit/ops %)) 2) full) "the history has an entry the limit cuts")
    (is (= (count full) (count cut)))
    (doseq [[f c] (map vector full cut)]
      (is (= (count (:audit/ops f)) (:audit/op-count f) (:audit/op-count c)))
      (is (= (vec (take 2 (:audit/ops f))) (:audit/ops c)))
      (is (= (dissoc f :audit/ops) (dissoc c :audit/ops))))))

(deftest entry-id-reads-one-entry-and-the-rest-of-it
  (let [[p1 _] (build-history! 20261006)
        fetch (fn [opts] (audit/get-project-audit-log db p1 nil nil (merge {:limit 1000} opts)))
        full (:entries (fetch {}))
        big (apply max-key (comp count :audit/ops) full)
        ops (:audit/ops big)]
    (is (> (count ops) 3))
    (testing "the entry alone, as the page has it"
      (let [{:keys [entries next-cursor]} (fetch {:entry-id (:audit/id big)})]
        (is (= [big] entries))
        (is (nil? next-cursor))))
    (testing "the rest of an entry the limit cut, from the last operation held"
      (let [held (:audit/ops (first (:entries (fetch {:entry-id (:audit/id big) :ops-limit 2}))))
            rest-ops (:audit/ops (first (:entries (audit/get-project-audit-log
                                                   db p1 (:op/time (peek held)) nil
                                                   {:entry-id (:audit/id big)}))))]
        (is (= ops (into held (rest rest-ops))))))
    (testing "an id that is no entry in the scope reads nothing"
      (is (= [] (:entries (fetch {:entry-id (psc/new-uuid)})))))))

(deftest a-huge-entry-costs-the-walk-a-few-steps
  ;; One group of many writes, among a few lone writes. The walk passes over
  ;; a gathered entry's members, so it reads the scope a handful of times,
  ;; not once per step's worth of the group's writes.
  (let [p (new-project! "Huge")
        g (psc/new-uuid)
        _ (create-doc! p "before")
        _ (binding [op/*current-group-id* g]
            (dotimes [i 40] (create-doc! p (str "g" i))))
        _ (create-doc! p "after")
        steps (atom 0)
        walk-ops @#'audit/walk-ops]
    (with-redefs [audit/walk-chunk 4
                  audit/walk-ops (fn [& args] (swap! steps inc) (apply walk-ops args))]
      (let [entries (:entries (audit/get-project-audit-log db p nil nil {:limit 100 :ops-limit 5}))]
        (is (= 4 (count entries)))
        (is (= 40 (:audit/op-count (nth entries 2))))
        (is (= 5 (count (:audit/ops (nth entries 2)))))))
    (is (< @steps 5))))
