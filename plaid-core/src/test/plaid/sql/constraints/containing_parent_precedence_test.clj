(ns plaid.sql.constraints.containing-parent-precedence-test
  "Regression for #115: when two parent-layer tokens cover the SAME extent
  (legal on `:any` overlap-mode layers), `containing-parent` must pick
  the one with the lower `:token/precedence` as its tertiary tiebreaker
  rather than falling through to the id-only ordering. After #101 made
  precedence load-bearing, the id-only tiebreaker would return a parent
  that was a function of UUID bytes, not the user-supplied precedence.

  The test inserts two same-extent parent tokens via raw JDBC (so we
  can fix precedence + id directly without going through REST + the
  full enforcement stack), then calls `containing-parent` and asserts
  the lower-precedence row wins."
  (:require [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.fixtures :refer [db with-db with-mount-states with-clean-db]]
            [plaid.sql.common :as psc]
            [plaid.sql.constraints.token :as ct]))

(use-fixtures :once with-db with-mount-states)
(use-fixtures :each with-clean-db)

(defn- now-iso [] (psc/now-iso))

(defn- insert-token-row!
  "Raw INSERT so the test can pin (id, precedence) deterministically.
  Skips the audit log + the full operation/constraint stack — the
  scenario being tested (two same-extent tokens on the same `:any`
  layer) is legal but the REST surface doesn't expose precedence as a
  direct mutation, so a raw insert is the clearest way to set up the
  fixture."
  [tx token-id text-id layer-id doc-id begin end precedence]
  (jdbc/execute! tx
                 ["INSERT INTO tokens (id, text_id, token_layer_id, document_id, begin, end_, precedence)
                   VALUES (?, ?, ?, ?, ?, ?, ?)"
                  token-id text-id layer-id doc-id begin end precedence]))

(deftest containing-parent-prefers-lower-precedence-on-same-extent
  (let [proj-id (psc/new-uuid)
        doc-id (psc/new-uuid)
        txl-id (psc/new-uuid)
        tkl-id (psc/new-uuid)
        text-id (psc/new-uuid)
        ;; Construct ids so that lexical id order is OPPOSITE the
        ;; precedence order — id-only tiebreaker (the buggy path)
        ;; would pick the high-precedence parent.
        high-prec-id "aaaaaaaa-0000-0000-0000-000000000001"
        low-prec-id  "bbbbbbbb-0000-0000-0000-000000000002"
        ts (now-iso)]
    (jdbc/with-transaction [tx db]
      (jdbc/execute! tx ["INSERT INTO projects (id, name) VALUES (?, ?)"
                         proj-id "ContainingParentPrecTest"])
      (jdbc/execute! tx ["INSERT INTO documents (id, project_id, name, created_at, modified_at) VALUES (?, ?, ?, ?, ?)"
                         doc-id proj-id "Doc1" ts ts])
      (jdbc/execute! tx ["INSERT INTO text_layers (id, project_id, name, order_idx) VALUES (?, ?, ?, ?)"
                         txl-id proj-id "TL" 0])
      (jdbc/execute! tx ["INSERT INTO token_layers (id, project_id, text_layer_id, name, overlap_mode, order_idx) VALUES (?, ?, ?, ?, ?, ?)"
                         tkl-id proj-id txl-id "TKL" "any" 0])
      (jdbc/execute! tx ["INSERT INTO texts (id, text_layer_id, document_id, body) VALUES (?, ?, ?, ?)"
                         text-id txl-id doc-id "hello world"])
      ;; Two parent tokens covering [0,5) on the SAME `:any` layer.
      ;; High-precedence (10) gets the lexically-smaller id; low (1) the larger.
      (insert-token-row! tx high-prec-id text-id tkl-id doc-id 0 5 10)
      (insert-token-row! tx low-prec-id  text-id tkl-id doc-id 0 5 1))
    ;; Child extent [0,5) — both parents contain it. With precedence
    ;; honored, the low-precedence parent (id `bbbb…`) must win.
    (let [parent (ct/containing-parent db tkl-id doc-id 0 5)]
      (is (some? parent))
      ;; SQLite TEXT columns sometimes come back as UUID objects via the
      ;; driver coercion; compare as string so the test is robust either way.
      (is (= low-prec-id (str (:token/id parent)))
          (str "expected containing-parent to prefer the lower-precedence "
               "(1) parent " low-prec-id ", got "
               (:token/id parent) " precedence=" (:token/precedence parent)))
      (is (= 1 (:token/precedence parent))))))
