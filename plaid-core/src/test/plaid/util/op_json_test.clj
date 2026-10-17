;; A refused text edit op is printed in one JSON form, byte for byte, by core
;; and both clients (REV8-CORE-3). The cases are shared word for word with
;; plaid-client-js's textEdits.test.js and plaid-client-py's
;; test_text_edits.py, each parsing the raw op with its own JSON reader.
(ns plaid.util.op-json-test
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is]]
            [muuntaja.core :as m]
            [plaid.util.op-json :as op-json]))

(def ^:private cases
  (json/read-str (slurp (io/file "src/test/plaid/util/op_json_cases.json"))))

(deftest a-refused-op-prints-in-the-one-form-the-clients-print
  (let [mj (m/create)]
    (doseq [[raw want] cases]
      (is (= want (op-json/op-json (m/decode mj "application/json" raw))) raw))))
