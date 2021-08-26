(ns glam.models.token-test
  (:require [clojure.test :refer :all]
            [glam.models.token :refer [apply-text-edit]]))


(deftest text-edits
  (let [mktoken (fn [id begin end] {:token/id id :token/begin begin :token/end end})
        token-strs (fn [output] (mapv #(subs (-> output :text :text/body) (:token/begin %) (:token/end %))
                                      (:tokens output)))
        text {:text/id :foo :text/body "word1 word2 word3"}
        tokens [(mktoken :word1 0 5) (mktoken :word2 6 11) (mktoken :word3 12 17)]
        insert (fn [i v] (apply-text-edit {:type :insert :index i :value v} text tokens))
        delete (fn [i v] (apply-text-edit {:type :delete :index i :value v} text tokens))]
    (testing "Inserting outside a token does not expand it and shifts indices properly"
      (let [output (insert 0 "foo")]
        (is (= ["word1" "word2" "word3"] (token-strs output)))
        (is (and (= (-> output :tokens first :token/begin) 3)
                 (= (-> output :tokens first :token/end) 8))))
      (let [output (insert 5 "foo")]
        (is (= ["word1" "word2" "word3"] (token-strs output)))
        (is (and (= (-> output :tokens first :token/begin) 0)
                 (= (-> output :tokens first :token/end) 5)
                 (= (-> output :tokens second :token/begin) 9)
                 (= (-> output :tokens second :token/end) 14)))))

    (testing "Inserting at the end of a text works"
      (let [output (insert 17 "foo")]
        (is (= ["word1" "word2" "word3"] (token-strs output)))
        (is (= "word1 word2 word3foo" (:text/body (:text output))))
        (is (= (count (-> output :text :text/body)) 20))))

    (testing "Deletion: a token wholly included in the deletion range is deleted"
      (let [output (delete 5 6)]
        (is (= ["word1" "word3"] (token-strs output)))
        (is (= (-> output :text :text/body) "word1 word3"))
        (is (= 1 (count (:deleted output))))))

    (testing "Deletion: a token wholly to the left is left unmodified"
      (let [output (delete 5 6)]
        (is (= (-> output :tokens first :token/begin) 0))
        (is (= (-> output :tokens first :token/end) 5))))

    (testing "Deletion: a token wholly to the right has its indices shrunk"
      (let [output (delete 5 6)]
        (is (= (-> output :tokens second :token/begin) (- 12 6)))
        (is (= (-> output :tokens second :token/end) (- 17 6)))))

    (testing "Deletion: a token opened before the deletion range and closed within it is handled appropriately"
      (let [output (delete 5 3)]
        (is (= ["word1" "rd2" "word3"] (token-strs output)))))

    (testing "Deletion: a token opened within the deletion range and closed outside it is handled appropriately"
      (let [output (delete 8 4)]
        (is (= ["word1" "wo" "word3"] (token-strs output)))))

    (testing "Deletion: deleting everything works"
      (let [output (delete 0 17)]
        (is (= 0 (count (:tokens output))))
        (is (= 3 (count (:deleted output))))
        (is (= "" (-> output :text :text/body)))))

    ))