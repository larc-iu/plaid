/**
 * The messages bundle: the project event stream, broadcast messages and the
 * service calls it delegates to services.js and sse.js, a factory of the
 * client (client.js installs it).
 */

import { attachServiceRequest, cancelServiceRequest, discardService, discoverServices, releaseService, requestService, serve } from "./services.js";
import { createSSEConnection } from "./sse.js";

/**
 * @typedef {import("./types.js").TextEditOp} TextEditOp
 * @typedef {import("./types.js").TextGap} TextGap
 * @typedef {import("./types.js").MetadataOp} MetadataOp
 * @typedef {import("./types.js").LayerConstraint} LayerConstraint
 * @typedef {import("./types.js").ConstraintWriteOptions} ConstraintWriteOptions
 * @typedef {import("./types.js").ConstraintViolation} ConstraintViolation
 * @typedef {import("./types.js").Requester} Requester
 * @typedef {import("./types.js").BatchRef} BatchRef
 * @typedef {import("./types.js").ServiceParam} ServiceParam
 * @typedef {import("./types.js").ServiceInfo} ServiceInfo
 * @typedef {import("./types.js").DiscoveredService} DiscoveredService
 * @typedef {import("./types.js").ResponseHelper} ResponseHelper
 * @typedef {import("./types.js").ServiceRegistration} ServiceRegistration
 * @typedef {import("./types.js").ServiceStatusEvent} ServiceStatusEvent
 * @typedef {import("./types.js").OperationGroupsBundle} OperationGroupsBundle
 * @typedef {import("./types.js").PlaidClientOptions} PlaidClientOptions
 * @typedef {import("./types.js").OperationKind} OperationKind
 * @typedef {import("./types.js").KeySeed} KeySeed
 * @typedef {import("./types.js").PlaidBatch} PlaidBatch
 * @typedef {import("./types.js").AuditPageOptions} AuditPageOptions
 * @typedef {import("./types.js").VocabItemRestoreSummary} VocabItemRestoreSummary
 * @typedef {import("./types.js").UserDataEntry} UserDataEntry
 * @typedef {import("./types.js").AdminUserDataEntry} AdminUserDataEntry
 * @typedef {import("./types.js").ActivityTallyRow} ActivityTallyRow
 * @typedef {import("./types.js").ConstraintRepair} ConstraintRepair
 * @typedef {import("./types.js").ValueSetRule} ValueSetRule
 * @typedef {import("./types.js").RefusedValues} RefusedValues
 * @typedef {import("./types.js").CommentableType} CommentableType
 * @typedef {import("./types.js").Comment} Comment
 * @typedef {import("./types.js").Guideline} Guideline
 * @typedef {import("./types.js").ClientEventType} ClientEventType
 * @typedef {import("./types.js").ClientEvent} ClientEvent
 * @typedef {import("./types.js").Invite} Invite
 * @typedef {import("./types.js").ServerLimits} ServerLimits
 * @typedef {import("./types.js").ServerHealth} ServerHealth
 * @typedef {import("./types.js").RateLimitBucket} RateLimitBucket
 * @typedef {import("./types.js").RateLimitSnapshot} RateLimitSnapshot
 * @typedef {import("./types.js").BackupStatus} BackupStatus
 * @typedef {import("./types.js").ServerReport} ServerReport
 * @typedef {import("./types.js").LiveLog} LiveLog
 * @typedef {import("./types.js").SSEConnection} SSEConnection
 * @typedef {import("./types.js").SSEStats} SSEStats
 * @typedef {import("./types.js").AtomicValue} AtomicValue
 * @typedef {import("./types.js").Created} Created
 * @typedef {import("./types.js").Project} Project
 * @typedef {import("./types.js").ProjectTextLayer} ProjectTextLayer
 * @typedef {import("./types.js").ProjectTokenLayer} ProjectTokenLayer
 * @typedef {import("./types.js").ProjectSpanLayer} ProjectSpanLayer
 * @typedef {import("./types.js").ProjectRelationLayer} ProjectRelationLayer
 * @typedef {import("./types.js").ProjectVocab} ProjectVocab
 * @typedef {import("./types.js").PlaidDocument} PlaidDocument
 * @typedef {import("./types.js").DocumentTextLayer} DocumentTextLayer
 * @typedef {import("./types.js").DocumentTokenLayer} DocumentTokenLayer
 * @typedef {import("./types.js").DocumentSpanLayer} DocumentSpanLayer
 * @typedef {import("./types.js").PlaidText} PlaidText
 * @typedef {import("./types.js").TextReshape} TextReshape
 * @typedef {import("./types.js").Token} Token
 * @typedef {import("./types.js").Span} Span
 * @typedef {import("./types.js").Relation} Relation
 * @typedef {import("./types.js").VocabItem} VocabItem
 * @typedef {import("./types.js").VocabLink} VocabLink
 * @typedef {import("./types.js").VocabLayer} VocabLayer
 * @typedef {import("./types.js").TextLayer} TextLayer
 * @typedef {import("./types.js").TokenLayer} TokenLayer
 * @typedef {import("./types.js").SpanLayer} SpanLayer
 * @typedef {import("./types.js").RelationLayer} RelationLayer
 * @typedef {import("./types.js").MetadataRecords} MetadataRecords
 * @typedef {import("./types.js").LayerRecords} LayerRecords
 * @typedef {import("./types.js").User} User
 * @typedef {import("./types.js").ProjectListEntry} ProjectListEntry
 * @typedef {import("./types.js").DocumentListEntry} DocumentListEntry
 * @typedef {import("./types.js").ApiToken} ApiToken
 * @typedef {import("./types.js").AuditUser} AuditUser
 * @typedef {import("./types.js").AuditTarget} AuditTarget
 * @typedef {import("./types.js").AuditOp} AuditOp
 * @typedef {import("./types.js").AuditEntry} AuditEntry
 * @typedef {import("./types.js").LockGrant} LockGrant
 * @typedef {import("./types.js").DocumentRestoreSummary} DocumentRestoreSummary
 * @typedef {import("./types.js").RestoreCounts} RestoreCounts
 * @typedef {import("./types.js").OperationGroup} OperationGroup
 * @typedef {import("./types.js").QueryResult} QueryResult
 */

