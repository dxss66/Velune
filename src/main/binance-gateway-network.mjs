import { createGatewayRouteLookup } from "./gateway-route-lookup.mjs";
import { createProxyFreeHttpsFetch } from "./proxy-free-https-fetch.mjs";

export function createBinanceGatewayNetworkFetch(config, options = {}) {

  const routes = [];

  const routeLookup = routes.length ? createGatewayRouteLookup({ routes, ...options.routeOptions }) : null;
  return createProxyFreeHttpsFetch({
    allowedOrigins: [config.marketOrigin, config.marketFreeOrigin].filter(Boolean),
    resolutionCandidatesByHostname: {
      [new URL(config.marketOrigin).hostname]: config.marketGatewayResolutionCandidates,
    },
    timeoutMs: config.gatewayRequestTimeoutMs,
    ...options.fetchOptions,
    routeLookup,
  });
}
