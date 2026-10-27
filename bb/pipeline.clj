(ns pipeline
  "Local reproduction of the test + build jobs from
  .github/workflows/release.yml. `bb test` / `bb build` / `bb ci` run the whole
  pipeline locally — everything EXCEPT publishing, which is genuinely CI-only
  (keyless OIDC trusted publishing to npm/PyPI + the GitHub Release). In CI the
  git tag is the version's source of truth; locally it's just an argument
  (default 0.0.0-alpha.0)."
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [cheshire.core :as json]
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

;; One Python interpreter for every step: PLAID_PYTHON, else
;; PLAID_AGENT_PYTHON, else the `plaid-agent` env's python under the usual
;; mamba roots. Never the first `python` on PATH: on larc that is an env whose
;; editable installs point at another checkout, so a suite run with it tests
;; that checkout's code. CI sets PLAID_PYTHON to the job's own python. The env
;; has to hold the plaid client, `build`, pytest and the assistant itself.
;; Throws (not System/exit) so a caller's `finally` still restores files.
(defn python-exe []
  (or (not-empty (System/getenv "PLAID_PYTHON"))
      (not-empty (System/getenv "PLAID_AGENT_PYTHON"))
      (let [home (System/getProperty "user.home")]
        (->> [".miniforge3" "miniforge3" ".mambaforge" "mambaforge" "micromamba" "miniconda3" "anaconda3"]
             (map #(str home "/" % "/envs/plaid-agent/bin/python"))
             (filter fs/exists?)
             first))
      (throw (ex-info (str "no plaid Python: set PLAID_PYTHON to the plaid-agent env's python "
                           "(or pass --skip-clients to a build)")
                      {}))))

;; The packages under test are this checkout's, whatever the interpreter has
;; installed: PYTHONPATH names their sources, resolved from the repo root bb
;; runs in. Each suite's conftest fails when plaid_client or plaid_agent comes
;; from anywhere else.
(defn python-env []
  {"PYTHONPATH" (str/join ":" [(str (fs/absolutize "plaid-client-py/src"))
                               (str (fs/absolutize "plaid-agent/src"))])})

;; The SPA build (Vite) needs a recent Node; CI uses 24. Node 20 ships npm 10,
;; which cannot read the lockfiles npm 11 writes, and that is exactly how the
;; v0.2.0-alpha.12 release failed: `npm ci` died on a lockfile the test job had
;; just used. This guard exists to catch that before a build, so it has to
;; track CI rather than trail it.
(defn ensure-node! []
  (when-not (fs/which "node") (fail "node not found on PATH"))
  (let [v     (str/trim (:out (p/sh "node" "--version")))
        major (some-> (re-find (re-pattern "v(\\d+)") v) second parse-long)]
    (when (or (nil? major) (< major 24))
      (fail (str "Node " v " is too old — the SPA build needs Node >= 24 (CI uses 24), because "
                 "npm 10 cannot read the lockfiles in this repo. "
                 "Activate a newer Node (e.g. `nvm use 24.1.0`), then re-run.")))))

;; Apps whose own `npm test` is part of the gate, in the order they fail fastest.
;; The four SPAs, each with the path the jar serves it under.
(def ^:private spa-apps [["plaid-ud" "ud"] ["plaid-igt" "igt"] ["plaid-dict" "dict"] ["plaid-umr" "umr"]])

(def ^:private js-suites (mapv first spa-apps))

;; The shared UI package. Source-only: the apps compile it, so it has no build
;; and no test run of its own — its component tests run under plaid-igt's
;; vitest, which has the React and the happy-dom (see plaid-ui/README.md). What
;; it does own is a lint gate, and its install has to happen FIRST: every app
;; depends on it as `file:../plaid-ui`.

(defn- run-core-tests!
  "The Clojure suite. With a shard (\"I/N\") it runs only that part of the
  split, in one JVM, for a CI matrix."
  [shard]
  (step (str "Run the Clojure test suite (plaid-core)" (when shard (str ", shard " shard))))
  ;; One JVM per shard of namespaces, half the cores and at most 8 (so 2 on a
  ;; 4-core GitHub runner). See plaid-core/src/test-runner/plaid/test_runner.clj.
  (if shard
    (p/shell {:dir "plaid-core"} "clojure" "-M:test" "--shard" shard)
    (p/shell {:dir "plaid-core"} "clojure" "-M:test" "--jobs" "auto")))

(defn- lint-ui! []
  (step "Lint the shared UI package (plaid-ui)")
  (p/shell {:dir "plaid-ui"} "npm" "ci")
  (p/shell {:dir "plaid-ui"} "npm" "run" "lint"))

(defn- test-app!
  "One app's install, tests and lint, and with `build?` its Vite build, which
  is the check that every module still parses."
  [app build?]
  (step (str "Run the JavaScript test suite and lint (" app ")"))
  (p/shell {:dir app} "npm" "ci")
  (p/shell {:dir app} "npm" "test")
  ;; Lint is part of the gate too: plaid-igt fails on any warning, so the
  ;; tree cannot drift the way it did when nothing ran it. It is the GATE's
  ;; step rather than each app's `npm test`, so every app is linted exactly
  ;; once and the gate says in one place what it is. plaid-ud and plaid-umr
  ;; used to lint here and again inside their own `npm test`.
  (p/shell {:dir app} "npm" "run" "lint")
  (when build?
    (p/shell {:dir app} "npm" "run" "build")))

;; The JS client's own suite (the request layer, batching, OCC stamps,
;; pagination, service RPC). It was never in the gate either.
;; The client has no runtime dependencies, but its suite type-checks the
;; generated declarations with TypeScript, a dev dependency, so install
;; from the lockfile first.
(defn- test-client-js! []
  (step "Run the JavaScript test suite (plaid-client-js)")
  (p/shell {:dir "plaid-client-js"} "npm" "ci")
  (p/shell {:dir "plaid-client-js"} "npm" "test"))

(defn- run-js-tests!
  "Lint, install and test every JavaScript package, and with `build?` also
  build each SPA."
  [build?]
  (ensure-node!)
  (lint-ui!)
  (doseq [app js-suites] (test-app! app build?))
  (test-client-js!))

;; Every JavaScript package `bb ci-fast js <package>` takes, one CI job each.
(def ^:private js-packages (vec (concat ["plaid-ui"] js-suites ["plaid-client-js"])))

;; ci.yml's js matrix names the packages by hand. A package missing there
;; would go untested on every push, so each job checks the list first.
(defn- check-js-matrix! []
  (let [listed (some->> (re-find (re-pattern "(?m)^\\s*package:\\s*\\[([^\\]]*)\\]")
                                 (slurp ".github/workflows/ci.yml"))
                        second
                        (re-seq (re-pattern "[\\w-]+"))
                        set)]
    (when (not= listed (set js-packages))
      (fail (str "ci.yml's js matrix lists " (pr-str (sort listed)) ", the pipeline's packages are "
                 (pr-str (sort js-packages)) ": correct the matrix")))))

;; What an app's own job installs before it, which the serial run installs
;; anyway: plaid-ui for every app, since each depends on it as
;; `file:../plaid-ui`, and plaid-igt for plaid-dict, whose `@igt` alias
;; compiles plaid-igt's source and so resolves its bare imports from
;; plaid-igt's node_modules.
;; plaid-igt's vitest also runs plaid-ui's top-level tests, and
;; tailwindPreset.test.js there reads plaid-ud's tailwind config.
(defn- installs-before [app]
  (cond-> ["plaid-ui"]
    (= app "plaid-igt") (conj "plaid-ud")
    (= app "plaid-dict") (conj "plaid-igt")))

(defn- run-js-package!
  "One package of `run-js-tests!` with the build, for a CI matrix job."
  [pkg]
  (when-not (some #{pkg} js-packages)
    (fail (str "unknown JavaScript package '" pkg "': use one of " (str/join ", " js-packages))))
  (check-js-matrix!)
  (ensure-node!)
  (cond
    (= pkg "plaid-ui") (lint-ui!)
    (= pkg "plaid-client-js") (test-client-js!)
    :else (do (doseq [d (installs-before pkg)]
                (step (str "Install " d))
                (p/shell {:dir d} "npm" "ci"))
              (test-app! pkg true))))

;; The Python source trees, each compiled by the gate.
(def ^:private python-trees
  ["plaid-agent/src" "plaid-agent/bench" "plaid-client-py/src" "plaid-igt/services" "plaid-ud/services"
   "plaid-umr/services"])

;; Run after the JavaScript packages are installed, deliberately: the
;; assistant's mirror tests run the apps' own domain modules through node, and
;; they need plaid-igt's and plaid-ud's node_modules.
(defn- run-python-tests! []
  (let [py  (python-exe)
        env (python-env)
        run (fn [dir & args]
              (apply p/shell {:dir dir :extra-env env} py args))]
    ;; Every Python file still parses, including a service no test imports.
    ;; compileall says "Can't list" and exits 0 for a directory that is not
    ;; there, so each one is checked first.
    (step "Compile every Python package")
    (doseq [d python-trees]
      (when-not (fs/directory? d) (fail (str d " is not a directory: correct python-trees"))))
    (apply p/shell py "-m" "compileall" "-q" python-trees)
    ;; The packages declare Python 3.11 as their floor, and 3.12 accepts code
    ;; 3.11 refuses (a backslash inside an f-string expression). With
    ;; PLAID_PYTHON_FLOOR naming a 3.11 interpreter (ci.yml sets one), every
    ;; tree is compiled with it as well.
    (when-let [floor (not-empty (System/getenv "PLAID_PYTHON_FLOOR"))]
      (step (str "Compile every Python package with the floor interpreter (" floor ")"))
      (apply p/shell floor "-m" "compileall" "-q" python-trees))
    (step "Run the Python test suite (plaid-agent)")
    ;; igt's corpus tools ask a real core's query engine, so the suite boots a
    ;; private one from plaid-core's source (its own port and database, stopped
    ;; when the suite ends: tests/private_core.py). PLAID_AGENT_REQUIRE_LIVE
    ;; makes a core that cannot start a failure here, where a skip would pass
    ;; the gate having run none of those tests.
    (p/shell {:dir "plaid-agent" :extra-env (assoc env "PLAID_AGENT_REQUIRE_LIVE" "1")} py "-m" "pytest" "-q")
    (step "Run the Python test suite (plaid-igt services)")
    (run "plaid-igt" "-m" "pytest" "-q" "services/tests")
    (step "Run the Python test suite (plaid-ud services)")
    ;; The Stanza parser's handler test stands stanza itself in at import, so
    ;; it needs no model, no download and no env of its own.
    (run "plaid-ud" "-m" "pytest" "-q" "services/tests")
    (step "Run the Python test suite (plaid-umr services)")
    ;; The drafting service's handler test stands the chat model in at
    ;; `service.model`, so it needs no provider, no key and no litellm.
    (run "plaid-umr" "-m" "pytest" "-q" "services/tests")
    ;; The Python client's own suite: BaseService, cancellation, the idle
    ;; deadline, batch bypass and the three workflows.
    (step "Run the Python test suite (plaid-client-py)")
    (run "plaid-client-py" "-m" "pytest" "-q")))

(defn run-tests! []
  (ensure-repo-root!)
  (run-core-tests! nil)
  ;; The JS and Python suites are part of the gate too. They were not, and a
  ;; tag could therefore ship an app whose own tests were red: the Clojure
  ;; suite says nothing about either SPA or about the assistant.
  (run-js-tests! false)
  (run-python-tests!))

;; The per-push check (ci.yml): formatting, every unit suite and a build of
;; each SPA, without the fidelity round trips, the e2e suites or the jar. CI
;; runs one part per job, in parallel, and the core suite in shards. With no
;; part it runs all of them in turn, the way a developer would.
(defn run-fast-checks! [[part arg]]
  (ensure-repo-root!)
  (let [cljfmt! (fn []
                  (step "Check the Clojure formatting (plaid-core)")
                  (p/shell {:dir "plaid-core"} "clojure" "-M:format" "check"))]
    (case part
      "cljfmt" (cljfmt!)
      "core"   (run-core-tests! arg)
      "js"     (if arg (run-js-package! arg) (run-js-tests! true))
      ;; On its own, the Python part installs the JavaScript packages first,
      ;; for the mirror tests.
      "python" (do (ensure-node!)
                   (doseq [d js-packages]
                     (step (str "Install " d))
                     (p/shell {:dir d} "npm" "ci"))
                   (run-python-tests!))
      nil      (do (cljfmt!)
                   (run-core-tests! nil)
                   (run-js-tests! true)
                   (run-python-tests!))
      (fail (str "unknown part '" part "': use cljfmt, core, js or python")))))

;; The fidelity campaign's round trips, in the order they fail most usefully:
;; the kitchen sink first (a feature the builder stopped making makes the other
;; two lie), then what we can read back, then what the outside world accepts.
;;
;; Each boots a PRIVATE core from source (its own port, its own database, its
;; own media directory, stopped at the end), so nothing here touches a core
;; anyone is looking at. `realFiles.mjs` is deliberately absent: its corpora
;; are real files that live outside the repo, so it stays a local run.
(def ^:private fidelity-runs
  [["coverage.mjs" "the kitchen sink still holds every catalogued feature"]
   ["roundTrip.mjs" "every format reads back what it wrote, or its loss list says why not"]
   ["validate.mjs" "every export passes its own format's validator"]
   ["mirror.mjs" "the editor shows what the server keeps after each reshape, and asks about what it deletes"]
   ["composedArchive.mjs" "an archive whose text keeps a mark apart for its own token imports, and round trips identical"]
   ["resume.mjs" "an import stopped after the Nth write and resumed ends where a straight import ends"]
   ["vocabTsv.mjs" "a vocabulary TSV export reads back through Bulk Add"]])

(defn run-fidelity! []
  (ensure-repo-root!)
  (ensure-node!)
  (when-not (fs/which "clojure")
    (fail "clojure not found on PATH — each run boots a plaid-core from source"))
  (when-not (fs/exists? "plaid-igt/node_modules")
    (fail "plaid-igt/node_modules is missing — run `npm ci` there (or `bb test`) first"))
  (doseq [[script what] fidelity-runs]
    (step (str "Fidelity: " what))
    ;; `--import ./e2e/live/aliases.mjs` is what gives plain node the `@/` and
    ;; `@ui/` specifiers Vite gives the app. See e2e/live/aliases.mjs.
    (p/shell {:dir "plaid-igt"}
             "node" "--import" "./e2e/live/aliases.mjs" (str "e2e/fidelity/" script))))

;; The SAMPLE_PROMPT.md files are snapshots of what the model is actually
;; sent, and they rot silently: a tool changes and the file goes on describing
;; the tool as it was. `bb test` fails while any of them is stale, so this is
;; the one command that puts them right, rather than a script per app to
;; remember.
(defn write-sample-prompts! []
  (ensure-repo-root!)
  (let [py (python-exe)]
    (step "Regenerate the assistant prompt snapshots")
    (p/shell {:dir "plaid-agent" :extra-env (python-env)} py "tests/sample_prompt.py")))

;; Boot the jar unattended and assert /health reports the release version
;; (proves version.edn + the SPAs/services were bundled). Runs in a throwaway
;; temp dir so the auto-generated data/, services/, config.toml don't dirty the
;; repo. The jar's manifest carries the JDK flags, so a bare `java -jar` boots.
;; PLAID_SMOKE_PORT boots it on another port (a data/config.toml naming that
;; port is written first), for a machine where something else holds 8080.
(defn smoke-test! [version]
  (step "Smoke-test the jar (boots with a bare java -jar + reports release version)")
  (let [jar    (str (fs/absolutize (str "plaid-core/target/plaid-" version ".jar")))
        port   (or (not-empty (System/getenv "PLAID_SMOKE_PORT")) "8080")
        base   (str "http://localhost:" port)
        health ["curl" "-sf" (str base "/health")]]
    (when (zero? (:exit (apply p/sh health)))
      (fail (str "something already answers " base "/health: stop it, set PLAID_SMOKE_PORT, or pass --no-smoke")))
    (let [tmp  (fs/create-temp-dir {:prefix "plaid-smoke-"})
          _    (when (not= port "8080")
                 (fs/create-dirs (fs/path tmp "data"))
                 (spit (str (fs/path tmp "data" "config.toml")) (str "[server]\nport = " port "\n")))
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
          ;; Every bundled SPA must answer from the classpath. /health alone
          ;; passes with an app missing from resources/ or from
          ;; bundled-spa-roots, which is how an app ships invisibly broken.
          ;; A page alone passes with a wrong Vite `base`, the app then
          ;; blank, so each page's entry script and stylesheet are fetched too.
          (doseq [path (map (fn [[_ served]] (str "/" served "/")) spa-apps)]
            (let [r (p/sh ["curl" "-sf" (str base path)])]
              (when-not (and (zero? (:exit r)) (str/includes? (:out r) "<div id=\"root\""))
                (throw (ex-info (str path " did not serve its SPA from the jar") {:path path})))
              (doseq [[what pattern want] [["entry script" "<script[^>]*type=\"module\"[^>]*src=\"([^\"]+)\"" "text/javascript"]
                                           ["stylesheet" "<link[^>]*rel=\"stylesheet\"[^>]*href=\"([^\"]+)\"" "text/css"]]]
                (let [asset (second (re-find (re-pattern pattern) (:out r)))
                      url   (when asset (str base (if (str/starts-with? asset "/") asset (str path asset))))
                      a     (when url (p/sh ["curl" "-s" "-o" "/dev/null" "-w" "%{http_code} %{content_type}" url]))]
                  (when-not (and a (str/starts-with? (:out a) (str "200 " want)))
                    (throw (ex-info (str path " names no " what " the jar serves as " want
                                         (when asset (str ": " asset " answered " (:out a))))
                                    {:path path :asset asset})))))))
          (println "  bundled SPAs served at /ud/, /igt/, /dict/, /umr/, with their entry scripts and stylesheets")
          ;; The JavaScript client: the entry, its types, and every module the
          ;; entry reaches by relative import, each byte for byte the source
          ;; (the types, as the build generated them).
          (let [body  (str (fs/path tmp "client-body"))
                fetch (fn [path src]
                        (let [r (p/sh ["curl" "-sf" "-o" body "-w" "%{content_type}" (str base path)])]
                          (when-not (and (zero? (:exit r))
                                         (str/starts-with? (:out r)
                                                           (if (str/ends-with? path ".js")
                                                             "text/javascript"
                                                             "text/plain"))
                                         (java.util.Arrays/equals (fs/read-all-bytes body)
                                                                  (fs/read-all-bytes src)))
                            (throw (ex-info (str path " did not serve " src " from the jar") {:path path})))))]
            (fetch "/client/plaid-client.js" "plaid-client-js/src/index.js")
            (fetch "/client/plaid-client.d.ts" "plaid-core/resources/client/src/index.d.ts")
            (doseq [f (fs/glob "plaid-client-js/src" "*.js")
                    :let [n (str (fs/file-name f))]
                    :when (not= n "index.js")]
              (fetch (str "/client/" n) (str f)))
            (doseq [f (fs/glob "plaid-core/resources/client/src" "*.d.ts")
                    :let [n (str (fs/file-name f))]
                    :when (not= n "index.d.ts")]
              (fetch (str "/client/" n) (str f))))
          (println "  JavaScript client served at /client/plaid-client.js")
          ;; First boot must also have extracted the bundled services next to data/.
          (doseq [f ["ud_parse_stanza.py" "igt_tokenize_punkt.py" "igt_transcribe_whisper.py"
                     "umr_draft_llm.py" "umr_bootstrap_igt.py" "umr_ancast.py"]]
            (when-not (fs/exists? (fs/path tmp "services" f))
              (throw (ex-info (str "services/" f " was not extracted on first run") {}))))
          (println "  bundled services extracted on first run"))
        (finally
          (p/destroy-tree proc)
          (rm-rf tmp))))))

