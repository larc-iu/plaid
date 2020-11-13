(ns glam.client.ui.login
  (:require [goog.object :as g]
            [goog.events :as events :refer [EventType]]
            [com.fulcrologic.fulcro.components :as comp :refer [defsc]]
            [com.fulcrologic.fulcro.ui-state-machines :as sm]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.mutations :as m]
            [com.fulcrologic.fulcro.dom.events :as evt]
            [com.fulcrologic.fulcro.dom.html-entities :as ent]
            [taoensso.timbre :as log]
            [glam.models.session :as session :refer [session-join get-session]]
            [glam.models.user :refer [valid-email valid-password]]
            [glam.client.router :as r]
            [glam.client.ui.common.forms :as forms]
            [glam.client.ui.material-ui :as mui]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]))

(defn toggle-modal! [this] (sm/trigger! this ::session/session :event/toggle-modal))
(defn close-modal! [this] (sm/trigger! this ::session/session :event/close-modal))

(defn form-valid [form field]
  (let [v (get form field)]
    (case field
      :user/email (valid-email v)
      :password (valid-password v))))

(def validator (fs/make-validator form-valid))

(defn ui-login-form
  [this {:keys [loading? error email password form-valid?]}]
  (dom/div
    (dom/form
      {:onSubmit (fn [e]
                   (.preventDefault e)
                   (when form-valid?
                     (sm/trigger! this ::session/session :event/login {:username email :password password})))}
      (mui/grid {:container true :direction "column" :spacing 1}
        (mui/grid {:item true} (mui/typography {:variant "h5"} "Login"))
        (mui/grid {:item true}
          (forms/text-input-with-label this :user/email "Email" "Must be a valid email"
            {:autoFocus true
             :type      "email"
             :fullWidth true
             :disabled  loading?
             :onChange  #(m/set-string!! this :user/email :event %)}))
        (mui/grid {:item true}
          (forms/text-input-with-label this :password "Password" "Password invalid"
            {:type      "password"
             :fullWidth true
             :disabled  loading?
             :onChange  #(comp/set-state! this {:password (evt/target-value %)})}))
        (when-not (empty? error)
          (mui/grid {:item true}
            (mui/alert {:severity "error"}
              error)))
        (mui/grid {:item true}
          (mui/button {:type     "submit"
                       :disabled (not form-valid?)
                       :variant  "contained"}
            "Log in"))))))

(defn logout-button
  [this session?]
  (when session?
    (mui/button
      {:onClick #(sm/trigger! this ::session/session :event/logout)
       :color   "inherit"}
      "Log out")))

(defsc Login [this {:user/keys [email]
                    :ui/keys   [error] :as props}]
  {:query              [:ui/open? :ui/error :user/email
                        session-join
                        [::sm/asm-id ::session/session]]
   :initial-state      {:user/email "" :ui/error ""}
   :ident              (fn [] [:component/id :login])
   :validator          validator
   :componentDidUpdate (fn [this pprops _]
                         ;; clear password input field after logging in.
                         (let [{curr-session-valid? :session/valid?} (get (comp/props this) [:component/id :session])
                               {prev-session-valid? :session/valid?} (get pprops [:component/id :session])]
                           (when (and curr-session-valid? (not prev-session-valid?))
                             (comp/set-state! this {:password ""}))))}
  (let [current-state (sm/get-active-state this ::session/session)
        session (get-session props)
        {session-valid? :session/valid?} session
        loading? (= :state/checking-session current-state)
        password (or (comp/get-state this :password) "")    ; c.l. state for security
        form-valid? (and (valid-email email) (valid-password password))]
    (when-not session-valid?
      (ui-login-form this {:error       error
                           :email       email
                           :password    password
                           :form-valid? form-valid?
                           :loading?    loading?}))))

(def ui-login (comp/factory Login))
