(ns plaid.rest-api.v1.idempotency
  "The `Idempotency-Key` request header.

  A write sent with a key runs in one transaction with a row that records
  its answer (`plaid.sql.idempotency`). The same key sent again by the same
  user, for the same request, is answered from that row: the stored status,
  body and document-version headers, plus `Idempotent-Replayed: true`, and
  nothing is written. The same key for a different request is refused with
  422. Only a 2xx answer is stored, since every other answer wrote nothing,
  so a retry of a refused write runs again.

  The replay is answered before the route's own gates run (access,
  `document-version`), because a strict retry of a write that landed claims
  the version the landing moved past. It only repeats to the same user what
  they were already told.

  Routes that a batch cannot carry, or whose answer is a secret, say
  `:plaid/idempotency false` in their route data and refuse a key with 400.
  `/batch` says `:plaid/idempotency :batch`: its own transaction looks the
  key up and stores it (`plaid.rest-api.v1.batch/*pending-key*`)."
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [muuntaja.core :as m]
            [plaid.rest-api.v1.batch :as batch]
            [plaid.server.log-buffer :as log-buffer]
            [plaid.sql.idempotency :as idem])
  (:import (java.io InputStream)
           (java.nio.charset StandardCharsets)
           (java.security MessageDigest)))

(def header-name "idempotency-key")

(def replayed-header "Idempotent-Replayed")

