(ns glam.models.token
  (:require [clojure.set :refer [rename-keys]]
            [clojure.spec.alpha :as s]
            [com.fulcrologic.guardrails.core :refer [>defn >def]]
            [com.wsscode.pathom.connect :as pc]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.text :as txt])
            #?(:clj [glam.crux.token :as tok])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])
            #?(:clj [glam.crux.easy :as gce])))

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
                                      (update :token/end #(- % (- (inc end-index) begin))))

                                  :else
                                  (do
                                    (log/error (str "Unhandled case!" token " " op))
                                    token)))
                              affected-tokens))
         :deleted (mapv :token/id deleted-tokens)}))))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-token [{:keys [crux] :as env} {:token/keys [id]}]
     {::pc/input     #{:token/id}
      ::pc/output    [:token/id :token/begin :token/end]
      ::pc/transform (ma/readable-required :token/id)}
     (tok/get crux id)))

#?(:clj
   (pc/defresolver get-token-value [{:keys [crux]} {:token/keys [id]}]
     {::pc/input     #{:token/id}
      ::pc/output    [:token/value]
      ::pc/transform (ma/readable-required :token/id)}
     (let [{:token/keys [begin end text] :as token} (gce/entity crux id)
           {:text/keys [body] :as text} (txt/get crux text)]
       (try
         {:token/value (subs body begin end)}
         (catch StringIndexOutOfBoundsException e
           (log/error (str "Token's indexes were out of bounds! Token: " (pr-str token)
                           "  Text: " (pr-str text)))
           (log/error (str "Exception message: " (.getMessage e))))))))

;; admin --------------------------------------------------------------------------------

#?(:clj
   (def token-resolvers [get-token get-token-value]))