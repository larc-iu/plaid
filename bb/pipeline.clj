(ns pipeline
  "Local reproduction of the test + build jobs from
  .github/workflows/release.yml. `bb test` / `bb build` / `bb ci` run the whole
  pipeline locally — everything EXCEPT publishing, which is genuinely CI-only
  (keyless OIDC trusted publishing to npm/PyPI + the GitHub Release). In CI the
  git tag is the version's source of truth; locally it's just an argument
  (default 0.0.0-alpha.0)."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]))

(defn fail [msg]
  (binding [*out* *err*] (println "✗" msg))
  (System/exit 1))

(defn ensure-repo-root! []
  (when-not (fs/exists? "plaid-core/deps.edn")
    (fail "run bb from the repo root (the directory containing bb.edn)")))

(defn step [msg] (println (str "\n==> " msg)))

(defn rm-rf [pth]
  (when (fs/exists? pth)
    (if (fs/directory? pth) (fs/delete-tree pth) (fs/delete pth))))

;; Version shape: X.Y.Z, optionally -alpha.N / -beta.N / -rc.N — identical to
;; what `release` and release.yml parse, so all three artifact builds succeed.
(def version-pattern (re-pattern "\\d+\\.\\d+\\.\\d+(-(?:alpha|beta|rc)\\.\\d+)?"))

(defn derive-version [arg]
  (let [v (or arg "0.0.0-alpha.0")]
    (when-not (re-matches version-pattern v)
      (fail (str "'" v "' is not X.Y.Z or X.Y.Z-(alpha|beta|rc).N")))
    v))

;; PEP440 form for Python: -alpha.N -> aN, -beta.N -> bN, -rc.N -> rcN.
;; (The only cross-registry translation — npm/jar/GH all use the verbatim tag.)
(defn ->pep440 [v]
  (-> v (str/replace "-alpha." "a") (str/replace "-beta." "b") (str/replace "-rc." "rc")))

(defn sha256-hex [f]
  (let [md (java.security.MessageDigest/getInstance "SHA-256")
        bs (.digest md (fs/read-all-bytes f))]
    (apply str (map (fn [b] (format "%02x" (bit-and b 0xff))) bs))))

;; Python comes from the mamba `base` env — this repo's default Python (it holds
;; the deps the bundled services use). Activate it (`mamba activate base`) so
;; `python` resolves to it before running, the way Node needs `nvm use`.
;; mamba/conda are shell functions, so the build can't activate the env itself.
;; Throws (not System/exit) so a caller's `finally` still restores files.
(defn python-exe []
  (cond (fs/which "python")  "python"
        (fs/which "python3") "python3"
        :else (throw (ex-info (str "no `python` on PATH — activate the mamba base env "
                                   "(`mamba activate base`) first, or pass --skip-clients")
                              {}))))

;; The SPA build (Vite) needs a recent Node; CI uses 20. The repo's default
;; shell Node is often too old — fail fast with a useful hint rather than a
;; cryptic Vite crash mid-build.
(defn ensure-node! []
  (when-not (fs/which "node") (fail "node not found on PATH"))
  (let [v     (str/trim (:out (p/sh "node" "--version")))
        major (some-> (re-find (re-pattern "v(\\d+)") v) second parse-long)]
    (when (or (nil? major) (< major 20))
      (fail (str "Node " v " is too old — the SPA build needs Node >= 20 (CI uses 20). "
                 "Activate a newer Node (e.g. `nvm use 24.1.0`), then re-run.")))))

(defn run-tests! []
  (ensure-repo-root!)
  (step "Run the full Clojure test suite (the release gate)")
  (p/shell {:dir "plaid-core"} "clojure" "-M:test"))

