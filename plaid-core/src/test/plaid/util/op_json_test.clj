;; A refused text edit op is printed in one JSON form by core (REV8-CORE-3).
;; The clients name a refused op in their own plain JSON.
(ns plaid.util.op-json-test
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is]]
            [muuntaja.core :as m]
            [plaid.util.op-json :as op-json]))

(def ^:private cases
  (json/read-str (slurp (io/file "src/test/plaid/util/op_json_cases.json"))))

(deftest a-refused-op-prints-in-the-one-form
  (let [mj (m/create)]
    (doseq [[raw want] cases]
      (is (= want (op-json/op-json (m/decode mj "application/json" raw))) raw))))