/**
 * @template [T=any]
 * @typedef {import("./types.js").Page<T>} Page
 */

/** @param {import("./client.js").PlaidClient} client */
export function messagesApi(client) {
  return {
    /**
     * Open a Server-Sent Events stream for a project.
     * @param {string} projectId - The UUID of the project to listen to
     * @param {(eventType: string, data: any) => void | boolean} onEvent - Callback function that receives (eventType, data). If it returns true, listening will stop.
     * @param {string} [path] - Stream path under baseUrl (defaults to the project /listen bus; service channels pass their own).
     * @returns {SSEConnection} SSE connection object with .close() and .getStats() methods
     */
    listen: (projectId, onEvent, path) =>
      createSSEConnection(client, projectId, onEvent, path),

    /**
     * Send a message to project listeners.
     *
     * `data` may be any JSON value and is sent VERBATIM (`rawBody`): a
     * message payload is opaque application data, like `metadata` and
     * `config`, so its keys must not be re-cased on the way out. Without
     * this a key such as `case-marker` would reach listeners as
     * `caseMarker` in JS and `case_marker` in Python. `listen` restores it
     * verbatim on the way in.
     *
     * A message is not saved and writes nothing to History, so it never
     * joins an open operation (`withOperation`). Made on a batch it still
     * queues, so a message queued after the writes goes out after them.
     * @param {string} projectId - The UUID of the project to send to
     * @param {any} data - The message data to send
     * @returns {Promise<{success: boolean, message: string}>}
     */
    sendMessage: (projectId, data) =>
      client._request("POST", `/api/v1/projects/${projectId}/message`, {
        noOperation: true,
        rawBody: { body: data },
      }),

    /**
     * Discover the services seen on a project (synchronous GET). Currently
     * connected services carry `online: true`; previously-seen offline ones
     * carry `online: false` plus a `lastSeenAt` stamp.
     * @param {string} projectId - The UUID of the project to query
     * @returns {Promise<DiscoveredService[]>} Array of discovered service information
     */
    discoverServices: (projectId) => discoverServices(client, projectId),

    /**
     * Forget a previously-seen (offline) service. Maintainer-only; 409 if
     * the service is currently connected.
     * @param {string} projectId - The UUID of the project
     * @param {string} serviceId - The ID of the service to forget
     * @returns {Promise<void>}
     */
    discardService: (projectId, serviceId) =>
      discardService(client, projectId, serviceId),

    /**
     * Release a service id from the account that first registered it on
     * the project, so the next account to register it claims it.
     * Admin-only; 409 while the service is connected, 404 when no account
     * holds it.
     * @param {string} projectId - The UUID of the project
     * @param {string} serviceId - The ID of the service to release
     * @returns {Promise<void>}
     */
    releaseService: (projectId, serviceId) =>
      releaseService(client, projectId, serviceId),

    /**
     * Register as a service and handle incoming work requests.
     *
     * The registration reopens its channel whenever it drops, so a server
     * restart needs no service restart.
     * @param {string} projectId - The UUID of the project to serve
     * @param {ServiceInfo} serviceInfo - Service information {serviceId, serviceName, description}
     * @param {(data: any, responseHelper: ResponseHelper) => void} onServiceRequest - Callback (data, responseHelper)
     * @param {Object} [extras] - Optional additional service metadata
     * @param {(event: ServiceStatusEvent, projectId: string, detail?: string) => void} [onStatus] - Optional callback (event, projectId, detail) for
     *   connection transitions: 'registered', 'reconnected', 'disconnected',
     *   and 'stopped' when the server refuses the channel for good, which
     *   ends the registration
     * @returns {ServiceRegistration} Service registration with .stop(), .isRunning(), .isConnected()
     */
    serve: (projectId, serviceInfo, onServiceRequest, extras, onStatus) =>
      serve(client, projectId, serviceInfo, onServiceRequest, extras, onStatus),

    /**
     * Request a service to perform work and await its result.
     *
     * The request outlives this call: after a timeout, an abort, or a
     * dropped connection the service goes on, and `attachServiceRequest`
     * collects the result given the request id, which `opts.onAccepted`
     * receives as soon as the server has taken the request. Pass
     * `opts.requestId` (a UUID you mint) to know the id before submitting;
     * submitting an id that names a request you already made rejoins it
     * instead of starting another.
     * @param {string} projectId - The UUID of the project
     * @param {string} serviceId - The ID of the service to request
     * @param {any} data - The request data
     * @param {number} [timeout=10000] - Timeout in ms
     * @param {function} [onProgress] - Called with each progress payload {percent, message}
     * @param {AbortSignal} [signal] - Abort to stop waiting; rejects with an AbortError
     * @param {{requestId?: string, onAccepted?: (requestId: string) => void, projectIds?: string[], noOperation?: boolean}} [opts] - {requestId, onAccepted, projectIds, noOperation}
     * @returns {Promise<any>} The service's result
     */
    requestService: (
      projectId,
      serviceId,
      data,
      timeout,
      onProgress,
      signal,
      opts,
    ) =>
      requestService(
        client,
        projectId,
        serviceId,
        data,
        timeout,
        onProgress,
        signal,
        opts,
      ),

    /**
     * Rejoin a service request made earlier and await its result: the
     * latest progress is replayed, then the result comes, or at once if the
     * request already finished. Only the user who submitted it (or an
     * admin). Rejects with an error whose `status` is 404 when the request
     * is unknown or expired (a finished request's result is kept for a
     * while, not forever).
     * @param {string} projectId - The UUID of the project
     * @param {string} requestId - The request id
     * @param {number} [timeout=10000] - Timeout in ms
     * @param {function} [onProgress] - Called with each progress payload
     * @param {AbortSignal} [signal] - Abort to stop waiting
     * @returns {Promise<any>} The service's result
     */
    attachServiceRequest: (
      projectId,
      requestId,
      timeout,
      onProgress,
      signal,
    ) =>
      attachServiceRequest(
        client,
        projectId,
        requestId,
        timeout,
        onProgress,
        signal,
      ),

    /**
     * Ask the service to stop a request made earlier. The request still
     * ends with whatever the service then reports, on the stream of whoever
     * is awaiting it. Rejects with 404 if unknown or expired, 409 once
     * finished.
     * @param {string} projectId - The UUID of the project
     * @param {string} requestId - The request id
     * @returns {Promise<void>}
     */
    cancelServiceRequest: (projectId, requestId) =>
      cancelServiceRequest(client, projectId, requestId),
  };
}
