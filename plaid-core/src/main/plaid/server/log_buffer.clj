(ns plaid.server.log-buffer
  "A bounded, in-memory view of what this process has logged, so the admin
  Logs screen has something to show whether or not `[logging] file` is set.
  The manual tells operators to leave it unset and let journald keep stdout,
  which is the configuration in which a file tail has nothing to read.

  **Two buffers, not one.** Requests and everything else are kept apart
  because they arrive at wildly different rates: one bulk import writes
  thousands of access lines in a few seconds, and a single shared buffer
  would evict the stack trace the operator came here to find. A request
  flood can only evict other requests.

  Entries are structured at the point of logging rather than parsed back out
  of a formatted line, so a request carries fields the text line has no room
  for and no regex has to be kept in step with the format.

  Both buffers live for as long as the process, and hold info and above.
  Anything older than the last restart, or logged at debug, is in the log
  file or the journal, not here."
  (:require [clojure.string :as str]
            [taoensso.timbre :as log])
  (:import [java.io PrintWriter StringWriter]
           [java.util Date]))

(def ^:const request-capacity
  "Access lines kept. At ~200 bytes an entry this is a few megabytes, and it
  covers a busy import with room left over."
  5000)

(def ^:const event-capacity
  "Non-request log events kept. Smaller because they are rare and because a
  stack trace is not."
  1000)

(def ^:const max-trace-chars
  "A trace longer than this is cut. Deep frames are the framework's, and the
  operator needs the top of the stack."
  4000)

(def context-key
  "The key `wrap-access-log` puts its structured record under in Timbre's
  `*context*`. Its presence is what tells `append!` that an event is an
  access line and belongs in the request buffer."
  ::request)

(def sub-request-key
  "Request key marking a batch sub-operation, set by the batch handler when it
  builds each sub-request.

  One atomic batch is one request as far as an operator is concerned. Its
  sub-ops have no address and no arrival of their own, and a batch may carry a
  thousand of them, so five batches would evict this buffer's whole 5000
  entries and every other request with them. The access log leaves them at
  debug, where the appender does not reach.

  Here rather than in either middleware namespace for the same reason as
  `identity-key`: both the batch handler and the access log can require this
  namespace, and neither requires the other."
  ::sub-request)

(def identity-key
  "Request key holding a volatile that the authentication middleware fills in
  with `{:user ... :token ...}` once it has validated a token.

  The access log sits OUTSIDE authentication, so that a request refused with
  a 401 still gets a line, which means it cannot read the account off the
  request map the way an inner middleware can. It leaves this box on the
  request instead and reads it once the response is in hand.

  It lives here rather than in either middleware namespace because both of
  them can require this one, and neither requires the other."
  ::identity)

(defonce ^:private requests* (atom clojure.lang.PersistentQueue/EMPTY))
(defonce ^:private events* (atom clojure.lang.PersistentQueue/EMPTY))

