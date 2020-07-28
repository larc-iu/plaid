(ns glam.crux.user
  (:require [crux.api :as crux]
            [glam.server.crux :refer [crux-node]]
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

(defn get-all [node]
  (gc/find-entities node {:user/id '_}))

(defn find-by-name [node name]
  (gc/find-entity node {:user/name name}))

(defn find-by-email [node email]
  (gc/find-entity node {:user/email email}))

#_(gc/deftx set-name crux-node
  (fn [ctx eid name]
    (when-let [user (crux.api/entity (crux.api/db ctx) eid)]
      [[:crux.tx/put (assoc user :user/name name)]])))

#_(gc/deftx set-name crux-node
  (fn [ctx eid name]
    (when-let [user (crux.api/entity (crux.api/db ctx) eid)]
      [[:crux.tx/put (assoc user :user/name name)]])))

;;;; sets
;;(defquery set-name "MATCH (u:User) WHERE u.uuid = $uuid SET u.name = $name")
;;(defquery set-email "MATCH (u:User) WHERE u.uuid = $uuid SET u.email = $email")
;;(defquery set-password-hash "MATCH (u:User) WHERE u.uuid = $uuid SET u.password_hash = $password_hash")
;;(defquery set-admin "MATCH (u:User) WHERE u.uuid = $uuid SET u.admin = $admin")
;;
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