(def python-packages
  "The Python distributions a release publishes, in build order.

  Just the client. **The assistant (`plaid-agent`, dist `larc-plaid-agent`) is
  deliberately NOT here**: it does not go to PyPI yet (Luke's ruling,
  2026-09-12), and a distribution staged in dist-artifacts/ IS a distribution
  published, because release.yml uploads every wheel and sdist in there with
  one call. It is still tested by `bb test`, and it installs from a checkout
  (see plaid-agent/README.md). Putting it back means configuring a PyPI
  publisher for the name first, or the upload 403s and takes the client's
  publish down with it.

  `:pin-client?` stamps a package's `larc-plaid-client` floor to the release
  version; nothing needs it while the client is the only entry."
  [{:dir "plaid-client-py" :label "Python client"}])

(defn python-pyprojects []
  (mapv #(str (:dir %) "/pyproject.toml") python-packages))

(defn- stamp-pyproject [toml pep pin-client?]
  (cond-> (str/replace (slurp toml)
                       (re-pattern "(?m)^version = \"[^\"]*\"")
                       (str "version = \"" pep "\""))
    pin-client? (str/replace "\"larc-plaid-client\"" (str "\"larc-plaid-client>=" pep "\""))))

(defn build-python! [pep art]
  (let [py (python-exe)]
    ;; The PyPA `build` frontend must be importable in the active env —
    ;; install it if missing.
    (when-not (zero? (:exit (p/sh py "-c" "import build")))
      (println "  installing the `build` frontend into the active Python env…")
      (p/shell py "-m" "pip" "install" "--upgrade" "--quiet" "build"))
    (doseq [{:keys [dir label pin-client?]} python-packages]
      (step (str "Build " label " (sdist + wheel)"))
      ;; Stamp the PEP440 version (and, for packages that depend on the
      ;; client, the client floor) into pyproject, then build.
      (let [toml (str dir "/pyproject.toml")]
        (spit toml (stamp-pyproject toml pep pin-client?))
        (p/shell {:dir dir} py "-m" "build" "--outdir" (str art))))))

;; The whole release.yml `build` job, locally. No publishing.
(defn build-artifacts! [{:keys [version smoke? clients?]}]
  (ensure-repo-root!)
  (ensure-node!)
  (let [art      (fs/absolutize "dist-artifacts")
        pep      (->pep440 version)
        jar-name (str "plaid-" version ".jar")
        js-pkg   "plaid-client-js/package.json"
        js-lock  "plaid-client-js/package-lock.json"
        py-tomls (python-pyprojects)
        ;; npm version + the pyproject stamps mutate TRACKED files; snapshot
        ;; them and restore in `finally` so the build leaves the tree clean.
        js-bak   (when clients? [(slurp js-pkg) (slurp js-lock)])
        py-baks  (when clients? (mapv slurp py-tomls))]
    (println (str "\nBuilding Plaid release artifacts  (version=" version "  pep440=" pep ")"))
    (fs/create-dirs art)
    (try
      ;; --- Build the SPAs and bundle into the jar's resources -------------
      ;; `npm ci`: every app commits its package-lock.json, so a build of a tag
      ;; installs exactly what the tag says, never what is newest that day.
      ;; plaid-ui needs no step of its own: it is source-only, and each app's
      ;; `file:../plaid-ui` dependency links it in and compiles it from source.
      (doseq [[app _] spa-apps]
        (step (str "Build " app " SPA"))
        (p/shell {:dir app} "npm" "ci")
        (p/shell {:dir app} "npm" "run" "build"))

      (step "Bundle SPAs + version.edn into plaid-core/resources")
      (doseq [[app served] spa-apps]
        (rm-rf (str "plaid-core/resources/" served))
        (fs/copy-tree (str app "/dist") (str "plaid-core/resources/" served)))
      ;; The mark, for the root landing page the jar serves at /. Same file the
      ;; three SPAs serve, copied rather than duplicated (see wrap-root-landing).
      (fs/copy "plaid-ui/public/plaid.svg" "plaid-core/resources/plaid.svg" {:replace-existing true})
      (spit "plaid-core/resources/version.edn" (str "{:version \"" version "\"}\n"))
      ;; The JavaScript client, served at /client/plaid-client.js to pages that
      ;; import it instead of bundling their own (see wrap-client-js). The
      ;; package's own files in its own layout, unbundled: its modules import
      ;; each other by relative path, so a browser loads them as they are.
      ;; Its type declarations are generated from the JSDoc by tsc, one beside
      ;; each module. `npm pack` makes them again for the npm tarball.
      (rm-rf "plaid-core/resources/client")
      (fs/copy-tree "plaid-client-js/src" "plaid-core/resources/client/src")
      (step "Generate the JavaScript client's type declarations")
      (p/shell {:dir "plaid-client-js"} "npm" "ci")
      (p/shell {:dir "plaid-client-js"} "npx" "tsc" "-p" "." "--outDir" "../plaid-core/resources/client/src")

      ;; Each app's services/*.py rides the jar and is extracted next to data/
      ;; on boot. manifest.edn maps filename -> sha256 (the extractor enumerates
      ;; from it and uses the hashes for overwrite-if-unmodified semantics).
      (step "Bundle official services + manifest.edn into plaid-core/resources")
      (rm-rf "plaid-core/resources/services")
      (fs/create-dirs "plaid-core/resources/services")
      (doseq [f (concat (fs/glob "plaid-ud/services" "*.py")
                        (fs/glob "plaid-igt/services" "*.py")
                        (fs/glob "plaid-umr/services" "*.py"))]
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
        (when js-bak (spit js-pkg (first js-bak)) (spit js-lock (second js-bak)))
        (when py-baks (doseq [[toml bak] (map vector py-tomls py-baks)] (spit toml bak)))))))

(defn parse-build-args [cli-args]
  (let [flags      (set (filter (fn [a] (str/starts-with? a "--")) cli-args))
        positional (remove (fn [a] (str/starts-with? a "--")) cli-args)]
    {:version  (derive-version (first positional))
     :smoke?   (not (contains? flags "--no-smoke"))
     :clients? (not (contains? flags "--skip-clients"))}))

;; Hand-written doc pages and their Asciidoctor sources, which docs.yml builds
;; through `bb docs`. [output-file source-adoc].
(def doc-pages
  [["index.html"     "plaid-core/docs/index.adoc"]
   ["manual.html"    "plaid-core/docs/manual.adoc"]
   ["query.html"     "plaid-core/docs/query.adoc"]
   ["dev.html"       "plaid-core/docs/dev.adoc"]
   ["ud-guide.html"  "plaid-ud/docs/ud-guide.adoc"]
   ["igt-guide.html" "plaid-igt/docs/igt-guide.adoc"]
   ["umr-guide.html" "plaid-umr/docs/umr-guide.adoc"]])

;; Build the documentation site into _site/, as docs.yml does before it
;; publishes. _site/ is gitignored.
;; The API references are generated from the JS/Py client source by a node
;; script; it's best-effort here, since it isn't needed to preview the
;; hand-written pages and only needs node, not the SPA toolchain.
(defn build-docs! []
  (ensure-repo-root!)
  (when-not (fs/which "asciidoctor")
    (fail "asciidoctor not found on PATH — install it with `gem install asciidoctor coderay`"))
  (let [site (fs/absolutize "_site")]
    (step (str "Build docs into " site " (mirrors .github/workflows/docs.yml)"))
    (fs/create-dirs site)
    ;; The mark, for the tab and for the landing page. One copy, shared with the
    ;; three apps, which serve it out of the same directory.
    (fs/copy "plaid-ui/public/plaid.svg" (fs/path site "plaid.svg") {:replace-existing true})
    ;; The favicon link lives in a shared docinfo.html. The sources sit in three
    ;; directories and asciidoctor resolves docinfodir against each one, so it
    ;; has to be absolute.
    (let [docinfo (str (fs/absolutize "plaid-core/docs"))]
      (doseq [[out src] doc-pages]
        (println "  •" out)
        (p/shell "asciidoctor" "-a" "docinfo=shared" "-a" (str "docinfodir=" docinfo)
                 "-o" (str (fs/path site out)) src)))
    (step "Generate JS/Py API references (best-effort, needs node)")
    (if (fs/which "node")
      (let [r (p/sh "node" "plaid-core/docs/extract-api-docs.js")]
        (if (zero? (:exit r))
          (println "  • api-js.html / api-py.html")
          (println "  ⚠ skipped API docs — extract-api-docs.js failed:\n" (:err r))))
      (println "  ⚠ skipped API docs — node not on PATH (the other pages still built)"))
    (println (str "\n✓ docs built — open " (fs/path site "index.html") " in a browser"))
    (println (str "  or serve: cd " site " && python3 -m http.server 8000"))))

(defn clean! []
  (ensure-repo-root!)
  (doseq [pth (concat ["dist-artifacts"
                       "_site"
                       "plaid-core/resources/services"
                       "plaid-core/resources/version.edn"
                       "plaid-core/resources/plaid.svg"
                       "plaid-core/resources/client"]
                      (mapcat (fn [[app served]] [(str "plaid-core/resources/" served) (str app "/dist")])
                              spa-apps))]
    (rm-rf pth))
  (doseq [j (fs/glob "plaid-core/target" "plaid-*.jar")]
    (fs/delete j))
  (doseq [d (fs/glob "plaid-client-js/src" "*.d.ts")]
    (fs/delete d))
  (println "✓ cleaned local build outputs"))

;; The release gate. A tag is cut and built only on a commit that already
;; passed CI (ci.yml, the per-push check) and a nightly (nightly.yml: every
;; unit suite, the fidelity round trips and e2e). release.yml used to run
;; `bb test` again on a fresh runner, and timing flakes there burned five
;; version numbers (alpha.24, .25, .27, .28 and .31) with no real bug among
;; them. `bb release` runs this before it tags and release.yml before it
;; builds, so both read the same runs on GitHub.
;;
;; A run counts when it finished with success AND every one of its jobs did.
;; A quiet night's nightly reports success with its suites skipped, which
;; tested nothing.
(def ^:private release-gate-workflows
  [{:file "ci.yml" :name "CI" :events #{"push"}
    :how "push the commit to master (git push origin master) and wait for CI"}
   {:file "nightly.yml" :name "Nightly Tests" :events #{"schedule" "workflow_dispatch"}
    :how "run one on master's head with `gh workflow run nightly.yml --ref master` and wait for it"}])

(defn- gh-api [path]
  (let [{:keys [exit out err]} (p/sh "gh" "api" path)]
    (when-not (zero? exit)
      (fail (str "`gh api " path "` failed: " (str/trim (str err)))))
    (json/parse-string out true)))

(defn- run-jobs-passed? [run]
  (let [jobs (:jobs (gh-api (str "repos/{owner}/{repo}/actions/runs/" (:id run) "/jobs?per_page=100")))]
    (and (seq jobs) (every? #(= "success" (:conclusion %)) jobs))))

(defn- workflow-verdict
  "nil when `sha` has a passing run of the workflow, else why not."
  [sha {:keys [file name events how]}]
  (let [runs (->> (:workflow_runs
                   (gh-api (str "repos/{owner}/{repo}/actions/workflows/" file
                                "/runs?head_sha=" sha "&per_page=100")))
                  (filter #(contains? events (:event %))))
        done (filter #(= "completed" (:status %)) runs)
        won  (filter #(= "success" (:conclusion %)) done)]
    (cond
      (some run-jobs-passed? won) nil
      (empty? runs)
      (str name " has no " (str/join " or " (sort events)) " run on this commit: " how ".")
      (seq won)
      (str name " passed on this commit only with jobs skipped (" (str/join ", " (map :html_url won))
           "), so its suites did not run: " how ".")
      (empty? done)
      (str name " is still running on this commit (" (str/join ", " (map :html_url runs)) "): wait for it.")
      :else
      (str name " did not pass on this commit ("
           (str/join ", " (map #(str (:conclusion %) " " (:html_url %)) done))
           "): fix the failure, or if it was a flake re-run it with `gh run rerun --failed <id>`, or " how "."))))

(defn release-gate!
  "Exit non-zero unless `rev` (default HEAD) has passed CI and a nightly."
  [rev]
  (ensure-repo-root!)
  (when-not (fs/which "gh")
    (fail "gh (the GitHub CLI) is not on PATH: the release gate reads CI and nightly runs through it"))
  (let [{:keys [exit out]} (p/sh "git" "rev-parse" "--verify" (str (or rev "HEAD") "^{commit}"))
        sha (str/trim out)]
    (when-not (zero? exit)
      (fail (str "not a commit: " rev)))
    (step (str "Check that CI and a nightly passed on " sha))
    (let [problems (keep #(workflow-verdict sha %) release-gate-workflows)]
      (when (seq problems)
        (binding [*out* *err*]
          (doseq [msg problems] (println "✗" msg)))
        (fail (str "no release from " sha " until CI and a nightly have both passed on it."
                   " Nothing was built, so a release run stopped here is re-run as it is once they pass"
                   " (gh run rerun <run id>), at the same version number.")))
      (println "✓ CI and a nightly passed on" sha))))
