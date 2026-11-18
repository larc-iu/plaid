(ns plaid.rest-api.v1.visible-name-test
  "A name must hold at least one visible character (Luke, 2026-11-18). A name
  made only of whitespace, control and format characters and the other
  default-ignorable code points is refused with the 400 a blank name gets, on
  every create and rename that takes a name. A name with a visible character
  is stored exactly as sent, invisible characters and all."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler admin-request
                                    api-call assert-created assert-ok
                                    with-admin with-test-users with-clean-db]]
            [plaid.test-helpers :refer :all]
            [plaid.sql.common :as psc]
            [plaid.sql.user]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- s
  "A string of the given code points."
  [& cps]
  (let [sb (StringBuilder.)]
    (doseq [cp cps] (.appendCodePoint sb (int cp)))
    (str sb)))

(def ^:private zwsp (s 0x200B))

(def ^:private invisible-names
  "Names with nothing visible in them, one per kind of invisible character."
  {"a zero-width space" zwsp
   "a zero-width space and a zero-width non-joiner" (s 0x200B 0x200C)
   "spaces" "   "
   "a no-break space" (s 0xA0)
   "an ideographic space" (s 0x3000)
   "a tab and a newline" (s 9 10)
   "a byte order mark" (s 0xFEFF)
   "bidi marks" (s 0x200E 0x200F 0x2066 0x2069)
   "a soft hyphen" (s 0xAD)
   "a word joiner" (s 0x2060)
   "a combining grapheme joiner" (s 0x34F)
   "a variation selector" (s 0xFE0F)
   "a supplementary variation selector" (s 0xE0100)
   "a Hangul filler" (s 0x3164)
   "a halfwidth Hangul filler" (s 0xFFA0)
   "a Mongolian free variation selector" (s 0x180B)
   "a tag character" (s 0xE0041)
   "a line separator" (s 0x2028)})

(def ^:private visible-names
  "Names with a visible character, stored as sent."
  ["a" (s 0x0915 0x094D 0x200D) (s 0x200B 0x61) (s 0x61 0x200C 0x62) (s 0x2800)
   (s 0x1F44D 0x1F3FD) (s 0x0301) "x y"])

(def ^:private concatenation-marks
  "The prepended concatenation marks: Cf, but drawn, so not default-ignorable.
  A name of one alone is visible (REV-RL2-3)."
  [0x0600 0x0601 0x0602 0x0603 0x0604 0x0605 0x06DD 0x070F 0x0890 0x0891 0x08E2 0x110BD 0x110CD])

(deftest the-predicate
  (doseq [[label n] invisible-names]
    (testing label (is (not (psc/visible? n)))))
  (is (not (psc/visible? "")))
  (doseq [n visible-names]
    (testing (pr-str n) (is (psc/visible? n))))
  (doseq [cp concatenation-marks]
    (testing (format "U+%04X" cp) (is (psc/visible? (s cp)))))
  (testing "beside spaces too"
    (is (psc/visible? (s 0x20 0x06DD 0x20)))))

(deftest an-email-is-not-a-name
  ;; The first admin's console prompt passes what was typed as it is.
  (is (= "User ID must be an email address"
         (try (plaid.sql.user/assert-valid-email! zwsp) nil
              (catch clojure.lang.ExceptionInfo e (ex-message e))))))

(defn- call [method path body]
  (api-call admin-request {:method method :path path :body body}))

(defn- refused-as-blank? [resp]
  (and (= 400 (:status resp))
       (= "Name cannot be blank" (-> resp :body :error))))

(deftest every-name-refuses-an-invisible-one
  (let [proj (create-test-project admin-request "Names")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tkl (-> (call :post "/api/v1/token-layers" {:text-layer-id tl :name "Words"}) :body :id)
        sl (-> (create-span-layer admin-request tkl "Gloss") :body :id)
        rl (-> (create-relation-layer admin-request sl "Deps") :body :id)
        vocab (-> (create-vocab-layer admin-request proj "Lex") :body :id)
        routes (fn [n]
                 [["document create" :post "/api/v1/documents" {:project-id proj :name n}]
                  ["document rename" :patch (str "/api/v1/documents/" doc) {:name n}]
                  ["document copy" :post (str "/api/v1/documents/" doc "/copy") {:name n}]
                  ["document copy taking a free name" :post (str "/api/v1/documents/" doc "/copy")
                   {:name n :free-name true}]
                  ["project create" :post "/api/v1/projects" {:name n}]
                  ["project rename" :patch (str "/api/v1/projects/" proj) {:name n}]
                  ["text layer create" :post "/api/v1/text-layers" {:project-id proj :name n}]
                  ["text layer rename" :patch (str "/api/v1/text-layers/" tl) {:name n}]
                  ["token layer create" :post "/api/v1/token-layers" {:text-layer-id tl :name n}]
                  ["token layer rename" :patch (str "/api/v1/token-layers/" tkl) {:name n}]
                  ["span layer create" :post "/api/v1/span-layers" {:token-layer-id tkl :name n}]
                  ["span layer rename" :patch (str "/api/v1/span-layers/" sl) {:name n}]
                  ["relation layer create" :post "/api/v1/relation-layers" {:span-layer-id sl :name n}]
                  ["relation layer rename" :patch (str "/api/v1/relation-layers/" rl) {:name n}]
                  ["vocabulary create" :post "/api/v1/vocab-layers" {:name n :project-id proj}]
                  ["vocabulary rename" :patch (str "/api/v1/vocab-layers/" vocab) {:name n}]
                  ["API token create" :post "/api/v1/users/admin@example.com/tokens" {:name n}]])]
    (doseq [[label n] invisible-names
            [what method path body] (routes n)]
      (testing (str what ", " label)
        (is (refused-as-blank? (call method path body)))))
    (testing "nothing was renamed"
      (is (= "Doc" (-> (call :get (str "/api/v1/documents/" doc) nil) :body :document/name)))
      (is (= "Names" (-> (call :get (str "/api/v1/projects/" proj) nil) :body :project/name)))
      (is (= "TL" (-> (call :get (str "/api/v1/text-layers/" tl) nil) :body :text-layer/name)))
      (is (= "Lex" (-> (call :get (str "/api/v1/vocab-layers/" vocab) nil) :body :vocab/name))))))

