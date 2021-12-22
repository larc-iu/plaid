(ns glam.client.util
  (:require [taoensso.timbre :as log]))

(defn uuid-string? [x]
  (and (= (count (filter #(= % \-) x)) 4)
       (= (count x) 36)))

(defn parse-id
  "Parse a path parameter from a fulcro route into an ID"
  [x]
  (log/info x)
  (when x
    (cond (uuid-string? x)
          (uuid x)

          (re-matches #"^\d+$" x)
          (js/parseInt x)

          :else
          (keyword x))))