(ns glam.models.session
  (:require
    [com.fulcrologic.fulcro.components :as comp :refer [defsc]]
    [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
    [com.fulcrologic.fulcro.routing.dynamic-routing :as dr]
    [com.fulcrologic.fulcro.ui-state-machines :as sm]
    [com.fulcrologic.guardrails.core :refer [>defn => | ?]]
    [glam.client.application :refer [SPA]]
    [glam.client.router :as r]
    [glam.models.user-common :refer [valid-email valid-password]]
    [taoensso.timbre :as log]
    [com.fulcrologic.fulcro.algorithms.form-state :as fs]
    [com.fulcrologic.fulcro.algorithms.denormalize :as fdn]
    [com.fulcrologic.fulcro.data-fetch :as df]))

(def session-ident [:component/id :session])

;; query-only defsc for normalization
(defsc Session
  [_ {:keys [:session/valid? :user/email :user/id :session/server-error-msg :user/admin?]}]
  {:query         [:session/valid? :user/admin? :session/server-error-msg :user/email :user/id :ui/loading?]
   :ident         (fn [] session-ident)
   :pre-merge     (fn [{:keys [data-tree]}]
                    (merge
                      {:session/valid?           false
                       :user/admin?              false
                       :user/email               ""
                       :user/id                  nil
                       :session/server-error-msg nil}
                      data-tree))
   :initial-state {:session/valid? false :user/admin? false :user/email "" :user/id nil :session/server-error-msg nil}})

(def session-join {session-ident (comp/get-query Session)})

(defn get-session [props] (get props session-ident))

(defn valid-session? [props] (:session/valid? (get props session-ident)))

(defn admin? [props] (:user/admin? (get props session-ident)))

(defn clear [env]
  (sm/assoc-aliased env :error ""))

(defn logout [env]
  (log/info "logout env: " env)
  (let [env
        (-> env
            (clear)
            (sm/assoc-aliased :username "" :session-valid? false :current-user "")
            (sm/trigger-remote-mutation :actor/login-form `logout {})
            (sm/activate :state/logged-out))]
    (r/route-to! :home)
    env))

(defn login [{::sm/keys [event-data] :as env}]
  (-> env
      (clear)
      (sm/trigger-remote-mutation :actor/login-form 'glam.models.session/login
                                  {:username        (:username event-data)
                                   :password        (:password event-data)
                                   ::m/returning    (sm/actor-class env :actor/current-session)
                                   ::sm/ok-event    :event/complete
                                   ::sm/error-event :event/failed})
      (sm/activate :state/checking-session)))

(defn process-session-result
  "Called on app boot and to validate logging in. See if we have a session from the backend."
  [env error-message chroute?]
  (let [success? (sm/alias-value env :session-valid?)]
    (log/info "PROCESS SESSION RESULT , CHROUTE? " chroute? ", SUCCESS? " success?)
    (cond
      (and chroute? success?)
      (r/route-to! :projects)
      (not success?)
      (r/route-to! :home))
    (cond-> (clear env)
            success? (->
                       (sm/assoc-aliased :modal-open? false)
                       (sm/activate :state/logged-in))
            (not success?) (->
                             (sm/assoc-aliased :error error-message)
                             (sm/activate :state/logged-out)))))

(defn initial-load [env]
  (sm/load env
           ::current-session
           :actor/current-session

           {::sm/ok-event    :event/complete
            ::sm/error-event :event/failed}))

(def global-events
  {:event/close-modal  {::sm/handler (fn [env] (sm/assoc-aliased env :modal-open? false))}
   :event/toggle-modal {::sm/handler (fn [env] (sm/update-aliased env :modal-open? not))}})

(defn get-server-mutation-err
  [result-or-env]
  (let [result (or (some-> result-or-env ::sm/event-data ::sm/mutation-result) result-or-env)
        body (:body result)
        mutation-sym (-> body keys first)]
    (let [error (-> body mutation-sym :server/message)]
      (if (nil? error)
        "There was an error sending your request."
        error))))

;; todo adapt this to load all app start data - including session
(sm/defstatemachine session-machine
  {::sm/actors
   #{:actor/login-form :actor/current-session}

   ::sm/aliases
   {:username       [:actor/login-form :user/email]
    :error          [:actor/login-form :ui/error]
    :modal-open?    [:actor/login-form :ui/open?]
    :session-valid? [:actor/current-session :session/valid?]
    :current-user   [:actor/current-session :user/email]}

   ::sm/states
   {:initial
    {::sm/target-states #{:state/logged-in :state/logged-out}
     ::sm/events        {::sm/started    {::sm/handler #(-> % (sm/assoc-aliased :error "") initial-load)}
                         :event/failed   {::sm/target-state :state/logged-out}

                         :event/complete {::sm/target-states #{:state/logged-in :state/logged-out}
                                          ;; handles the first session request on app boot
                                          ::sm/handler       #(process-session-result % "" false)}}}

    :state/checking-session
    {::sm/events (merge global-events
                        {:event/failed   {::sm/target-states #{:state/logged-out}
                                          ::sm/handler       (fn [env]
                                                               (-> env
                                                                   (clear)
                                                                   (sm/activate :state/logged-out)
                                                                   (sm/assoc-aliased :error (get-server-mutation-err env))))}
                         :event/complete {::sm/target-states #{:state/logged-out :state/logged-in}
                                          ::sm/handler       #(process-session-result % "Invalid Credentials." true)}})}

    :state/logged-in
    {::sm/events (merge global-events
                        {:event/logout {::sm/target-states #{:state/logged-out}
                                        ::sm/handler       logout}})}

    :state/logged-out
    {::sm/events (merge global-events
                        {:event/signup-success {::sm/target-state :state/logged-in}
                         :event/login          {::sm/target-states #{:state/checking-session}
                                                ::sm/handler       login}})}}})

;; signup
(def signup-ident [:component/id :signup])

(defmutation signup [_]
  (action [{:keys [state]}]
          (log/info "Starting signup mutation")
          (swap! state
                 (fn [s]
                   (-> s
                       (fs/mark-complete* signup-ident)
                       (assoc-in [df/marker-table ::signup] {:status :loading})))))

  (ok-action [{:keys [app state result]}]
             (let [state @state
                   session (fdn/db->tree (comp/get-query Session) session-ident state)]
               (log/info "Signup success result: " result)
               (df/remove-load-marker! app ::signup)
               (when (:session/valid? session)
                 (r/route-to! :projects)
                 (sm/trigger! app ::session :event/signup-success))))

  (error-action [{:keys [app]}]
                (df/remove-load-marker! app ::signup))

  (remote [{:keys [state] :as env}]
          (let [{:account/keys [email password password-again]} (get-in @state signup-ident)]
            (let [valid? (boolean (and (valid-email email) (valid-password password)
                                       (= password password-again)))]
              (when valid?
                (-> env (m/returning Session)))))))
