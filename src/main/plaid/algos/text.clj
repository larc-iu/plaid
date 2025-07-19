(ns plaid.algos.text
  (:require [taoensso.timbre :as log]
            [editscript.core :as e]))

(comment
  (def x1 "hello world " #_"The ice-cream melted")
  (def x2 "hi world " #_"The ice cream meted!")

  ;; editscript format
  [7 [:r " "] 8 [:- 1] 3 [:+ "!"]]

  ;; fast-diff js format
  [0 "The ice"]
  [-1 "-"]
  [1 " "]
  [0 "cream me"]
  [-1 "l"]
  [0 "ted"]
  [1 "!"]

  (e/diff x1 x2 {:str-diff :character :str-change-limit 0.9999999})

  (editscript-diff x1 x2)

  (diff x1 x2)
  (let [ops (diff x1 x2)]
    (prn ops)
    (apply-text-edits ops {:text/body x1} []))

  )

(defn- editscript-diff
  "Use editscript to get a character-level diff and convert it into the same format used
  by the fast-diff javascript library, which `diff` below is expecting. (We originally used
  this library in glam.)"
  [old new]
  (let [[[_ _ ops]] (e/get-edits (e/diff old new {:algo :a-star
                                                  :str-diff :character
                                                  :str-change-limit 0.9999999}))]
    (if (string? ops)
      ;; Total replacement of the original string
      (vector [-1 old]
              [1 new])
      ;; Edit of the existing string
      (loop [head (first ops)
             tail (rest ops)
             ops []
             i 0]
        (cond
          (nil? head)
          ops

          (number? head)
          (recur (first tail)
                 (rest tail)
                 (conj ops [0 (subs old i (+ i head))])
                 (+ i head))

          ;; Replacement
          (= (first head) :r)
          (recur (first tail)
                 (rest tail)
                 (-> ops
                     (conj [-1 (subs old i (+ i (count (second head))))])
                     (conj [1 (second head)]))
                 (+ i (count (second head))))

          ;; Deletion
          (= (first head) :-)
          (recur (first tail)
                 (rest tail)
                 (conj ops [-1 (subs old i (+ i (second head)))])
                 (+ i (second head)))

          ;; Addition
          (= (first head) :+)
          (recur (first tail)
                 (rest tail)
                 (conj ops [1 (second head)])
                 i)

          :else
          (throw (ex-info "Unknown op!" {:op head :code 500})))))))

(defn valid-delete? [{:keys [type index value] :as op}]
  (and (map? op)
       (= :delete type)
       (int? index)
       (int? value)))

(defn valid-insert? [{:keys [type index value] :as op}]
  (and (map? op)
       (= :insert type)
       (int? index)
       (string? value)))

(defn valid-ops? [ops]
  (every? #(or (valid-delete? %)
               (valid-insert? %))
          ops))

(defn delete-op [index value]
  {:type  :delete
   :index index
   :value value})

(defn insert-op [index value]
  {:type  :insert
   :index index
   :value value})

(defn diff
  [old new]
  (let [results (editscript-diff old new)]
    (loop [head (first results)
           tail (rest results)
           ops []
           i 0]
      (let [code (if-not (nil? head) (first head))
            value (if-not (nil? head) (second head))]
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
  (let [type (or (and (keyword? type) type)
                 (and (string? type) (keyword type))
                 type)]
    (if (not (or (and (or (= type :insert)) (int? index) (string? value))
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
          {:text (update text :text/body insert-str index value)
           :tokens (into unaffected-tokens
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
          {:text (update text :text/body delete-str index value)
           :tokens (into unaffected-tokens
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
           :deleted (mapv :token/id deleted-tokens)})))))

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

(defn separate-into-lines
  "Given a sequence of token maps and strings, separate them into lines
  based on the occurrence of the newline character. A token will be split if
  it contains a newline character in the output of this function, even though
  all copies will have the same ID, in order to facilitate display. (Newlines in
  tokens are virtually unheard of, so this shouldn't be a big deal.)
  Also add a :token/line attribute which is the 0-indexed line number of the token."
  [tokens-and-strings {:text/keys [body]}]
  (let [token-text (fn [{:token/keys [begin end] :as token}]
                     (subs body begin end))]
    (loop [accum-lines []
           current-line []
           head (first tokens-and-strings)
           tail (rest tokens-and-strings)]
      (let [line-number (count accum-lines)]
        (cond
          (nil? head)
          (conj accum-lines current-line)

          ;; string with newline
          (and (string? head) (clojure.string/index-of head "\n"))
          (let [newline-index (clojure.string/index-of head "\n")
                current-line (conj current-line (subs head 0 newline-index))]
            (recur (conj accum-lines current-line)
                   []
                   (subs head (inc newline-index))
                   tail))

          ;; token with newline
          (and (map? head) (clojure.string/index-of (token-text head) "\n"))
          (let [newline-index (clojure.string/index-of (token-text head) "\n")
                current-line (conj current-line (-> head
                                                    (assoc :token/end (+ newline-index (:token/begin head)))
                                                    (assoc :token/line line-number)))
                new-head (assoc head :token/begin (+ (:token/begin head) (inc newline-index)))
                new-head-text (token-text new-head)]
            (recur (conj accum-lines current-line)
                   []
                   (if-not (empty? new-head-text) new-head (first tail))
                   (if-not (empty? new-head-text) tail (rest tail))))

          ;; plain token
          (map? head)
          (recur accum-lines
                 (conj current-line (assoc head :token/line line-number))
                 (first tail)
                 (rest tail))

          ;; plain string
          :else
          (recur accum-lines
                 (conj current-line head)
                 (first tail)
                 (rest tail)))))))

(defn add-untokenized-substrings
  "Takes a sequence of tokens, finds which parts of the text aren't covered by the tokens, and inserts
  strings into the token sequence where no token was able to include the text."
  [tokens {:text/keys [body]}]
  (let [tokens (sort-by :token/begin tokens)]
    (loop [extended []
           last-end 0
           {:token/keys [begin end] :as token} (first tokens)
           remaining-tokens (rest tokens)]
      (cond (and (nil? token) (not= last-end (count body)))
            (conj extended (subs body last-end))

            (nil? token)
            extended

            :else
            (let [additions (if (= last-end begin)
                              [token]
                              [(subs body last-end begin) token])]
              (recur (into extended additions)
                     end
                     (first remaining-tokens)
                     (rest remaining-tokens)))))))