;; Boot the jar unattended and assert /health reports the release version
;; (proves version.edn + the SPAs/services were bundled). Runs in a throwaway
;; temp dir so the auto-generated data/, services/, config.toml don't dirty the
;; repo. The jar self-heals JVM flags by re-execing, so a bare `java -jar` boots.
(defn smoke-test! [version]
  (step "Smoke-test the jar (boots via re-exec + reports release version)")
  (let [jar    (str (fs/absolutize (str "plaid-core/target/plaid-" version ".jar")))
        health ["curl" "-sf" "http://localhost:8080/health"]]
    (when (zero? (:exit (apply p/sh health)))
      (fail "something already answers http://localhost:8080/health — stop it, or pass --no-smoke"))
    (let [tmp  (fs/create-temp-dir {:prefix "plaid-smoke-"})
          proc (p/process ["java" "-jar" jar]
                          {:dir (str tmp)
                           :extra-env {"SKIP_ACCOUNT_CREATION_PROMPT" "1"}
                           :out :inherit :err :inherit})]
      (try
        (let [needle (str "\"version\":\"" version "\"")
              ok? (loop [i 0]
                    (let [r (apply p/sh health)]
                      (cond
                        (and (zero? (:exit r)) (str/includes? (:out r) needle)) true
                        (>= i 30) false
                        :else (do (Thread/sleep 2000) (recur (inc i))))))]
          (when-not ok?
            (throw (ex-info "jar failed to boot / report the release version at /health" {})))
          (println "  jar booted; /health reports the release version")
          ;; First boot must also have extracted the bundled services next to data/.
          (doseq [f ["ud_parse_stanza.py" "igt_tokenize_punkt.py" "igt_transcribe_whisper.py"]]
            (when-not (fs/exists? (fs/path tmp "services" f))
              (throw (ex-info (str "services/" f " was not extracted on first run") {}))))
          (println "  bundled services extracted on first run"))
        (finally
          ;; Kill the parent AND the re-exec'd child.
          (p/destroy-tree proc)
          (try (p/sh "pkill" "-f" (str "plaid-" version ".jar")) (catch Exception _ nil))
          (rm-rf tmp))))))

(defn build-python! [pep art]
  (step "Build Python client (sdist + wheel)")
  (let [py      (python-exe)
        toml    "plaid-client-py/pyproject.toml"
        stamped (str/replace (slurp toml)
                             (re-pattern "(?m)^version = \"[^\"]*\"")
                             (str "version = \"" pep "\""))]
    ;; Stamp the PEP440 version into pyproject, then build. The PyPA `build`
    ;; frontend must be importable in the active env — install it if missing.
    (when-not (zero? (:exit (p/sh py "-c" "import build")))
      (println "  installing the `build` frontend into the active Python env…")
      (p/shell py "-m" "pip" "install" "--upgrade" "--quiet" "build"))
    (spit toml stamped)
    (p/shell {:dir "plaid-client-py"} py "-m" "build" "--outdir" (str art))))

