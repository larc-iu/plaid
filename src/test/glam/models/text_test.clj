(ns glam.models.text-test
  (:require [clojure.test :refer :all]
            [glam.fixtures :refer [with-xtdb
                                   with-parser
                                   with-users
                                   with-projects
                                   xtdb-node
                                   parser
                                   config
                                   with-layers-and-documents]]))

(use-fixtures :each with-xtdb with-parser with-users with-projects with-layers-and-documents)

(def env {:node xtdb-node
          :config config})

(deftest text-gets
  (testing "Text is retrievable"
    (is (= {[:text/id :txt1] {:text/id       :txt1
                              :text/document {:document/id :doc1}
                              :text/layer    {:text-layer/id :txtl1}
                              :text/body     "This sentence is great, isn't it!"}}
           (parser env [{[:text/id :txt1] [:text/id :text/document :text/layer :text/body]}])))))