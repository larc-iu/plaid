(ns glam.neo4j.user
  (:require [glam.neo4j.core :refer [defquery defquery-1]]))

;; create
(defquery-1 create
  "WITH randomUUID() AS uuid
  CREATE (u:User {name: $name, email: $email, password_hash: $password_hash, admin: false, uuid: uuid})
  RETURN uuid")

;; multiple lookup
(defquery get-all "MATCH (u:User) RETURN u AS user")
(defquery-1 get-count "MATCH (u:User) RETURN count(u) AS count")

;; lookup
(defquery-1 get-id-by-name "MATCH (u:User) WHERE u.name = $name RETURN u.uuid AS uuid")
(defquery-1 get-id-by-email "MATCH (u:User) WHERE u.email = $email RETURN u.uuid AS uuid")

;; gets
(defquery-1 get-props "MATCH (u:User) WHERE u.uuid = $uuid RETURN u AS props")

;; sets
(defquery set-name "MATCH (u:User) WHERE u.uuid = $uuid SET u.name = $name")
(defquery set-email "MATCH (u:User) WHERE u.uuid = $uuid SET u.email = $email")
(defquery set-password-hash "MATCH (u:User) WHERE u.uuid = $uuid SET u.password_hash = $password_hash")
(defquery set-admin "MATCH (u:User) WHERE u.uuid = $uuid SET u.admin = $admin")

;; delete
(defquery delete "MATCH (u:User) WHERE u.uuid = $uuid DELETE u")

;; project -> user
;; Projects depend on Users because when Projects are deleted
;; all nodes pointing at the Project are recursively deleted
(defquery set-reader
  "MATCH (u:User), (p:Project)
  WHERE u.uuid = $user_uuid AND p.uuid = $project_uuid
  CREATE (p)-[r:READ_ACCESS]->(u)")

(defquery set-writer
  "MATCH (u:User), (p:Project)
  WHERE u.uuid = $user_uuid AND p.uuid = $project_uuid
  CREATE (p)-[r:WRITE_ACCESS]->(u)")

(defquery revoke-reader
  "MATCH (p:Project)-[r:READ_ACCESS]->(u:User)
  WHERE u.uuid = $user_uuid AND p.uuid = $project_uuid
  DELETE r")

(defquery revoke-writer
  "MATCH (p:Project)-[r:WRITE_ACCESS]->(u:User)
  WHERE u.uuid = $user_uuid AND p.uuid = $project_uuid
  DELETE r")

(defquery readable-projects
  "MATCH (p:Project)-[r:WRITE_ACCESS|READ_ACCESS]->(u:User {uuid: $uuid})
  RETURN p.uuid")

(defquery writeable-projects
  "MATCH (p:Project)-[r:WRITE_ACCESS]->(u:User {uuid: $uuid})
  RETURN p.uuid")