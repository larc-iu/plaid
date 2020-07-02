(ns glam.neo4j.scratch
  (:require [neo4j-clj.core :as db]
            [glam.neo4j.core :as core]
            [glam.neo4j.user :as user]
            [glam.neo4j.project :as prj]
            [glam.neo4j.document :as doc]
            [glam.neo4j.layers.text-layer :as text]
            [glam.neo4j.layers.token-layer :as token]
            [glam.neo4j.layers.span-layer :as span]
            [glam.neo4j.layers.relation-layer :as relation]

            ))

(comment

  (do
    (def conn (db/connect (java.net.URI. "glam.neo4j://localhost:7687") "glam.neo4j" "password"))
    (def s (db/get-session conn))
    (db/execute s "MATCH (n) DETACH DELETE (n)")

    (db/execute s "CREATE (t:Text {name: \"foo\"})")
    (db/execute s "MATCH (t:Text) CREATE (a:A {name: \"a1\"})-[r:X]->(t)")
    (db/execute s "MATCH (t:Text) CREATE (a:A {name: \"a2\"})-[r:X]->(t)")
    (db/execute s "MATCH (a:A {name: \"a1\"}) CREATE (b:B {name: \"b1\"})-[r:Y]->(a)")
    (db/execute s "MATCH (a:A {name: \"a1\"}) CREATE (b:B {name: \"b2\"})-[r:Y]->(a)")
    (db/execute s "MATCH (a:A {name: \"a1\"}) CREATE (b:B {name: \"b3\"})-[r:Y]->(a)")
    (db/execute s "MATCH (a:A {name: \"a2\"}) CREATE (b:B {name: \"b4\"})-[r:Y]->(a)")

    #_(db/execute s "
    MATCH (a:A {name: \"a1\"})
    OPTIONAL MATCH (x)-[:X|Y*]->(a)
    DETACH DELETE x,a")
    )

  (do
    (def conn (db/create-in-memory-connection))
    (def conn (db/connect (java.net.URI. "neo4j://localhost:7687") "neo4j" "password"))

    (def s (db/get-session conn))

    (db/execute s "MATCH (n) DETACH DELETE (n)")

    (def prj-id (prj/create s {:name "test"}))
    prj-id

    (def doc1-id (prj/add-document s {:project_uuid prj-id :name "doc1"}))
    (def doc2-id (prj/add-document s {:project_uuid prj-id :name "doc2"}))

    (def document-id (prj/add-document s {:project_uuid prj-id :name "doc3"}))
    document-id

    (db/execute s "MATCH (n) RETURN n,labels(n) ")

    (prj/add-text-layer s {:name "layer1" :project_uuid prj-id})
    (prj/add-text-layer s {:name "layer2" :project_uuid prj-id})
    (prj/add-text-layer s {:name "layer3" :project_uuid prj-id})
    (def text-layer-id (prj/add-text-layer s {:name "layer4" :project_uuid prj-id}))

    (text/add-token-layer s {:text_layer_uuid text-layer-id :name "token-layer1"})
    (text/add-token-layer s {:text_layer_uuid text-layer-id :name "token-layer2"})
    (text/add-token-layer s {:text_layer_uuid text-layer-id :name "token-layer3"})
    (def token-layer-id (text/add-token-layer s {:name "tokens4" :text_layer_uuid text-layer-id}))

    (token/add-span-layer s {:name "span1" :token_layer_uuid token-layer-id})


    )

    (println token/add-span-layer)

  )



