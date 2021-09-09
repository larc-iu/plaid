(ns glam.xtdb.scratch
  (:require [xtdb.api :as xt]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.user :as user]
            [glam.xtdb.access :as access]
            [glam.xtdb.project :as prj]
            [glam.xtdb.text-layer :as txtl]
            [glam.xtdb.token-layer :as tokl]
            [user :refer [init-db]]
            [taoensso.timbre :as log])
  )

(comment

  (def node
    (let [node (xt/start-node {})]
      (gxe/install-tx-fns! node)
      (init-db node)
      node))

  (prj/get-accessible-ids node :user1)

  (user/get node :admin)

  (prj/get node :project1)
  (txtl/get node :txtl1)

  (gxe/find-entities node [[:token-layer/id '_]])

  (access/get-accessible-ids node :user1 :span-layer/id)

  (access/ident-readable? node :user1 [:project/id :project1])
  (access/ident-readable? node :user1 [:text-layer/id :txtl1])

  (access/ident-writeable? node :user1 [:project/id :project2])
  (access/ident-writeable? node :user1 [:text-layer/id :txtl1])

  (tokl/delete** node :tokl1)

  (prj/delete node :project1)

  (xt/q (xt/db node) '{:find [?id] :where [[?id :xt/id '_]]})

  (tokl/get node :tok1)
  (prj/get node :project1)


  (xt/pull
    (xt/db node)
    [:project/name
     {:project/writers
      [:user/id :user/email]}]
    :project1)

  )
