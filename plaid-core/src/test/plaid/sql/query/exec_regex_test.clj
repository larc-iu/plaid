(ns plaid.sql.query.exec-regex-test
  "Integration tests for regex value matching ({value {regex .. flags ..}}),
  backed by the REGEXP UDF registered per query connection. :value is matched
  against the JSON-decoded scalar so anchors work."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.sql.query.exec :as qe]
            [plaid.query.ast :as ast]
            [plaid.util.canonical :as canonical]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))

(defn- values
  "Run a query returning ?s spans, then read each span's value (the set of
  matched lemma strings)."
  [where]
  (let [r (qe/run db "admin@example.com" {"find" ["?s"] "where" where})]
    (set (map (fn [[sid]] (:span/value (:body (h/get-span admin-request sid))))
              (:results r)))))

(defn- build!
  "A lemma span layer with values walking / walks / talked / ran / WALK."
  []
  (let [pid  (h/create-test-project admin-request "RxProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "lemma"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "a b c d e"))
        mk   (fn [b e v] (let [t (id (h/create-token admin-request tokl text b e))]
                           (h/create-span admin-request sl [t] v)))]
    (mk 0 1 "walking")
    (mk 2 3 "walks")
    (mk 4 5 "talked")
    (mk 6 7 "ran")
    (mk 8 9 "WALK")
    {:sl sl}))

(deftest regex-unanchored
  (let [{:keys [sl]} (build!)]
    (testing "substring-style match finds both walk* forms"
      (is (= #{"walking" "walks"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "walk"}}]]))))))

(deftest regex-anchored
  (let [{:keys [sl]} (build!)]
    (testing "anchors work because the regex runs on the decoded scalar, not the JSON"
      (is (= #{"walking"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "^walking$"}}]])))
      (is (= #{"talked"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "ed$"}}]]))))))

(deftest regex-case-insensitive
  (let [{:keys [sl]} (build!)]
    (testing "flags i folds case"
      (is (= #{"walking" "walks" "WALK"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "walk" "flags" "i"}}]]))))
    (testing "without the flag, case matters"
      (is (= #{"WALK"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "WALK"}}]]))))))

(deftest regex-unicode-case-folding
  ;; The `i` flag compiles to `(?iu)`, so case folding is Unicode-aware, not
  ;; ASCII-only. Under a bare `(?i)` the first assertion would fail.
  (let [pid  (h/create-test-project admin-request "RxUni")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "lemma"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "a"))
        t0   (id (h/create-token admin-request tokl text 0 1))]
    (h/create-span admin-request sl [t0] "ЦИЯ")  ; uppercase Cyrillic
    (testing "flags i folds case for non-ASCII letters"
      (is (= #{"ЦИЯ"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "ция$" "flags" "i"}}]]))))
    (testing "without the flag, non-ASCII case still matters"
      (is (= #{}
             (values [["span" "?s" {"layer" sl "value" {"regex" "ция$"}}]]))))))

(deftest regex-composes-with-not
  (let [{:keys [sl]} (build!)]
    (testing "spans NOT matching walk.* — same span correlated, regex negated"
      (is (= #{"talked" "ran"}
             (values [["span" "?s" {"layer" sl}]
                      ["not" ["span" "?s" {"layer" sl "value" {"regex" "walk" "flags" "i"}}]]]))))))

(deftest regex-redos-is-aborted
  (let [pid  (h/create-test-project admin-request "RxDos")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "w"))
        sl   (id (h/create-span-layer admin-request tokl "lemma"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "x"))
        t0   (id (h/create-token admin-request tokl text 0 1))]
    (h/create-span admin-request sl [t0] (apply str (repeat 32 "a")))
    (testing "a catastrophic-backtracking pattern is aborted by the watchdog, not hung"
      ;; (.*a){28} over 32 a's runs ~6.7s unbounded in pure Java, which SQLite's
      ;; interrupt can't reach — interruptible-cs + worker interrupt must. (A
      ;; trivial "(a+)+b" is optimized away by the JDK, so use this measured one.)
      (binding [qe/*query-timeout-ms* 1000]
        (let [start (System/nanoTime)
              code (try (qe/run db "admin@example.com"
                                {"find" ["?s"]
                                 "where" [["span" "?s" {"layer" sl "value" {"regex" "(.*a){28}"}}]]})
                        nil
                        (catch clojure.lang.ExceptionInfo e (:code (ex-data e))))
              ms   (/ (- (System/nanoTime) start) 1e6)]
          (is (= 408 code) "must abort with a 408 timeout")
          (is (< ms 20000) (str "must not hang past the limit (took " (long ms) "ms)")))))))

(deftest regex-validation
  (testing "an invalid pattern is a 400 at validation time"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"invalid regex"
         (ast/expand {"find" ["?s"]
                      "where" [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" "(unclosed"}}]]}))))
  (testing "regex on a non-text key is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"does not support a regex"
         (ast/expand {"find" ["?t"]
                      "where" [["token" "?t" {"layer" "RxProj/words" "begin" {"regex" "1"}}]]}))))
  (testing "unsupported flags are a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"flags .* unsupported"
         (ast/expand {"find" ["?s"]
                      "where" [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" "x" "flags" "g"}}]]})))))

(deftest a-long-any-case-pattern-is-taken
  ;; The clients send an any-case search as a class per letter (`[wW]`), so a
  ;; search of about 110 letters passed the old 512-character cap.
  (let [{:keys [sl]} (build!)
        any-case (fn [s] (apply str (map #(str "[" (Character/toLowerCase (char %)) (Character/toUpperCase (char %)) "]") s)))
        long-pattern (str (any-case "walk") "|" (any-case (apply str (repeat 200 "x"))))]
    (is (< 512 (count long-pattern) 4096))
    (is (= #{"walking" "walks" "WALK"}
           (values [["span" "?s" {"layer" sl "value" {"regex" long-pattern}}]]))))
  (testing "past 4,096 characters is a 400"
    (is (thrown-with-msg?
         clojure.lang.ExceptionInfo #"too long \(max 4096"
         (ast/expand {"find" ["?s"]
                      "where" [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" (apply str (repeat 4097 "a"))}}]]})))))

(deftest word-and-digit-classes-read-every-script
  ;; Ruled 2026-10-02: `\w`, `\d` and `\b` read any script, as the apps'
  ;; translators do. Under Java's defaults `^\w+$` found only the ASCII value.
  (let [pid  (h/create-test-project admin-request "RxScripts")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "form"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "a b c d e f"))
        mk   (fn [b v] (h/create-span admin-request sl [(id (h/create-token admin-request tokl text b (inc b)))] v))]
    (mk 0 "الكتاب")
    (mk 2 "кьил")
    (mk 4 "鳥")
    (mk 6 "٣٤")
    (mk 8 "walk")
    (mk 10 "a-b")
    (testing "\\w is a letter, mark, digit or connector in any script"
      (is (= #{"الكتاب" "кьил" "鳥" "٣٤" "walk"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "^\\w+$"}}]]))))
    (testing "\\W is the rest"
      (is (= #{"a-b"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "\\W"}}]]))))
    (testing "\\d is a decimal digit in any script"
      (is (= #{"٣٤"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "^\\d+$"}}]]))))
    (testing "\\b sees a boundary next to a non-Latin letter"
      (is (= #{"الكتاب"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "\\bال"}}]]))))
    (testing "with the i flag too"
      (is (= #{"кьил"}
             (values [["span" "?s" {"layer" sl "value" {"regex" "^КЬ\\w+$" "flags" "i"}}]]))))))

(deftest the-unicode-reading-adds-nothing-to-the-length-cap
  (testing "a pattern of exactly 4,096 characters is taken"
    (is (ast/expand {"find" ["?s"]
                     "where" [["span" "?s" {"layer" "RxProj/lemma" "value" {"regex" (apply str (repeat 4096 "a"))}}]]}))))

(deftest regex-matches-canonically-equivalent-text
  ;; H10-SCRIPTS-5: a gloss stored decomposed (a + U+0301) was never found by a
  ;; pattern typed composed, so the assistant's search and a replacement found
  ;; nothing. Pattern and value are both read in NFC.
  (let [pid  (h/create-test-project admin-request "RxNfd")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "gloss"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "a b c"))
        mk   (fn [b v] (h/create-span admin-request sl [(id (h/create-token admin-request tokl text b (inc b)))] v))
        nfd  "pʰá.PL"
        nfc  "pʰá"]
    (mk 0 nfd)
    (mk 2 nfc)
    (mk 4 "pʰa")
    (testing "a composed pattern finds the decomposed value and the composed one"
      (is (= #{nfd nfc} (values [["span" "?s" {"layer" sl "value" {"regex" "pʰá"}}]]))))
    (testing "a decomposed pattern finds both too"
      (is (= #{nfd nfc} (values [["span" "?s" {"layer" sl "value" {"regex" "pʰá"}}]]))))
    (testing "a bare letter does not match inside an accented one"
      (is (= #{"pʰa"} (values [["span" "?s" {"layer" sl "value" {"regex" "a$"}}]]))))))

(deftest regex-keeps-every-match-the-stored-text-gives
  ;; REV-FX11: reading the value only in NFC lost what a pattern found in the
  ;; value as stored. A combining acute searched for on its own (high tone)
  ;; no longer found it in "pʰá" stored decomposed. A value matches as stored
  ;; or in NFC.
  (let [pid  (h/create-test-project admin-request "RxMark")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "gloss"))
        doc  (h/create-test-document admin-request pid "d")
        text (id (h/create-text admin-request txtl doc "a b c"))
        mk   (fn [b v] (h/create-span admin-request sl [(id (h/create-token admin-request tokl text b (inc b)))] v))
        nfd  "p\u02b0a\u0301"
        nfc  "p\u02b0\u00e1"
        eng  "\u014b\u0301"]
    (mk 0 nfd)
    (mk 2 nfc)
    (mk 4 eng)
    (testing "a combining mark alone finds it where it is stored as a mark"
      (is (= #{nfd eng} (values [["span" "?s" {"layer" sl "value" {"regex" "\u0301"}}]]))))
    (testing "a class of marks too"
      (is (= #{nfd eng} (values [["span" "?s" {"layer" sl "value" {"regex" "\\p{M}"}}]]))))
    (testing "and a composed pattern still finds both spellings of the letter"
      (is (= #{nfd nfc} (values [["span" "?s" {"layer" sl "value" {"regex" "\u00e1$"}}]]))))))

(deftest equality-matches-canonically-equivalent-text
  ;; Luke, 2026-10-08: igt Search's "is exactly" and Bulk Edit's exact match
  ;; find composed and decomposed spellings of the same text, as a regex
  ;; does. Every equality with a text literal in the query language does.
  (let [pid  (h/create-test-project admin-request "EqNfd")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "gloss"))
        doc  (h/create-test-document admin-request pid "d")
        nfd  "p\u02b0a\u0301"
        nfc  "p\u02b0\u00e1"
        text (id (h/create-text admin-request txtl doc (str nfd " " nfc " pa K xy")))
        tok  (fn [b e] (id (h/create-token admin-request tokl text b e)))
        mk   (fn [b e v] (h/create-span admin-request sl [(tok b e)] v))
        tokens (fn [where] (set (map first (:results (qe/run db "admin@example.com" {"find" ["?t"] "where" where})))))]
    (mk 0 4 nfd)
    (mk 5 8 nfc)
    (mk 9 11 "p\u02b0a")
    (mk 12 13 "\u212a")
    (doseq [lit [nfc nfd]]
      (testing (str "a bare value " (pr-str lit) " finds both spellings and nothing else")
        (is (= #{nfd nfc} (values [["span" "?s" {"layer" sl "value" lit}]]))))
      (testing "a list beside a text with one spelling"
        (is (= #{nfd nfc "p\u02b0a"} (values [["span" "?s" {"layer" sl "value" [lit "p\u02b0a"]}]]))))
      (testing "= and != and in"
        (is (= #{nfd nfc} (values [["span" "?s" {"layer" sl}] ["=" "?s.value" lit]])))
        (is (= #{"p\u02b0a" "\u212a"} (values [["span" "?s" {"layer" sl}] ["!=" "?s.value" lit]])))
        (is (= #{nfd nfc} (values [["span" "?s" {"layer" sl}] ["in" "?s.value" [lit]]]))))
      (testing "a token's surface"
        (is (= 2 (count (tokens [["token" "?t" {"layer" tokl "value" lit}]]))))))
    (testing "a metadata value keeps to its type: a text equals a string, never an array"
      (let [md (fn [b v] (h/create-span admin-request sl [(tok b (inc b))] "m" {"form" v}))]
        (md 14 nfd)
        (md 15 [nfc])
        (is (= 1 (count (values [["span" "?s" {"layer" sl "metadata" {"form" nfc}}]]))))
        (is (= 0 (count (values [["span" "?s" {"layer" sl "metadata" {"form" (str "[\"" nfc "\"]")}}]]))))))
    (testing "KELVIN SIGN is K"
      (is (= #{"\u212a"} (values [["span" "?s" {"layer" sl "value" "K"}]]))))
    (testing "a text with one spelling compares the stored text"
      (is (= #{"p\u02b0a"} (values [["span" "?s" {"layer" sl "value" "p\u02b0a"}]]))))))

(deftest only-spelling-is-exact-about-which-texts-have-another
  (testing "texts no other string is canonically equivalent to, compared by the index"
    (doseq [s ["walking" "VASP.3SG" "\u0643\u062a\u0627\u0628" "\u0441\u043b\u043e\u0432\u043e" "" "a-b c"]]
      (is (canonical/only-spelling? s) (pr-str s))))
  (testing "texts with another spelling"
    (doseq [s ["\u00e1" "a\u0301" "K" "\u212a" "\uac00" "\u1100\u1161" "\u0995\u09be" "\u8c48" "x\u0302"]]
      (is (not (canonical/only-spelling? s)) (pr-str s)))))