(deftest a-name-with-a-visible-character-is-stored-as-sent
  (let [proj (create-test-project admin-request "Names")
        doc (create-test-document admin-request proj "Doc")]
    (doseq [n visible-names]
      (testing (pr-str n)
        (assert-ok (call :patch (str "/api/v1/documents/" doc) {:name n}))
        (is (= n (-> (call :get (str "/api/v1/documents/" doc) nil) :body :document/name)))))
    (testing "a create keeps a zero-width joiner inside a word"
      (let [n (s 0x0915 0x094D 0x200D 0x0937)]
        (assert-created (call :post "/api/v1/documents" {:project-id proj :name n}))
        (assert-created (call :post "/api/v1/projects" {:name n}))
        (assert-created (call :post "/api/v1/vocab-layers" {:name n :project-id proj}))))))

(deftest a-display-name-refuses-an-invisible-one-in-its-own-words
  (let [create (fn [email body]
                 (call :post "/api/v1/users" (merge {:email email :password "a-fine-password"
                                                     :is-admin false}
                                                    body)))
        fetch (fn [id] (:body (call :get (str "/api/v1/users/" id) nil)))]
    (assert-created (create "nomen@example.com" {:display-name "Grace"}))
    (doseq [[label n] invisible-names]
      (testing label
        (let [r (call :patch "/api/v1/users/nomen@example.com" {:display-name n})]
          (is (= 400 (:status r)))
          (is (= "Display name cannot be blank" (-> r :body :error))))))
    (is (= "Grace" (:user/display-name (fetch "nomen@example.com"))))
    (testing "an empty one keeps its words"
      (is (= "Name is too short: minimum is 1, got 0"
             (-> (call :patch "/api/v1/users/nomen@example.com" {:display-name ""}) :body :error))))
    (testing "at creation an invisible display name counts as none, as a blank one does"
      (assert-created (create "ghost@example.com" {:display-name zwsp}))
      (is (= "ghost" (:user/display-name (fetch "ghost@example.com"))))
      (assert-created (create "blank@example.com" {:display-name "  "}))
      (is (= "blank" (:user/display-name (fetch "blank@example.com")))))
    (testing "an invite redeemed with an invisible display name takes the default"
      (let [code (-> (call :post "/api/v1/invites" {:max-uses 1}) :body :code)]
        (assert-ok (api-call (fn [m p] (-> (admin-request m p) (dissoc :headers)
                                           (assoc-in [:headers "accept"] "application/edn")))
                             {:method :post :path "/api/v1/invites/redeem"
                              :body {:code code :email "invitee@example.com"
                                     :password "a-fine-password" :display-name zwsp}}))
        (is (= "invitee" (:user/display-name (fetch "invitee@example.com"))))))))

(deftest a-guideline-title-refuses-an-invisible-one-in-its-own-words
  (let [proj (create-test-project admin-request "Guides")
        made (call :post (str "/api/v1/projects/" proj "/guidelines") {:title "Glossing" :body ""})
        gid (-> made :body :id)]
    (assert-created made)
    (doseq [[label n] invisible-names]
      (testing label
        (let [c (call :post (str "/api/v1/projects/" proj "/guidelines") {:title n :body ""})
              p (call :patch (str "/api/v1/guidelines/" gid) {:title n})]
          (is (= 400 (:status c)))
          (is (= "Guideline title cannot be blank" (-> c :body :error)))
          (is (= 400 (:status p)))
          (is (= "Guideline title cannot be blank" (-> p :body :error))))))))

(deftest what-is-not-a-name-is-left-alone
  (let [proj (create-test-project admin-request "Others")
        vocab (-> (create-vocab-layer admin-request proj "Lex") :body :id)]
    (testing "an entry's form, which has no not-blank rule"
      (assert-created (call :post "/api/v1/vocab-items" {:vocab-layer-id vocab :form zwsp})))
    (testing "an invite's note"
      (assert-created (call :post "/api/v1/invites" {:note zwsp :max-uses 1})))))
