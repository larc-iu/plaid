import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  filterServicesByTask,
  TASKS,
  getParamSchema,
  buildDefaultValues,
  coerceParamValues,
} from '@larc-iu/plaid-client';
import { useAuth } from '../../../contexts/AuthContext.jsx';
import { notifyError } from '../../../utils/feedback.jsx';

const SERVICE_KEY = 'plaid_ud_parse_service';
const PARAMS_PREFIX = 'plaid_ud_parse_params_';

// Drives the "parse" integration point: discover parse-capable services, let the
// user pick one and fill in its declared arguments, then run it. Service choice
// + argument values are persisted in localStorage; both are merged into the
// request payload. The fixed goal here is UD parsing (TASKS.PARSE).
export const useNlpService = (projectId, documentId) => {
  const [availableServices, setAvailableServices] = useState([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState(null); // 'started', 'success', 'error'
  const [selectedServiceId, setSelectedServiceIdState] = useState(null);
  const [paramValues, setParamValues] = useState({});

  const { getClient } = useAuth();

  // Parse-capable services (declared `tasks`; no legacy id-prefix for parse).
  const parseServices = useMemo(
    () => filterServicesByTask(availableServices, TASKS.PARSE),
    [availableServices],
  );
  const selectedService = useMemo(
    () => parseServices.find((s) => s.serviceId === selectedServiceId) || null,
    [parseServices, selectedServiceId],
  );
  const paramSchema = useMemo(() => getParamSchema(selectedService), [selectedService]);
  const paramErrors = useMemo(
    () => coerceParamValues(paramSchema, paramValues).errors,
    [paramSchema, paramValues],
  );

  // Discover available NLP services.
  const discoverServices = useCallback(async () => {
    if (!projectId || isDiscovering) return;

    const client = getClient();
    if (!client) return;

    setIsDiscovering(true);
    try {
      const services = await client.messages.discoverServices(projectId);
      setAvailableServices(services);
    } catch (error) {
      console.error('Failed to discover services:', error);
      setAvailableServices([]);
    } finally {
      setIsDiscovering(false);
    }
  }, [projectId, getClient, isDiscovering]);

  // Pick a selected service when the list changes: keep the current one if still
  // present, else the cached choice, else the first.
  useEffect(() => {
    if (parseServices.length === 0) {
      setSelectedServiceIdState(null);
      return;
    }
    setSelectedServiceIdState((prev) => {
      if (prev && parseServices.some((s) => s.serviceId === prev)) return prev;
      const cached = localStorage.getItem(SERVICE_KEY);
      if (cached && parseServices.some((s) => s.serviceId === cached)) return cached;
      return parseServices[0].serviceId;
    });
  }, [parseServices]);

  const setSelectedService = useCallback((serviceId) => {
    setSelectedServiceIdState(serviceId);
    if (serviceId) localStorage.setItem(SERVICE_KEY, serviceId);
    else localStorage.removeItem(SERVICE_KEY);
  }, []);

  // Seed argument values when the selected service (hence schema) changes:
  // schema defaults overlaid with any cached values for keys still present.
  useEffect(() => {
    if (!selectedServiceId) {
      setParamValues({});
      return;
    }
    const defaults = buildDefaultValues(paramSchema);
    let cached = {};
    try {
      const raw = localStorage.getItem(`${PARAMS_PREFIX}${selectedServiceId}`);
      if (raw) cached = JSON.parse(raw) || {};
    } catch {
      /* ignore malformed cache */
    }
    const merged = { ...defaults };
    for (const k of Object.keys(defaults)) {
      if (cached[k] !== undefined) merged[k] = cached[k];
    }
    setParamValues(merged);
  }, [selectedServiceId, paramSchema]);

  const setParam = useCallback((key, value) => {
    setParamValues((prev) => {
      const next = { ...prev, [key]: value };
      if (selectedServiceId) {
        try {
          localStorage.setItem(`${PARAMS_PREFIX}${selectedServiceId}`, JSON.stringify(next));
        } catch {
          /* ignore quota / serialization errors */
        }
      }
      return next;
    });
  }, [selectedServiceId]);

  // Request document parsing from the selected service with its arguments.
  const requestParse = useCallback(async () => {
    if (!projectId || !documentId || isParsing || !selectedService) return;

    // Block on unmet required service arguments before doing any work.
    const { values, errors } = coerceParamValues(paramSchema, paramValues);
    if (Object.keys(errors).length) {
      notifyError(Object.values(errors)[0], 'Missing required option');
      return;
    }

    const client = getClient();
    if (!client) return;

    try {
      setParseStatus('started');
      setIsParsing(true);

      await client.messages.requestService(
        projectId,
        selectedService.serviceId,
        // User args spread first so the fixed `documentId` always wins.
        { ...values, documentId },
        300000, // parses can be slow (model load + neural pipeline)
      );

      setParseStatus('success');
      setIsParsing(false);
    } catch (error) {
      console.error('Failed to request parse:', error);
      notifyError(error.message || 'Failed to parse document', 'Parse Error');
      setParseStatus('error');
      setIsParsing(false);
    }
  }, [projectId, documentId, isParsing, selectedService, getClient, paramSchema, paramValues]);

  // Clear parse status
  const clearParseStatus = useCallback(() => {
    setParseStatus(null);
  }, []);

  // Discover services when component mounts or projectId changes
  useEffect(() => {
    if (projectId) {
      discoverServices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return {
    // Status
    isDiscovering,
    isParsing,
    parseStatus,

    // Actions
    discoverServices,
    requestParse,
    clearParseStatus,

    // Service selection + arguments
    parseServices,
    selectedServiceId,
    setSelectedService,
    selectedService,
    paramSchema,
    paramValues,
    paramErrors,
    setParam,

    // Computed flags
    canParse: parseServices.length > 0 && !!selectedService && !isParsing
      && Object.keys(paramErrors).length === 0,
    hasServices: parseServices.length > 0,
  };
};
