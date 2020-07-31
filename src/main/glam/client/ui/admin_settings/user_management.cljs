(ns glam.client.ui.admin-settings.user-management
  (:require [com.fulcrologic.fulcro.components :as c :refer [defsc]]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.algorithms.denormalize :as fdn]
            [com.fulcrologic.fulcro.dom :as dom]
            [com.fulcrologic.fulcro.data-fetch :as df]
            [taoensso.timbre :as log]
            [glam.client.router :as r]
            [glam.client.application :refer [SPA]]
            [glam.models.session :as sn]
            [glam.client.ui.material-ui :as mui]
            [glam.client.ui.material-ui-icon :as muic]
            [glam.client.ui.common :as uic]))

(def ident [:component/id :user-management])

(defsc UserAccordion [this {:user/keys [id name email admin? reader writer]} {:keys [expanded-id expand]}]
  {:query         [:user/id :user/name :user/email :user/admin? :user/reader :user/writer
                   fs/form-config-join]
   :ident         :user/id
   :initial-state (fn [_] (fs/add-form-config UserAccordion {}))
   :form-fields   #{:user/name :user/email :user/admin? :user/reader :user/writer}}
  (mui/accordion {:expanded        (= expanded-id id)
                  :onChange        (fn [_]
                                     (if (= expanded-id id)
                                       (expand nil)
                                       (df/load! this [:user/id id] UserAccordion
                                                 {:post-action #(expand id)})))
                  :TransitionProps {:unmountOnExit true}}
    (mui/accordion-summary {:expandIcon (muic/expand-more)}
      (c/fragment
        (mui/typography {} (str name))
        (mui/typography {:color "textSecondary"} (str email))))

    (mui/accordion-details {}
      (dom/form
        (mui/vertical-grid
          "foo"
          )))
    )
  )

(def ui-user-accordion (c/factory UserAccordion {:keyfn :user/id}))

(defsc UserManagement [this {:keys [users expanded-id] :as props}]
  {:ident         (fn [_] ident)
   :query         [{:users (c/get-query UserAccordion)}
                   :expanded-id]
   :initial-state (fn [_]
                    {:users       (c/get-initial-state UserAccordion)
                     :expanded-id {}})
   :load-fn       #(df/load! SPA :all-users UserAccordion {:target (conj ident :users)})}
  (mui/container {}
    (c/fragment
      (for [user (sort-by (fn [u] [(if (:user/admin? u) 0 1) (:user/name u)]) users)]
        (do
          (log/info (pr-str user))
          (ui-user-accordion (c/computed user {:expanded-id expanded-id
                                               :expand      #(m/set-value! this :expanded-id %)})))))))

(def ui-user-management (c/factory UserManagement))