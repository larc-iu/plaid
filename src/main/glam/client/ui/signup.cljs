(ns glam.client.ui.signup
  (:require
    [clojure.pprint :refer [pprint]]
    [com.fulcrologic.fulcro.algorithms.denormalize :as fdn]
    [com.fulcrologic.fulcro.algorithms.form-state :as fs]
    [com.fulcrologic.fulcro.components :as comp :refer [defsc]]
    [com.fulcrologic.fulcro.components :as c]
    [com.fulcrologic.fulcro.data-fetch :as df]
    [com.fulcrologic.fulcro.dom :as dom]
    [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
    [com.fulcrologic.fulcro.ui-state-machines :as uism]
    [com.fulcrologic.guardrails.core :refer [>defn => | ?]]
    [glam.models.session :as session]
    [glam.client.router :as r]
    [glam.models.user-common :refer [valid-email valid-password]]
    [glam.models.session :refer [session-join Session get-session signup-ident signup]]
    [sablono.util :as su]
    [taoensso.timbre :as log]
    [glam.client.ui.material-ui :as mui]
    [glam.client.ui.common :as common]))

(declare Signup)

(defn clear-signup-form*
  "Mutation helper: Updates state map with a cleared signup form that is configured for form state support."
  [state-map]
  (log/info "Clearing signup form")
  (-> state-map
      (assoc-in signup-ident
                {:account/email          ""
                 :account/password       ""
                 :account/password-again ""})
      (fs/add-form-config* Signup signup-ident)))

(defmutation clear-signup-form [_]
  (action [{:keys [state]}]
    (swap! state clear-signup-form*)))

(defmutation mark-complete!* [{field :field}]
  (action [{:keys [state]}]
    (swap! state fs/mark-complete* signup-ident field)))

(defn mark-complete!
  [this field]
  (comp/transact!! this [(mark-complete!* {:field field})]))

(defn form-valid [form field]
  (let [v (get form field)]
    (case field
      :account/email (valid-email v)
      :account/password (valid-password v)
      :account/password-again (= v (get form :account/password)))))

(def validator (fs/make-validator form-valid))

(defsc Signup [this {:account/keys [email password password-again] :as props}]
  {:query             [:account/email :account/password :account/password-again fs/form-config-join session-join
                       [df/marker-table ::signup]]
   :initial-state     (fn [_]
                        (fs/add-form-config Signup
                                            {:account/email          ""
                                             :account/password       ""
                                             :account/password-again ""}))
   :form-fields       #{:account/email :account/password :account/password-again}
   :ident             (fn [] signup-ident)
   :componentDidMount (fn [this] (comp/transact! this [(clear-signup-form {})]))}
  (let [server-err (:session/server-error-msg (get-session props))
        form-valid? (= :valid (validator props))
        checked? (fs/checked? props)
        mark-complete! (partial mark-complete! this)
        saving? (df/loading? (get props [df/marker-table ::signup]))]
    (dom/div
      (dom/form
        {:onSubmit
         (fn [e]
           (.preventDefault e)
           (log/info (pr-str (validator props)))
           (when form-valid?
             (js/console.log "submitting!")
             (comp/transact! this [(signup {:password password :email email})])))}
        (mui/grid {:container true :direction "column" :spacing 1}
          (mui/grid {:item true} (mui/typography {:variant "h5"} "Signup"))
          (mui/grid {:item true}
            (common/text-input-with-label this :account/email "Email" validator "Must be a valid email"
              {:type      "email"
               :fullWidth true
               :value     email
               :disabled  saving?
               :onBlur    #(mark-complete! :account/email)
               :onChange  #(m/set-string!! this :account/email :event %)}))
          (mui/grid {:item true}
            (common/text-input-with-label this :account/password "Password" validator "Password must be 8 characters or longer"
              {:type      "password"
               :fullWidth true
               :value     password
               :disabled  saving?
               :onBlur    #(mark-complete! :account/password)
               :onChange  #(m/set-string!! this :account/password :event %)}))
          (mui/grid {:item true}
            (common/text-input-with-label this :account/password-again "Password (repeat)" validator "Passwords must match"
              {:type      "password"
               :fullWidth true
               :value     password-again
               :disabled  saving?
               :onBlur    #(mark-complete! :account/password-again)
               :onChange  (fn [e]
                            (m/set-string!! this :account/password-again :event e)
                            ;; also mark complete when it's valid since this is the last in the form
                            (mark-complete! :account/password-again)
                            )}))
          (when-not (empty? server-err)
            (mui/grid {:item true}
              (mui/alert {:severity "error"} server-err)))
          (mui/grid {:item true}
            (mui/button {:type     "submit"
                         :disabled (or (not form-valid?) saving?)
                         :variant  "contained"}
              "Register")))))))

(def ui-signup (c/factory Signup))
