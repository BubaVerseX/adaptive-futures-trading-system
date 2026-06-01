"use strict";

const IDEMPOTENT_NO_CHANGE_CODES = new Set([34040]);
const RATE_LIMIT_CODES = new Set([10006]);
const RETRYABLE_CODES = new Set([10000, 10002, 10016]);
const TIMESTAMP_CODES = new Set([10002]);

function classifyBybitResult(payload = {}, httpStatus = 200) {
  const retCode = Number(payload.retCode);
  const retMsg = String(payload.retMsg || "");
  if (retCode === 0) {
    return {
      type: "SUCCESS",
      success: true,
      retryable: false,
      rateLimited: false,
      recoverable: false,
      informational: false,
      countsAsApiError: false,
      retCode,
      retMsg,
    };
  }
  if (IDEMPOTENT_NO_CHANGE_CODES.has(retCode) || /not\s+modified/i.test(retMsg)) {
    return {
      type: "IDEMPOTENT_SUCCESS_OR_NO_CHANGE",
      success: true,
      retryable: false,
      rateLimited: false,
      recoverable: false,
      informational: true,
      countsAsApiError: false,
      retCode,
      retMsg: retMsg || "not modified",
    };
  }
  const rateLimited = httpStatus === 429 || RATE_LIMIT_CODES.has(retCode);
  const retryable = rateLimited || httpStatus >= 500 || RETRYABLE_CODES.has(retCode);
  return {
    type: rateLimited ? "RATE_LIMIT" : retryable ? "TRANSIENT_API_FAILURE" : "API_FAILURE",
    success: false,
    retryable,
    rateLimited,
    recoverable: retryable || TIMESTAMP_CODES.has(retCode),
    timestampOrRecvWindow: TIMESTAMP_CODES.has(retCode),
    informational: false,
    countsAsApiError: true,
    retCode,
    retMsg,
  };
}

function classifyBybitError(error) {
  const message = String(error && error.message ? error.message : error || "");
  const retCode = Number(error && error.retCode);
  if (IDEMPOTENT_NO_CHANGE_CODES.has(retCode) || /34040|not\s+modified/i.test(message)) {
    return {
      type: "IDEMPOTENT_SUCCESS_OR_NO_CHANGE",
      success: true,
      retryable: false,
      rateLimited: false,
      recoverable: false,
      informational: true,
      countsAsApiError: false,
      retCode: Number.isFinite(retCode) ? retCode : 34040,
      retMsg: "not modified",
    };
  }
  const rateLimited = Boolean(error && error.rateLimited);
  const retryable = Boolean(error && error.retryable);
  return {
    type: rateLimited ? "RATE_LIMIT" : retryable ? "TRANSIENT_API_FAILURE" : "API_FAILURE",
    success: false,
    retryable,
    rateLimited,
    recoverable: retryable || rateLimited,
    informational: false,
    countsAsApiError: true,
    retCode: Number.isFinite(retCode) ? retCode : null,
    retMsg: message,
  };
}

module.exports = {
  classifyBybitResult,
  classifyBybitError,
  IDEMPOTENT_NO_CHANGE_CODES,
};
