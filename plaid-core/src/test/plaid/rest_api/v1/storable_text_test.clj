(ns plaid.rest-api.v1.storable-text-test
  "A NUL or an unpaired surrogate is refused with a 400 on every route a
  plain-text column is written through. The SQLite driver stores an unpaired
  surrogate as `?`, and the query engine reads a body as ending at a NUL
  (PROP findings 4 and 5, 2026-09-26)."
  (:require [clojure.data.json :as json]
            [clojure.test :refer :all]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler admin-request
                                    rest-handler parse-response-body
                                    assert-created assert-ok
                                    with-admin with-test-users with-clean-db]]
            [plaid.test-helpers :refer :all]
            [plaid.util.storable-text :as storable]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; Written with escapes so neither this file nor the request encoder can
;; repair the lone surrogate before it reaches the server.
(def ^:private lone-high (str "a" (char 0xD83D) "z"))
(def ^:private lone-low (str "a" (char 0xDE00) "z"))
(def ^:private nul (str "a" (char 0) "z"))
(def ^:private bad-strings {"NUL" nul "lone high surrogate" lone-high "lone low surrogate" lone-low})

(defn- call
  "Send `body` as JSON with every non-ASCII character escaped, which keeps a
  lone surrogate intact on the wire, and return {:status :body}."
  [method path body]
  (let [resp (rest-handler (-> (admin-request method path)
                               (mock/content-type "application/json")
                               (mock/body (json/write-str body))))]
    {:status (:status resp)
     :body (when (and (:body resp) (not= "" (:body resp)))
             (try (parse-response-body resp) (catch Exception _ nil)))}))

(deftest problem-names-the-first-bad-character
  (is (nil? (storable/problem "")))
  (is (nil? (storable/problem "plain")))
  (is (nil? (storable/problem "😀 é 𐌰")))
  (is (= "a NUL character (U+0000) at position 1" (storable/problem nul)))
  (is (= "an unpaired surrogate (U+D83D) at position 1" (storable/problem lone-high)))
  (is (= "an unpaired surrogate (U+DE00) at position 1" (storable/problem lone-low)))
  (testing "positions count code points"
    (is (= "a NUL character (U+0000) at position 2" (storable/problem (str "😀x" (char 0))))))
  (testing "a surrogate at the very end has no partner"
    (is (some? (storable/problem (str "ab" (char 0xD83D)))))))

(deftest text-bodies-refuse-what-a-column-cannot-hold
  (let [proj (create-test-project admin-request "StorableProj")
        doc (create-test-document admin-request proj "Doc")
        doc2 (create-test-document admin-request proj "Doc2")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tid (-> (create-text admin-request tl doc "kai tat") :body :id)]
    (doseq [[label s] bad-strings]
      (testing (str "create, " label)
        (is (= 400 (:status (call :post "/api/v1/texts"
                                  {:text-layer-id tl :document-id doc2 :body s}))))))
    (assert-created (create-text admin-request tl doc2 "😀 fine"))
    (doseq [[label s] bad-strings]
      (testing (str "whole-body update, " label)
        (is (= 400 (:status (call :patch (str "/api/v1/texts/" tid) {:body s})))))
      (testing (str "an explicit insert op, " label)
        (is (= 400 (:status (call :patch (str "/api/v1/texts/" tid)
                                  {:body [{:type "insert" :index 3 :value s}]}))))))
    (testing "nothing was written"
      (is (= "kai tat" (-> (get-text admin-request tid) :body :text/body))))))

(deftest names-forms-and-keys-refuse-what-a-column-cannot-hold
  (let [proj (create-test-project admin-request "StorableNames")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tid (-> (create-text admin-request tl doc "kai") :body :id)
        vocab (-> (create-vocab-layer admin-request "Lex") :body :id)
        item (-> (call :post "/api/v1/vocab-items" {:vocab-layer-id vocab :form "kai"}) :body :id)]
    (doseq [[label s] bad-strings]
      (testing label
        (is (= 400 (:status (call :post "/api/v1/documents" {:project-id proj :name s}))) "document create")
        (is (= 400 (:status (call :patch (str "/api/v1/documents/" doc) {:name s}))) "document rename")
        (is (= 400 (:status (call :post "/api/v1/projects" {:name s}))) "project create")
        (is (= 400 (:status (call :post "/api/v1/text-layers" {:project-id proj :name s}))) "layer create")
        (is (= 400 (:status (call :post "/api/v1/vocab-items" {:vocab-layer-id vocab :form s}))) "form create")
        (is (= 400 (:status (call :patch (str "/api/v1/vocab-items/" item) {:form s}))) "form update")
        (is (= 400 (:status (call :post "/api/v1/vocab-items/bulk"
                                  [{:vocab-layer-id vocab :form "ok"} {:vocab-layer-id vocab :form s}])))
            "form bulk create")
        (is (= 400 (:status (call :patch "/api/v1/vocab-items/bulk" [{:id item :form s}])))
            "form bulk update")
        (is (= 400 (:status (call :put (str "/api/v1/texts/" tid "/metadata") {s 1}))) "metadata key")
        (is (= 400 (:status (call :post "/api/v1/comments"
                                  {:entity-type "text" :entity-id tid :body s})))
            "comment")
        (is (= 400 (:status (call :post (str "/api/v1/projects/" proj "/guidelines")
                                  {:title s :body ""})))
            "guideline title")
        (is (= 400 (:status (call :post (str "/api/v1/projects/" proj "/guidelines")
                                  {:title "Glossing" :body s})))
            "guideline body")))
    (testing "nothing was written"
      (assert-ok (get-text admin-request tid))
      (is (= "Doc" (-> (call :get (str "/api/v1/documents/" doc) nil) :body :document/name)))
      (is (= "kai" (-> (call :get (str "/api/v1/vocab-items/" item) nil) :body :vocab-item/form))))))