(def ^:private key-pattern #"[A-Za-z0-9._:-]{8,128}")

(def ^:private label-params
  "Query parameters that label a write rather than say what it does. A
  resend may carry other labels (a renamed operation), and that is still
  the same request."
  #{"group-id" "group-message" "group-kind" "group-ref" "audit-message"})

(def ^:private stored-headers
  ["X-Document-Versions" "X-Document-Versions-Omitted"])

(defn- decode-component [^String s]
  (try (java.net.URLDecoder/decode s "UTF-8")
       (catch IllegalArgumentException _ s)))

(defn- normalized-query
  "The query string's parameters without the labels, decoded and sorted,
  as a list of [name value] pairs, or nil when none are left."
  [query-string]
  (when-not (str/blank? query-string)
    (some->> (str/split query-string #"&")
             (remove str/blank?)
             (map (fn [pair]
                    (let [[k v] (str/split pair #"=" 2)]
                      [(str/lower-case (decode-component k)) (some-> v decode-component)])))
             (remove (comp label-params first))
             (sort-by (juxt first second))
             seq
             vec)))

(defn- sorted-deep
  "`x` with every map's keys in order, so equal bodies write equal JSON."
  [x]
  (cond
    (map? x) (into (sorted-map-by (fn [a b] (compare (str a) (str b))))
                   (map (fn [[k v]] [k (sorted-deep v)]))
                   x)
    (sequential? x) (mapv sorted-deep x)
    :else x))

(defn- normalized-batch-body
  "A `/batch` body with each operation's path split into its path and its
  normalized query, so labels on an operation are outside the fingerprint
  too."
  [ops]
  (if (sequential? ops)
    (mapv (fn [op]
            (if (and (map? op) (string? (:path op)))
              (let [[path qs] (str/split (:path op) #"\?" 2)]
                (assoc op :path path :query (normalized-query qs)))
              op))
          ops)
    ops))

(defn- key-name [k]
  (if (keyword? k) (subs (str k) 1) (str k)))

(defn fingerprint
  "Hex SHA-256 over what makes two sends one request: the method, the path,
  the query without its labels, and the body. `document-version` is kept,
  so a resend that claims another version is another request."
  [request batch?]
  (let [body (cond-> (:body-params request) batch? normalized-batch-body)
        text (json/write-str [(name (:request-method request))
                              (:uri request)
                              (normalized-query (:query-string request))
                              (sorted-deep body)]
                             :key-fn key-name)
        digest (.digest (MessageDigest/getInstance "SHA-256")
                        (.getBytes ^String text StandardCharsets/UTF_8))]
    (apply str (map #(format "%02x" %) digest))))

(defn- refusal [status body]
  {:status status :body body})

(defn- replay
  "The stored answer, as it was first sent. The body is decoded, so it is
  answered in the format this request asks for."
  [muuntaja {:keys [status headers body]}]
  {:status status
   :headers (assoc (or headers {}) replayed-header "true")
   :body (some->> body (m/decode muuntaja "application/json"))})

(defn- reused [{:keys [method path]}]
  (refusal 422 {:error "idempotency-key-reused"
                :idempotency-key-reused true
                :message (str "This Idempotency-Key was used for another request ("
                              method " " path "). Send a new key for a new request.")}))

(defn- answer-from
  "The answer to a key found stored, given this request's fingerprint."
  [muuntaja row fp]
  (if (= fp (:fingerprint row))
    (replay muuntaja row)
    (reused row)))

(defn- body-text
  "The response body as the JSON text the client receives."
  [muuntaja body]
  (cond
    (nil? body) nil
    (string? body) body
    (instance? InputStream body) (slurp body)
    :else (let [encoded (m/encode muuntaja "application/json" body)]
            (if (bytes? encoded)
              (String. ^bytes encoded StandardCharsets/UTF_8)
              (slurp encoded)))))

(defn- stored-response
  "What `idem/store!` keeps of `response`, and the response to answer now.
  A body read from a stream is answered from its text."
  [muuntaja request fp response]
  (let [text (body-text muuntaja (:body response))
        headers (not-empty (select-keys (:headers response) stored-headers))]
    [{:fingerprint fp
      :method (str/upper-case (name (:request-method request)))
      :path (:uri request)
      :status (:status response)
      :headers headers
      :body text}
     (cond-> response
       (instance? InputStream (:body response)) (assoc :body text))]))

(defn- store-if-success!
  [tx muuntaja request user key fp response]
  (if (<= 200 (:status response) 299)
    (let [[row answer] (stored-response muuntaja request fp response)]
      (idem/store! tx user key row)
      answer)
    response))

(defn- keyed-write
  "Run the handler for a keyed write in one transaction with its key row.
  The key is looked up again under the write lock, so of two sends of one
  key at once only one writes and the other is answered from its row."
  [handler request muuntaja user key fp batch-route?]
  (if batch-route?
    (binding [batch/*pending-key*
              {:check (fn [tx] (when-let [row (idem/lookup tx user key)] (answer-from muuntaja row fp)))
               :store! (fn [tx response] (store-if-success! tx muuntaja request user key fp response))}]
      (handler request))
    (batch/with-atomic-tx
      (:db request)
      (fn [tx]
        (or (when-let [row (idem/lookup tx user key)] (answer-from muuntaja row fp))
            (store-if-success! tx muuntaja request user key fp
                               (handler (assoc request :db tx))))))))

(defn- refuses-key [route-data]
  (false? (:plaid/idempotency route-data)))

(def wrap-idempotency-key
  "See the namespace docstring. Global route middleware, placed after
  authentication and body decoding and before every route's own gates."
  {:name ::idempotency-key
   :compile
   (fn [route-data _]
     (let [muuntaja (:muuntaja route-data)
           refuse? (refuses-key route-data)
           batch-route? (= :batch (:plaid/idempotency route-data))]
       (fn [handler]
         (fn [request]
           (let [key (get-in request [:headers header-name])]
             (cond
               (or (nil? key)
                   (#{:get :head :options} (:request-method request))
                   (get request log-buffer/sub-request-key))
               (handler request)

               (or refuse? (nil? (:user/id request)))
               (refusal 400 {:error "This route does not take an Idempotency-Key."})

               (not (re-matches key-pattern key))
               (refusal 400 {:error "Idempotency-Key must be 8 to 128 letters, digits or . _ : -"})

               :else
               ;; A batch the batch handler would refuse is refused before
               ;; the lookup, so an answer kept before that refusal existed
               ;; (a minted secret in it) is never replayed.
               (or (when batch-route?
                     (batch/operation-refusal (:reitit.core/router request)
                                              (get-in request [:parameters :body])))
                   (let [user (:user/id request)
                         fp (fingerprint request batch-route?)]
                     ;; A fast read with no write lock answers most retries.
                     (if-let [row (idem/lookup (:db request) user key)]
                       (answer-from muuntaja row fp)
                       (keyed-write handler request muuntaja user key fp batch-route?))))))))))})
