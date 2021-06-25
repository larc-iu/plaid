(ns glam.client.util)

(defn uuid-string? [x]
  (and (= (count (filter #(= % \-) x)) 4)
       (= (count x) 36)))

(defn parse-id
  "Parse a path parameter from a fulcro route into an ID"
  [x]
  (when x
    (if (uuid-string? x)
      (uuid x)
      (keyword x))))