export { createIdrServerMiddleware, type IdrMiddlewareArgs } from "./middleware.js";
export { buildEntrance, type BuildResult } from "./build.js";
export { selectClientIp } from "./trust.js";
export { isEligible, type EligibilityRules, type EligibilityResult, type IneligibleReason, type PathPattern } from "./eligibility.js";
export { classifyAcquisition, normalisePageKey, compileRouteTemplates, generateEntranceId, type AcquisitionInput, type PageKeyMapper } from "./payload.js";
export { parsePublicIp, type ParsedIp } from "./ip.js";
export { checkConnectivity, type ConnectivityResult } from "./connectivity.js";
export { resolveConfig, type IdrOptions, type DeliveryResult } from "./config.js";
export { ACQUISITION_VALUES, ELIGIBILITY_RULE_SET_ID, ENTRANCE_CONTRACT, type Acquisition, type EntrancePayload, type IpRejectReason, type IpSelection, type TrustPolicy } from "./types.js";