;; The whole release.yml `build` job, locally. No publishing.
(defn build-artifacts! [{:keys [version smoke? clients?]}]
  (ensure-repo-root!)
  (ensure-node!)
  (let [art      (fs/absolutize "dist-artifacts")
        pep      (->pep440 version)
        jar-name (str "plaid-" version ".jar")
        js-pkg   "plaid-client-js/package.json"
        py-toml  "plaid-client-py/pyproject.toml"
        ;; npm version + the pyproject sed mutate TRACKED files; snapshot them
        ;; and restore in `finally` so the build leaves the tree clean.
        js-bak   (when clients? (slurp js-pkg))
        py-bak   (when clients? (slurp py-toml))]
    (println (str "\nBuilding Plaid release artifacts  (version=" version "  pep440=" pep ")"))
    (fs/create-dirs art)
    (try
      ;; --- Build the SPAs and bundle into the jar's resources -------------
      ;; `npm install`, not `npm ci`: this repo gitignores package-lock.json.
      (step "Build plaid-ud SPA")
      (p/shell {:dir "plaid-ud"} "npm" "install")
      (p/shell {:dir "plaid-ud"} "npm" "run" "build")
      (step "Build plaid-igt SPA")
      (p/shell {:dir "plaid-igt"} "npm" "install")
      (p/shell {:dir "plaid-igt"} "npm" "run" "build")

      (step "Bundle SPAs + version.edn into plaid-core/resources")
      (rm-rf "plaid-core/resources/ud")
      (rm-rf "plaid-core/resources/igt")
      (fs/copy-tree "plaid-ud/dist"  "plaid-core/resources/ud")
      (fs/copy-tree "plaid-igt/dist" "plaid-core/resources/igt")
      (spit "plaid-core/resources/version.edn" (str "{:version \"" version "\"}\n"))

      ;; Each app's services/*.py rides the jar and is extracted next to data/
      ;; on boot. manifest.edn maps filename -> sha256 (the extractor enumerates
      ;; from it and uses the hashes for overwrite-if-unmodified semantics).
      (step "Bundle official services + manifest.edn into plaid-core/resources")
      (rm-rf "plaid-core/resources/services")
      (fs/create-dirs "plaid-core/resources/services")
      (doseq [f (concat (fs/glob "plaid-ud/services" "*.py")
                        (fs/glob "plaid-igt/services" "*.py"))]
        (fs/copy f (fs/path "plaid-core/resources/services" (fs/file-name f))))
      (let [names    (sort (map (comp str fs/file-name)
                                (fs/glob "plaid-core/resources/services" "*.py")))
            manifest (reduce (fn [m n]
                               (assoc m n (sha256-hex (fs/path "plaid-core/resources/services" n))))
                             (sorted-map) names)]
        (spit "plaid-core/resources/services/manifest.edn" (str (pr-str manifest) "\n"))
        (println "  manifest:" (pr-str manifest)))

      (step "Build uberjar")
      (p/shell {:dir "plaid-core"} "clojure" "-X:uberjar")
      (fs/move "plaid-core/target/plaid.jar"
               (str "plaid-core/target/" jar-name)
               {:replace-existing true})

      (if smoke?
        (smoke-test! version)
        (println "\n(skipping jar smoke-test — --no-smoke)"))

      ;; Stage the jar first — it's the primary artifact, so it lands in
      ;; dist-artifacts/ even if an (optional) client build fails afterward.
      (step "Stage the jar into dist-artifacts/")
      (fs/copy (str "plaid-core/target/" jar-name)
               (fs/path art jar-name)
               {:replace-existing true})

      ;; --- npm tarball + Python sdist/wheel (NOT publish) ----------------
      (if clients?
        (do
          (step "Pack npm client")
          (p/shell {:dir "plaid-client-js"} "npm" "version" version "--no-git-tag-version" "--allow-same-version")
          (p/shell {:dir "plaid-client-js"} "npm" "pack" "--pack-destination" (str art))
          (build-python! pep art))
        (println "\n(skipping npm + Python client builds — --skip-clients)"))

      (step (str "Done — artifacts in " (str art)))
      (doseq [f (sort (map (comp str fs/file-name) (fs/list-dir art)))]
        (println "  •" f))
      (println "\nNote: the built SPAs/services + version.edn now live in plaid-core/resources/")
      (println "      (gitignored). Run `bb clean` to drop them before plain `clojure -M:dev`.")
      (finally
        (when js-bak (spit js-pkg js-bak))
        (when py-bak (spit py-toml py-bak))))))

(defn parse-build-args [cli-args]
  (let [flags      (set (filter (fn [a] (str/starts-with? a "--")) cli-args))
        positional (remove (fn [a] (str/starts-with? a "--")) cli-args)]
    {:version  (derive-version (first positional))
     :smoke?   (not (contains? flags "--no-smoke"))
     :clients? (not (contains? flags "--skip-clients"))}))

(defn clean! []
  (ensure-repo-root!)
  (doseq [pth ["dist-artifacts"
               "plaid-core/resources/ud"
               "plaid-core/resources/igt"
               "plaid-core/resources/services"
               "plaid-core/resources/version.edn"
               "plaid-ud/dist"
               "plaid-igt/dist"]]
    (rm-rf pth))
  (doseq [j (fs/glob "plaid-core/target" "plaid-*.jar")]
    (fs/delete j))
  (println "✓ cleaned local build outputs"))
