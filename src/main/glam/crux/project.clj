(ns glam.crux.project
  (:require [crux.api :as crux]
            [glam.crux.easy :as gce]))

(defn create [node {:keys [name]}]
  (let [{:project/keys [id] :as record}
        (merge (gce/new-record "project")
               {:project/name name})]
    (gce/put node [record])
    id))

(defn get-all [node] (gce/find-entities node {:project/id '_}))
(defn get-by-name [node name] (gce/find-entity node {:project/name name}))

(gce/defsetter set-name :project/name)

(defn delete [node eid] (gce/delete node eid))

(comment
  (def node glam.server.crux/crux-node)
  (create node {:name "Project 1"})
  (create node {:name "Project 2"})
  (get-all node)
  )

;;;; Cascading delete: don't just delete the project, delete EVERYTHING dependent on it (!)
;;(defquery delete
;;          "MATCH (p:Project {uuid: $uuid})
;;          OPTIONAL MATCH (p)<-[*]-(n)
;;          DETACH DELETE p,n")
;;
;;;; project -> document
;;(defquery-1 add-document
;;            "WITH randomUUID() as uuid
;;            MATCH (p:Project {uuid: $project_uuid})
;;            CREATE (p)-[r:HAS_DOCUMENT]->(d:Document {name: $name, uuid: uuid})
;;            RETURN uuid")
;;
;;(defquery get-document-ids
;;          "MATCH(p:Project {uuid: $uuid})-[:HAS_DOCUMENT]->(d:Document)
;;          RETURN d.uuid")
;;
;;;; project -> layer
;;(defquery-1 add-text-layer
;;            "WITH randomUUID() as uuid
;;            MATCH (p:Project {uuid: $project_uuid})
;;            OPTIONAL MATCH (lastTextLayer:Layer:TextLayer)-[:TEXT_LAYER_OF]->(p)
;;            WHERE NOT (lastTextLayer)-[:NEXT_TEXT_LAYER]->()
;;            CREATE (textLayer:Layer:TextLayer {name: $name, uuid: uuid})-[r:TEXT_LAYER_OF]->(p)
;;            FOREACH (dummy in CASE WHEN lastTextLayer IS NOT NULL THEN [1] ELSE [] END
;;            | CREATE (lastTextLayer)-[:NEXT_TEXT_LAYER]->(textLayer))
;;            RETURN uuid")
;;
;;(defquery get-text-layer-ids
;;          "MATCH (p:Project {uuid: $uuid})<-[:TEXT_LAYER_OF]-(textLayer:TextLayer)
;;          RETURN textLayer.uuid")


