(ns glam.crux.user
  (:require [crux.api :as crux]
            [glam.crux.common :as gc]))

(defn create [node {:keys [name email password-hash]}]
  (let [{:person/keys [id] :as record}
        (merge (gc/new-record "user")
               {:user/name          name
                :user/email         email
                :user/password-hash password-hash
                :user/admin?        false})]
    (gc/put node [record])
    id))

(defn get-all [node] (gc/find-entities node {:user/id '_}))
(defn get-by-name [node name] (gc/find-entity node {:user/name name}))
(defn get-by-email [node email] (gc/find-entity node {:user/email email}))
(defn set-name [node eid name] (gc/set node eid :user/name name))
(defn set-email [node eid email] (gc/set node eid :user/email email))
(defn set-password-hash [node eid password-hash] (gc/set node eid :user/password-hash password-hash))
(defn set-admin? [node eid admin?] (gc/set node eid :user/admin? admin?))

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