(ns plaid.test-runner
  "Runs the plaid-core suite with eftest.

  Plain `clojure -M:test` runs every namespace in this JVM, as it always has.

  `--jobs N` splits the namespaces over N child JVMs, each with its own temp
  SQLite file (see `plaid.fixtures`), so they cannot see each other's rows.
  Threads inside one JVM would share that file, which is why the split is by
  process. The split is balanced by the per-namespace times in
  `test-timings.edn` (longest first onto the least loaded shard). Each child's
  output goes to a log, and the parent prints the logs of failed shards and one
  combined summary.

  `--jobs auto` takes half the cores, at most 8.

  `--shard I/N` runs only shard I (1-based) of the same split in this JVM, for
  a CI matrix. `--record-timings` rewrites `test-timings.edn` from this run.
  `--slowest K` prints the K slowest tests."
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.pprint :as pprint]
            [clojure.string :as str]
            [clojure.test :as test]
            [clojure.tools.namespace.find :as find]
            [eftest.report.pretty :as pretty]
            [eftest.report.progress :as progress]
            [eftest.runner :as eftest])
  (:import [java.lang.management ManagementFactory]))

(def ^:private timings-file "src/test-runner/test-timings.edn")

(defn- parse-args [args]
  (loop [args args, opts {}]
    (if (empty? args)
      opts
      (case (first args)
        "--namespace" (recur (drop 2 args)
                             (update opts :nss (fnil conj []) (symbol (second args))))
        "--var" (recur (drop 2 args) (assoc opts :var (second args)))
        "--jobs" (recur (drop 2 args)
                        (assoc opts :jobs (if (= "auto" (second args))
                                            ;; Half the cores, at most 8: past 8 the
                                            ;; slowest namespace sets the wall time.
                                            (-> (.availableProcessors (Runtime/getRuntime))
                                                (quot 2) (min 8) (max 1))
                                            (parse-long (second args)))))
        "--shard" (let [[i n] (str/split (second args) #"/")]
                    (recur (drop 2 args) (assoc opts :shard [(parse-long i) (parse-long n)])))
        "--record-timings" (recur (rest args) (assoc opts :record-timings true))
        ;; Internal: where a child writes its per-namespace times.
        "--timings-out" (recur (drop 2 args) (assoc opts :timings-out (second args)))
        "--quiet" (recur (rest args) (assoc opts :quiet true))
        "--slowest" (recur (drop 2 args) (assoc opts :slowest (parse-long (second args))))
        ;; default: skip unknown
        (recur (rest args) opts)))))

(defn- all-namespaces []
  (sort (find/find-namespaces-in-dir (io/file "src/test"))))

(defn- read-timings []
  (let [f (io/file timings-file)]
    (if (.exists f) (edn/read-string (slurp f)) {})))

(defn- split-namespaces
  "Longest-processing-time-first: each namespace, slowest first, goes to the
  shard with the least total so far. A namespace with no recorded time counts
  as the median."
  [nss n]
  (let [timings (read-timings)
        known (sort (vals timings))
        default (if (seq known) (nth known (quot (count known) 2)) 1000)
        cost #(get timings % default)
        ordered (sort-by (juxt (comp - cost) str) nss)]
    (->> ordered
         (reduce (fn [shards ns]
                   (let [i (apply min-key #(:total (shards %)) (range n))]
                     (-> shards
                         (update-in [i :nss] conj ns)
                         (update-in [i :total] + (cost ns)))))
                 (vec (repeat n {:nss [] :total 0})))
         (mapv :nss))))

(defn- timing-report
  "Wraps `report` to record wall time in ms per namespace into `acc`, and per
  test var into `var-acc`."
  [report acc var-acc]
  (let [started (atom {})
        elapsed #(quot (- (System/nanoTime) (@started %)) 1000000)]
    (fn [m]
      (case (:type m)
        :begin-test-ns (swap! started assoc (ns-name (:ns m)) (System/nanoTime))
        :end-test-ns (let [ns (ns-name (:ns m))]
                       (swap! acc assoc ns (elapsed ns)))
        :begin-test-var (swap! started assoc (symbol (:var m)) (System/nanoTime))
        :end-test-var (let [v (symbol (:var m))]
                        (swap! var-acc assoc v (elapsed v)))
        nil)
      (report m))))

(defn- print-slowest [n var-times]
  (when (pos? n)
    (println (format "\nSlowest %d tests:" n))
    (doseq [[v ms] (take n (sort-by (comp - val) var-times))]
      (println (format "%8.1f s  %s" (/ ms 1000.0) v)))))

(defn- run-in-process [opts nss]
  (let [tests (cond
                (seq nss) (do (run! require nss)
                              (vec (mapcat eftest/find-tests nss)))
                (:var opts) (do (require (symbol (namespace (symbol (:var opts)))))
                                (eftest/find-tests (resolve (symbol (:var opts)))))
                :else (eftest/find-tests "src/test"))
        acc (atom {})
        var-acc (atom {})
        report (timing-report (if (:quiet opts) pretty/report progress/report) acc var-acc)
        results (eftest/run-tests tests {:multithread? false :report report})]
    (print-slowest (:slowest opts 0) @var-acc)
    (when-let [out (:timings-out opts)]
      (spit out (pr-str {:timings @acc
                         :var-timings @var-acc
                         :counts (mapv #(get results % 0) [:test :pass :fail :error])})))
    (when (:record-timings opts)
      (spit timings-file (with-out-str (pprint/pprint (into (sorted-map) @acc)))))
    (if (or (pos? (:fail results 0)) (pos? (:error results 0))) 1 0)))

(defn- java-command
  "The command that starts this JVM again, with its classpath and JVM flags."
  []
  (let [java (str (io/file (System/getProperty "java.home") "bin" "java"))
        jvm-args (vec (.getInputArguments (ManagementFactory/getRuntimeMXBean)))]
    (-> [java]
        (into jvm-args)
        (into ["-cp" (System/getProperty "java.class.path") "clojure.main" "-m" "plaid.test-runner"]))))

(defn- run-parallel [opts]
  (let [n (:jobs opts)
        shards (remove empty? (split-namespaces (all-namespaces) n))
        tmp (.toFile (java.nio.file.Files/createTempDirectory
                      "plaid-test-shards-" (make-array java.nio.file.attribute.FileAttribute 0)))
        start (System/nanoTime)
        procs (vec (map-indexed
                    (fn [i nss]
                      (let [log (io/file tmp (str "shard-" (inc i) ".log"))
                            times (io/file tmp (str "shard-" (inc i) ".edn"))
                            cmd (-> (java-command)
                                    (into ["--quiet" "--timings-out" (str times)])
                                    (into (mapcat (fn [ns] ["--namespace" (str ns)]) nss)))
                            pb (doto (ProcessBuilder. ^java.util.List cmd)
                                 (.redirectErrorStream true)
                                 (.redirectOutput log))]
                        {:shard (inc i) :nss nss :log log :times times :proc (.start pb)}))
                    shards))]
    (println (format "Running %d namespaces on %d JVMs (logs in %s)"
                     (reduce + (map (comp count :nss) procs)) (count procs) tmp))
    (let [results (mapv (fn [{:keys [proc log] :as p}]
                          (.waitFor ^Process proc)
                          (let [result (when (.exists ^java.io.File (:times p))
                                         (edn/read-string (slurp (:times p))))]
                            (assoc p
                                   :exit (.exitValue ^Process proc)
                                   :out (slurp log)
                                   :timings (:timings result)
                                   :var-timings (:var-timings result)
                                   ;; tests, passes, failures, errors
                                   :counts (or (:counts result) [0 0 0 0]))))
                        procs)
          failed (filter #(or (not (zero? (:exit %)))
                              (pos? (get-in % [:counts 2]))
                              (pos? (get-in % [:counts 3])))
                         results)
          [tests passes fails errors] (apply mapv + (map :counts results))
          secs (/ (- (System/nanoTime) start) 1e9)]
      (doseq [{:keys [shard out exit]} failed]
        (println (format "\n===== shard %d failed (exit %d) =====" shard exit))
        (println out))
      (when (:record-timings opts)
        (let [merged (apply merge (read-timings) (keep :timings results))]
          (spit timings-file (with-out-str (pprint/pprint (into (sorted-map) merged))))))
      (doseq [{:keys [shard counts]} results]
        (println (format "shard %2d: %4d tests, %d failures, %d errors"
                         shard (counts 0) (counts 2) (counts 3))))
      (print-slowest (:slowest opts 0) (apply merge (map :var-timings results)))
      (println (format "\nRan %d tests in %.1f seconds on %d JVMs\n%d assertions, %d failures, %d errors."
                       tests secs (count results) (+ passes fails errors) fails errors))
      (if (seq failed)
        (do (println (str "Failed shards: " (str/join ", " (map :shard failed))))
            1)
        (do (run! #(.delete ^java.io.File %) (reverse (file-seq tmp)))
            0)))))

(defn -main [& args]
  (let [opts (parse-args args)
        code (cond
               (:jobs opts) (run-parallel opts)
               (:shard opts) (let [[i n] (:shard opts)]
                               (run-in-process opts (nth (split-namespaces (all-namespaces) n) (dec i))))
               :else (run-in-process opts (:nss opts)))]
    (shutdown-agents)
    (System/exit code)))
