(ns glam.models.user-common)

(defn valid-password [password] (>= (count password) 8))

(def email-regex #"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$")
(defn ^boolean valid-email [email]
  (boolean (re-matches email-regex email)))

(defn ^boolean valid-name [name]
  (and (string? name)
       (>= (count name) 2)))