(ns plaid.rest-api.v1.schema
  "Malli schemas shared by more than one route file, so a rule about the wire
  shape has one home rather than a copy per endpoint."
  (:require [plaid.sql.user :as user]))

(def atomic-value
  "A span's or relation's primary value: an atomic JSON scalar. The wire
  statement of `plaid.sql.common/validate-atomic-value!`, which enforces the
  same rule inside the operation."
  [:or string? number? boolean? nil?])

(def user-id
  "A user id (an email address) in a path, a query or a JSON body, decoded to
  the spelling core stores (`plaid.sql.user/normalize-id`): trimmed and
  lowercased. Every route that takes a user id or an email uses this, so
  `B@X.COM` and ` b@x.com` name the account `b@x.com` everywhere."
  [:string {:decode/string user/normalize-id
            :decode/json user/normalize-id}])