(defn- push
  "Conj onto a queue, dropping from the front once it is over `cap`."
  [q cap entry]
  (let [q' (conj q entry)]
    (if (> (count q') cap) (pop q') q')))

(defn- trace-string [^Throwable t]
  (let [sw (StringWriter.)]
    (.printStackTrace t (PrintWriter. sw))
    (let [s (str sw)]
      (if (> (count s) max-trace-chars)
        (str (subs s 0 max-trace-chars) "\n… trace cut")
        s))))

(defn- event-entry [{:keys [level instant ?ns-str msg_ ?err]}]
  (cond-> {:ts (if (instance? Date instant) (.getTime ^Date instant) (System/currentTimeMillis))
           :level (or level :info)
           :ns (or ?ns-str "?")
           :message (str (force msg_))}
    ?err (assoc :trace (trace-string ?err))))

(defn append!
  "Timbre appender. Everything logged at or above the configured level lands
  in one of the two buffers: an access line (recognised by `context-key`) in
  the request one, anything else in the event one.

  Never throws. An appender that blows up takes the log call with it, and a
  panel that cannot be drawn is not worth losing a log line over."
  [{:keys [context instant] :as data}]
  (try
    (if-let [request (get context context-key)]
      (swap! requests* push request-capacity
             (assoc request :ts (if (instance? Date instant)
                                  (.getTime ^Date instant)
                                  (System/currentTimeMillis))))
      (swap! events* push event-capacity (event-entry data)))
    (catch Throwable _ nil))
  nil)

(def appender
  "The Timbre appender that fills both buffers. `configure-logging!` spells it
  out alongside the console and file ones.

  Info and above whatever the console is set to. Debug is a firehose meant
  for a terminal: two dumps per request would fill the event buffer in a few
  hundred requests and evict every warning in it, which is the one thing
  these buffers exist to prevent."
  {:enabled? true :min-level :info :fn append!})

(defn install!
  "Put the appender on the live Timbre config. `configure-logging!` does this
  as part of setting logging up from config, which is the path a running
  server takes. This is for the paths that never read config: a REPL, and the
  tests that drive the REST handler directly."
  []
  (log/merge-config! {:appenders {:buffer appender}}))

(defn clear!
  "Forget everything buffered. For test fixtures, which otherwise read each
  other's requests."
  []
  (reset! requests* clojure.lang.PersistentQueue/EMPTY)
  (reset! events* clojure.lang.PersistentQueue/EMPTY))

;; ============================================================
;; Reading
;; ============================================================

(def ^:private level-rank
  {:trace 0 :debug 1 :info 2 :warn 3 :error 4 :fatal 5 :report 6})

(defn- failed? [{:keys [status error]}]
  (or (some? error) (and (integer? status) (>= status 400))))

(defn- status-match?
  "`status` is one of `2xx`…`5xx`, an exact code, or `failures` for anything
  a caller would have to act on (4xx, 5xx, or a handler that threw)."
  [status entry]
  (let [s (:status entry)]
    (cond
      (str/blank? status) true
      (= "failures" status) (failed? entry)
      (re-matches #"[1-5]xx" status) (and (integer? s)
                                          (= (subs status 0 1) (subs (str s) 0 1)))
      (re-matches #"\d{3}" status) (= s (parse-long status))
      :else true)))

(defn- request-haystack [{:keys [method path query status user ip token error]}]
  (str/lower-case (str method " " path " " query " " status " " user " " ip " " token " " error)))

(defn- event-haystack [{:keys [level ns message trace]}]
  (str/lower-case (str (name (or level :info)) " " ns " " message " " trace)))

(defn- matches?
  [haystack q]
  (or (str/blank? q) (str/includes? haystack (str/lower-case q))))

(defn- percentile [sorted-ms p]
  (when (seq sorted-ms)
    (nth sorted-ms (min (dec (count sorted-ms))
                        (int (Math/floor (* p (count sorted-ms))))))))

(defn- request-stats
  "Summary of the entries that passed the filters, newest first. Rates and
  percentiles describe what is on screen rather than the whole buffer, so
  narrowing to one person answers questions about that person."
  [entries]
  (let [n (count entries)
        durations (sort (keep :ms entries))
        newest (:ts (first entries))
        oldest (:ts (last entries))
        span (when (and newest oldest) (- newest oldest))]
    {:count n
     :failures (count (filter failed? entries))
     :server-errors (count (filter (fn [{:keys [status error]}]
                                     (or (some? error)
                                         (and (integer? status) (>= status 500))))
                                   entries))
     :p50 (percentile durations 0.5)
     :p95 (percentile durations 0.95)
     :max (last durations)
     :per-minute (when (and span (pos? span))
                   (-> (/ (* n 60000.0) span) (* 10) Math/round (/ 10.0)))
     :oldest oldest
     :newest newest}))

(defn requests
  "Buffered access lines, newest first, narrowed by `q` (a substring of any
  field), `user`, `method` and `status`, then capped at `limit`."
  [{:keys [q user method status limit]}]
  (let [held (count @requests*)
        matched (into []
                      (filter (fn [e]
                                (and (matches? (request-haystack e) q)
                                     (or (str/blank? user) (= user (:user e)))
                                     (or (str/blank? method)
                                         (= (str/upper-case method) (:method e)))
                                     (status-match? status e))))
                      (reverse @requests*))]
    {:entries (vec (take (or limit 200) matched))
     :matched (count matched)
     :held held
     :capacity request-capacity
     :stats (request-stats matched)}))

(defn events
  "Buffered log events, newest first, narrowed by `q` and a minimum `level`.
  `by-level` counts what `q` matched before the level narrowed it, so the
  level filter can show what it would give."
  [{:keys [q level limit]}]
  (let [held (count @events*)
        searched (into [] (filter #(matches? (event-haystack %) q)) (reverse @events*))
        floor (get level-rank (some-> level keyword) 0)
        matched (filterv #(>= (get level-rank (:level %) 2) floor) searched)]
    {:entries (vec (take (or limit 200) matched))
     :matched (count matched)
     :held held
     :capacity event-capacity
     :by-level (frequencies (map :level searched))}))
