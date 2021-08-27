(ns glam.algos.text
  (:require [taoensso.timbre :as log]
            #?(:cljs ["fast-diff" :as fd])))



(defn delete-op [index value]
  {:type  :delete
   :index index
   :value value})

(defn insert-op [index value]
  {:type  :insert
   :index index
   :value value})

#?(:cljs
   (defn diff
     ([old new cursor]
      (let [results (array-seq (fd old new cursor))]
        (loop [head (first results)
               tail (rest results)
               ops []
               i 0]
          (let [code (if-not (nil? head) (aget head 0))
                value (if-not (nil? head) (aget head 1))]
            (cond
              (nil? head)
              ops

              ;; equality
              (= 0 code)
              (recur (first tail)
                     (rest tail)
                     ops
                     (+ i (count value)))

              ;; insertion
              (= 1 code)
              (recur (first tail)
                     (rest tail)
                     (conj ops (insert-op i value))
                     (+ i (count value)))

              ;; deletion
              (= -1 code)
              (recur (first tail)
                     (rest tail)
                     (conj ops (delete-op i (count value)))
                     i))))))
     ([old new]
      (diff old new nil))))

(defn- insert-str [s i v]
  (str (subs s 0 i) v (subs s i)))

(defn- delete-str [s i v]
  (str (subs s 0 i) (subs s (+ i v))))

(defn apply-text-edit
  "Given an operation, a text and tokens, shift :token/begin and :token/end on a list
  of tokens as appropriate. Operations are maps, with :type of either :delete or :insert,
  :index indicating the position in the string, and :value for the value being inserted
  or the number of tokens to be deleted.

  Op examples:

    {:type :insert    {:type :delete
     :index 3          :index 4
     :value \"is \"}   :value 3}

  Returns a map:
   - :text contains the new text map
   - :tokens contains the modified tokens that still exist
   - :deleted contains the ids of tokens that were deleted because they had zero width

  Example return map:

    {:text {:text/body \"good dog\", ...}
     :tokens ({:token/begin 0, :token/end 4, ...}, {:token/begin 5, :token/end 8, ...})
     :deleted ()}
  "
  [{:keys [type index value] :as op} text tokens]
  (if (not (or (and (= type :insert) (int? index) (string? value))
               (and (= type :delete) (int? index) (int? value))))
    (do
      (log/error "Malformed op:" op)
      tokens)
    (case type
      ;; three cases:
      ;; - token opens and closes before index (no changes)
      ;; - token opens before index but closes later (expand the token)
      ;; - token opens and closes after index (add offset to both indices)
      :insert
      (let [offset (count value)
            unaffected-tokens (filterv #(<= (:token/end %) index) tokens)
            affected-tokens (filterv #(> (:token/end %) index) tokens)]
        {:text    (update text :text/body insert-str index value)
         :tokens  (into unaffected-tokens
                        (map (fn [{:token/keys [begin end] :as token}]
                               (if (and (> index begin) (< index end))
                                 (-> token
                                     (update :token/end #(+ % offset)))
                                 (-> token
                                     (update :token/begin #(+ % offset))
                                     (update :token/end #(+ % offset)))))
                             affected-tokens))
         :deleted []})

      :delete
      (let [end-index (+ index value)
            unaffected? #(and (< (:token/begin %) index)
                              (<= (:token/end %) index))
            contained? (fn [token]
                         (and (>= (:token/begin token) index)
                              (<= (:token/end token) end-index)))
            ;; token opens and closes within deletion range--delete it
            deleted-tokens (filterv contained? tokens)
            ;; token opens and closes before index (no changes)
            unaffected-tokens (filterv unaffected? tokens)
            affected-tokens (filterv #(not (or (contained? %) (unaffected? %))) tokens)]
        {:text    (update text :text/body delete-str index value)
         :tokens  (into unaffected-tokens
                        (mapv (fn [{:token/keys [begin end] :as token}]
                                (cond
                                  ;; token opens and closes after deletion range--token is same but indices shrink
                                  (and (>= begin end-index)
                                       (>= end end-index))
                                  (-> token
                                      (update :token/begin #(- % value))
                                      (update :token/end #(- % value)))

                                  ;; token opens before index and closes within deletion range--shrink the token
                                  (and (< begin index)
                                       (<= end end-index))
                                  (-> token
                                      (assoc :token/end index))

                                  ;; token opens within deletion range and closes outside--set token/begin to index and shrink
                                  (and (>= begin index)
                                       (> end end-index))
                                  (-> token
                                      (assoc :token/begin index)
                                      (update :token/end #(- % (- end-index (min begin index)))))

                                  ;; deletion range is contained inside token
                                  :else
                                  (-> token
                                      (update :token/end #(- % value)))
                                  ))
                              affected-tokens))
         :deleted (mapv :token/id deleted-tokens)}))))

(defn apply-text-edits [ops text tokens]
  (loop [accum {:deleted [] :text text :tokens tokens}
         op (first ops)
         ops (rest ops)]
    (if (nil? op)
      accum
      (let [result (apply-text-edit op (:text accum) (:tokens accum))
            new-accum (-> accum
                          (assoc :text (:text result))
                          (assoc :tokens (:tokens result))
                          (update :deleted into (:deleted result)))]
        (recur new-accum (first ops) (rest ops))))))
