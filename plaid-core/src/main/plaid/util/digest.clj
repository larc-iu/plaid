(ns plaid.util.digest
  "The digest of a text body the core issues with every text it returns.
  A client echoes it as `base` on an edit (`PATCH /texts/:id` with `edits`),
  and the edit applies only to the body it was made on. Computed on read,
  never stored, so every writer of a body stays right by construction."
  (:import (java.nio.charset StandardCharsets)
           (java.security MessageDigest)))

(defn text-digest
  "SHA-256 of the UTF-8 bytes of `body`, as lowercase hex."
  ^String [^String body]
  (let [bs (.digest (MessageDigest/getInstance "SHA-256") (.getBytes (or body "") StandardCharsets/UTF_8))
        sb (StringBuilder. (* 2 (alength bs)))]
    (doseq [b bs]
      (.append sb (format "%02x" (bit-and b 0xff))))
    (str sb)))
