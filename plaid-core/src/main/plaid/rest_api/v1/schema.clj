(ns plaid.rest-api.v1.schema
  "Malli schemas shared by more than one route file, so a rule about the wire
  shape has one home rather than a copy per endpoint.")

(def atomic-value
  "A span's or relation's primary value: an atomic JSON scalar. The wire
  statement of `plaid.sql.common/validate-atomic-value!`, which enforces the
  same rule inside the operation."
  [:or string? number? boolean? nil?])
