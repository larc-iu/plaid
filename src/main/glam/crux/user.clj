(ns glam.crux.user
  (:require [crux.api :as crux]
            [glam.crux.common :as gc]))

(defn create [node {:keys [name email password-hash]}]
  (let [;; make the first user to sign up an admin
        first-signup? (= 0 (count (gc/find-entities node {:user/id '_})))
        {:user/keys [id] :as record}
        (merge (gc/new-record "user")
               {:user/name          name
                :user/email         email
                :user/password-hash password-hash
                :user/admin?        first-signup?
                :user/reader        #{}
                :user/writer        #{}})]
    (gc/put node [record])
    id))

(defn get-all [node] (gc/find-entities node {:user/id '_}))
(defn get-by-name [node name] (gc/find-entity node {:user/name name}))
(defn get-by-email [node email] (gc/find-entity node {:user/email email}))

(gc/defsetter set-name :user/name)
(gc/defsetter set-email :user/email)
(gc/defsetter set-password-hash :user/password-hash)
(gc/defsetter set-admin? :user/admin?)
(gc/deftx set-reader [node user-id project-id]
  (let [db (crux.api/db node)
        user (crux.api/entity db user-id)]
    [[:crux.tx/put (update user :user/reader conj project-id)]]))
(gc/deftx set-writer [node user-id project-id]
  (let [db (crux.api/db node)
        user (crux.api/entity db user-id)]
    [[:crux.tx/put (update user :user/writer conj project-id)]]))
(gc/deftx revoke-reader [node user-id project-id]
  (let [db (crux.api/db node)
        user (crux.api/entity db user-id)]
    [[:crux.tx/put (update user :user/reader disj project-id)]]))
(gc/deftx revoke-writer [node user-id project-id]
  (let [db (crux.api/db node)
        user (crux.api/entity db user-id)]
    [[:crux.tx/put (update user :user/writer disj project-id)]]))

(defn delete [node eid] (gc/delete node eid))

(comment
  (def node glam.server.crux/crux-node)
  (set-admin? node (gc/find-entity-id node {:user/email "a@b.com"}) true)

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