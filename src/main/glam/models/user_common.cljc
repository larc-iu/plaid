(ns glam.models.user-common
  (:require [com.fulcrologic.fulcro.algorithms.form-state :as fs]))

(defn valid-password [password] (>= (count password) 8))

(def email-regex #"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$")
(defn ^boolean valid-email [email]
  (boolean (re-matches email-regex email)))

(defn ^boolean valid-name [name]
  (and (string? name)
       (<= 2 (count name) 40)))

(def valid-admin? boolean?)

(defn valid-reader [reader]
  (and (set? reader)
       (every? uuid? reader)))

(def valid-writer valid-reader)

(defn- field-valid [field v]
  (case field
    :user/name (valid-name v)
    :user/admin? (valid-admin? v)
    :user/email (valid-email v)
    :user/reader (valid-reader v)
    :user/writer (valid-writer v)
    ;; remember that password is a special case: "password-hash" is what is stored,
    ;; but we need to validate passwords themselves
    :user/password (valid-password v)))

(defn user-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(defn record-valid? [record]
  (every? (fn [[k v]] (field-valid k v)) record))

(def validator (fs/make-validator user-valid))