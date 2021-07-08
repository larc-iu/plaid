(ns glam.crux.scratch
  (:require [crux.api :as crux]
            [glam.crux.easy :as gce]
            [glam.crux.user :as user]
            [glam.crux.access :as access]
            [glam.crux.project :as prj]
            [glam.crux.text-layer :as txtl]
            [glam.crux.token-layer :as tokl]
            [user :refer [init-db]]
            [taoensso.timbre :as log])
  )

(comment

  (def node
    (let [node (crux/start-node {})]
      (gce/install-tx-fns! node)
      (init-db node)
      node))

  (prj/get-accessible-ids node :user1)

  (user/get node :admin)

  (prj/get node :project1)
  (txtl/get node :txtl1)

  (gce/find-entities node [[:token-layer/id '_]])

  (access/get-accessible-ids node :user1 :span-layer/id)

  (access/ident-readable? node :user1 [:project/id :project1])
  (access/ident-readable? node :user1 [:text-layer/id :txtl1])

  (access/ident-writeable? node :user1 [:project/id :project2])
  (access/ident-writeable? node :user1 [:text-layer/id :txtl1])

  (tokl/delete** node :tokl1)

  (prj/delete node :project1)

  (crux/q (crux/db node) '{:find [?id] :where [[?id :crux.db/id '_]]})

  (tokl/get node :tok1)
  (prj/get node :project1)


  (crux/pull
    (crux/db node)
    [:project/name
     {:project/writers
      [:user/id :user/email]}]
    :project1)

  )
