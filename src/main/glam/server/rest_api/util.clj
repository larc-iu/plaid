(ns glam.server.rest-api.util
  (:require [clojure.walk :refer [postwalk]]
            [clojure.string :as cljstr]))

(defn get-created-id [data]
  (-> data
      (assoc :id (-> data :tempids first second))
      (dissoc :tempids)))

(defn- response-format [request]
  (-> request
      (dissoc :reitit.core/match)
      :muuntaja/response
      :format))

(defn idents->ids
  "Raw pathom outputs have things like `{:span-layer/id 1}` where we just want `1`. This
  looks at everything in a response "
  [response]
  (let [new-body (postwalk
                   (fn [x]
                     (if (and (map? x)
                              (= 1 (count x))
                              (= "id" (-> x ffirst name)))
                       (-> x first second)
                       x))
                   (:body response))]
    (assoc response :body new-body)))

(defn de-namespace
  "If we're responding with JSON, get rid of namespaces in keys"
  [request response]
  (if (not= (response-format request) "application/json")
    response
    (let [new-body (postwalk
                     (fn [x]
                       (cond (= x :server/error?)
                             :error

                             (keyword? x)
                             (keyword (name x))

                             :else
                             x))
                     (:body response))
          new-body2 (postwalk
                      (fn [x]
                        (if (and (keyword? x)
                                 (re-matches #"^.*-layers?$" (name x)))
                          (-> (name x)
                              (cljstr/replace "-layers" "Layers")
                              (cljstr/replace "-layer" "Layer")
                              keyword)
                          x))
                      new-body)]
      (assoc response :body new-body2))))

(defn postprocess-response [request response]
  (->> response
       idents->ids
       (de-namespace request)))

(defn wrap-postprocess
  [handler]
  (fn [req]
    (let [raw-response (handler req)]
      (postprocess-response req raw-response))))

(def postprocess-middleware
  {:name ::postprocess
   :compile (fn [_ _]
              {:wrap wrap-postprocess})})

