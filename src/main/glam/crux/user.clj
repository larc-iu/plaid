(ns glam.crux.user
  (:require [crux.api :as crux]
            [glam.crux.common.easy :as cce]))

(defn create [node {:keys [name email password-hash]}]
  (let [;; make the first user to sign up an admin
        first-signup? (= 0 (count (cce/find-entities node {:user/id '_})))
        {:user/keys [id] :as record}
        (merge (cce/new-record "user")
               {:user/name          name
                :user/email         email
                :user/password-hash password-hash
                :user/admin?        first-signup?
                :user/reader        #{}
                :user/writer        #{}})]
    (cce/put node [record])
    id))

(defn get-all [node] (cce/find-entities node {:user/id '_}))
(defn get-by-name [node name] (cce/find-entity node {:user/name name}))
(defn get-by-email [node email] (cce/find-entity node {:user/email email}))

(defn set-name [node eid name] (cce/update node eid assoc :user/name name))
(defn set-email [node eid email] (cce/update node eid assoc :user/email email))
(defn set-password-hash [node eid password-hash] (cce/update node eid assoc :user/password-hash password-hash))
(defn set-admin? [node eid admin?] (cce/update node eid assoc :user/admin? admin?))

(defn add-reader [node user-id project-id]
  (cce/update node user-id update :user/reader conj project-id))
(defn add-writer [node user-id project-id]
  (cce/update node user-id update :user/writer conj project-id))
(defn remove-reader [node user-id project-id]
  (cce/update node user-id update :user/reader disj project-id))
(defn remove-writer [node user-id project-id]
  (cce/update node user-id update :user/writer disj project-id))

(defn delete [node eid] (cce/delete node eid))

(comment
  (def node glam.server.crux/crux-node)
  (set-admin? node (cce/find-entity-id node {:user/email "a@b.com"}) true)

  (def node
    (crux/start-node
      {:crux.node/topology                 :crux.standalone/topology
       :crux.node/kv-store                 "crux.kv.memdb/kv"
       :crux.standalone/event-log-dir      "data/eventlog-1"
       :crux.kv/db-dir                     "data/db-dir-1"
       :crux.standalone/event-log-kv-store "crux.kv.memdb/kv"}))

  (get-by-email node "a@a.com")
  (get-all node)
  )

;;;; delete
;;(defquery delete "MATCH (u:User) WHERE u.uuid = $uuid DELETE u")
;;
;;;; project -> user
;;;; Projects depend on Users because when Projects are deleted
;;;; all nodes pointing at the Project are recursively deleted
;;(defquery set-reader
;;          "MATCH (u:User), (p:Project)
;;          WHERE u.uuid = $user_uuid AND p.uuid = $project_uuid
;;          CREATE (p)-[r:READ_ACCESS]->(u)")
;;
;;(defquery set-writer
;;          "MATCH (u:User), (p:Project)
;;          WHERE u.uuid = $user_uuid AND p.uuid = $project_uuid
;;          CREATE (p)-[r:WRITE_ACCESS]->(u)")
;;
;;(defquery revoke-reader
;;          "MATCH (p:Project)-[r:READ_ACCESS]->(u:User)
;;          WHERE u.uuid = $user_uuid AND p.uuid = $project_uuid
;;          DELETE r")
;;
;;(defquery revoke-writer
;;          "MATCH (p:Project)-[r:WRITE_ACCESS]->(u:User)
;;          WHERE u.uuid = $user_uuid AND p.uuid = $project_uuid
;;          DELETE r")
;;
;;(defquery readable-projects
;;          "MATCH (p:Project)-[r:WRITE_ACCESS|READ_ACCESS]->(u:User {uuid: $uuid})
;;          RETURN p.uuid")
;;
;;(defquery writeable-projects
;;          "MATCH (p:Project)-[r:WRITE_ACCESS]->(u:User {uuid: $uuid})
;;          RETURN p.uuid")
;;